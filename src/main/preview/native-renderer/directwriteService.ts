import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isApplicationClosing, onApplicationClosing } from '../../app/shutdownCoordinatorRuntime';
import { DirectwriteProcess } from './directwriteProcess';
import { validateDirectwriteInput, type DirectwriteInput, type DirectwriteReceipt } from './directwriteProtocol';

const MAX_PENDING = 64, MAX_SUBSCRIBERS = 256, MAX_PNG_BYTES = 40 * 1024 * 1024;
export interface DirectwriteServiceOptions {
  command: string;
  args?: string[];
  temporaryRoot: string; // Trusted application-owned local directory, never a font/source directory.
  deadlineMs?: number; // May shorten, never extend the existing 30s render deadline.
}
export interface DirectwriteResult { png: Buffer; receipt: DirectwriteReceipt }
interface Subscriber {
  current: () => boolean;
  settle: (error?: Error, value?: DirectwriteResult) => void;
}
interface Job { key: string; input: DirectwriteInput; subscribers: Set<Subscriber>; completed?: boolean }
let owner: DirectwriteService | undefined;

// Construct once in the preview composition. No child or filesystem work until
// explicitly called; current UI remains on its existing backend until DW-05.
export class DirectwriteService {
  private readonly queue: Job[] = [];
  private readonly jobs = new Map<string, Job>();
  private active?: Job;
  private child?: DirectwriteProcess;
  private requestId = 0;
  private generation = randomBytes(4).readUInt32LE() || 1;
  private subscribers = 0;
  private disposed = false;
  private unavailable?: Error;
  private failures = 0;
  private retryAt = 0;
  private wake?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly unsubscribe: () => void;
  private readonly deadline: number;
  constructor(private readonly options: DirectwriteServiceOptions) {
    this.deadline = options.deadlineMs ?? 30000;
    if (!Number.isFinite(this.deadline) || this.deadline < 1 || this.deadline > 30000
      || !/^[a-z]:\\/i.test(options.temporaryRoot) || options.temporaryRoot.includes('\0')) throw new Error('DW_OPTIONS_INVALID');
    if (owner) throw new Error('DW_OWNER_EXISTS');
    this.options = { ...options, args: options.args?.slice() };
    this.unsubscribe = onApplicationClosing(() => { void this.stop('DW_CLOSING'); });
    owner = this;
  }
  render(input: DirectwriteInput, admission: { signal?: AbortSignal; isCurrent: () => boolean }): Promise<DirectwriteResult> {
    try {
      validateDirectwriteInput(input);
      if (this.disposed || isApplicationClosing()) throw new Error('DW_CLOSING');
      if (this.unavailable) throw this.unavailable;
      if (admission.signal?.aborted || !admission.isCurrent()) throw new Error('DW_STALE');
      this.invalidate();
      const snapshot: DirectwriteInput = { fontPath: input.fontPath, fontIdentity: input.fontIdentity,
        sourceGeneration: input.sourceGeneration, faceIndex: input.faceIndex, text: input.text,
        fontSize: input.fontSize, width: input.width, height: input.height };
      const key = JSON.stringify(snapshot);
      let job = this.jobs.get(key);
      if (this.subscribers >= MAX_SUBSCRIBERS || (!job && this.queue.length >= MAX_PENDING)) throw new Error('DW_QUEUE_FULL');
      if (!job) { job = { key, input: snapshot, subscribers: new Set() }; this.jobs.set(key, job); this.queue.push(job); }
      const target = job;
      const promise = new Promise<DirectwriteResult>((resolve, reject) => {
        let settled = false;
        const cancel = () => {
          subscriber.settle(new Error('DW_CANCELLED')); this.retireEmpty(target); this.pump();
        };
        const timer = setTimeout(() => {
          subscriber.settle(new Error('DW_TIMEOUT')); this.retireEmpty(target); this.pump();
        }, this.deadline);
        const subscriber: Subscriber = {
          current: () => {
            try { return !admission.signal?.aborted && admission.isCurrent(); } catch { return false; }
          },
          settle: (error, value) => {
            if (settled) return;
            settled = true; clearTimeout(timer); admission.signal?.removeEventListener('abort', cancel);
            target.subscribers.delete(subscriber); this.subscribers--;
            if (error) reject(error); else resolve(value!);
          },
        };
        target.subscribers.add(subscriber); this.subscribers++;
        admission.signal?.addEventListener('abort', cancel, { once: true });
      });
      this.pump(); return promise;
    } catch (error) { return Promise.reject(error); }
  }
  // The existing root/request owner calls this when its generation changes.
  invalidate(): void {
    for (const job of this.jobs.values()) {
      for (const subscriber of job.subscribers) if (!subscriber.current()) subscriber.settle(new Error('DW_STALE'));
      this.retireEmpty(job);
    }
  }
  private retireEmpty(job: Job): void {
    if (job.subscribers.size) return;
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    const index = this.queue.indexOf(job); if (index !== -1) this.queue.splice(index, 1);
    if (this.active === job && !job.completed) void this.child?.stop();
  }
  private pump(): void {
    if (this.running || this.stopping || this.disposed || this.unavailable || isApplicationClosing()) return;
    this.invalidate();
    if (!this.queue.length) return;
    if (Date.now() < this.retryAt) {
      if (!this.wake) this.wake = setTimeout(() => { this.wake = undefined; this.pump(); }, this.retryAt - Date.now());
      return;
    }
    const job = this.queue.shift()!; this.active = job;
    this.running = this.execute(job).finally(() => {
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.active = undefined; this.running = undefined; this.pump();
    });
  }
  private async execute(job: Job): Promise<void> {
    let directory: string | undefined;
    try {
      await fs.mkdir(this.options.temporaryRoot, { recursive: true });
      directory = await fs.mkdtemp(path.join(this.options.temporaryRoot, 'dw-'));
      this.invalidate();
      if (!job.subscribers.size) return;
      if (!this.child) {
        this.generation = (this.generation + 1) >>> 0 || 1;
        this.child = new DirectwriteProcess(this.options.command, this.options.args ?? [], this.generation);
      }
      await this.child.ready;
      this.invalidate();
      if (!job.subscribers.size) return;
      if (++this.requestId > 0xffffffff) throw new Error('DW_REQUEST_ID_EXHAUSTED');
      const outputPath = path.join(directory, 'preview.png');
      const receipt = await this.child.render({ ...job.input, requestId: this.requestId, serviceGeneration: this.generation,
        outputIdentity: randomBytes(16).toString('hex'), outputPath });
      if (!receipt.ok) throw new Error(`DW_NATIVE_${receipt.reason}`);
      const handle = await fs.open(outputPath, 'r');
      let png: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 24 || stat.size > MAX_PNG_BYTES) throw new Error('DW_OUTPUT_INVALID');
        png = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < png.length) {
          const { bytesRead } = await handle.read(png, offset, png.length - offset, offset);
          if (!bytesRead) throw new Error('DW_OUTPUT_INVALID'); offset += bytesRead;
        }
        if (!(await handle.stat()).isFile() || (await handle.stat()).size !== png.length) throw new Error('DW_OUTPUT_INVALID');
      } finally { await handle.close(); }
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || png.readUInt32BE(16) !== job.input.width || png.readUInt32BE(20) !== job.input.height) throw new Error('DW_OUTPUT_INVALID');
      this.failures = 0;
      job.completed = true;
      for (const subscriber of job.subscribers) {
        if (this.disposed || isApplicationClosing() || !subscriber.current()) subscriber.settle(new Error('DW_STALE'));
        else subscriber.settle(undefined, { png, receipt });
      }
    } catch (error) {
      for (const subscriber of job.subscribers) subscriber.settle(error as Error);
      if (this.child) { await this.child.stop('DW_REQUEST_FAILED'); this.child = undefined; }
      this.retryAt = Date.now() + Math.min(2000, 100 * 2 ** Math.min(this.failures++, 5));
    } finally {
      // Cancellation may occur during startup or while reading the output.
      // Keep the active slot and output lease until actual child termination.
      if (this.child && !job.completed && !job.subscribers.size && this.jobs.get(job.key) !== job) {
        await this.child.stop(); this.child = undefined;
      }
      if (directory) {
        try { await fs.rm(directory, { recursive: true, force: true }); }
        catch {
          // Never build an unbounded pile of inaccessible outputs. Preserve the
          // owned directory for later recovery and stop this owner's admission.
          this.unavailable = new Error('DW_OUTPUT_CLEANUP_FAILED');
          for (const pending of this.jobs.values()) for (const subscriber of pending.subscribers) subscriber.settle(this.unavailable);
          this.jobs.clear(); this.queue.length = 0;
          if (this.child) { await this.child.stop('DW_OUTPUT_CLEANUP_FAILED'); this.child = undefined; }
        }
      }
    }
  }
  private stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.wake) clearTimeout(this.wake); this.wake = undefined;
    for (const job of this.jobs.values()) for (const subscriber of job.subscribers) subscriber.settle(new Error(reason));
    this.jobs.clear(); this.queue.length = 0;
    const child = this.child;
    const running = this.running;
    this.stopping = (async () => {
      if (child) await child.stop(reason);
      await running;
      if (this.child === child) this.child = undefined;
    })().finally(() => { this.stopping = undefined; this.pump(); });
    return this.stopping;
  }
  async whenCurrentExecutionClosed(): Promise<void> {
    await this.running;
    await this.stopping;
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.unsubscribe(); await this.stop('DW_CLOSING');
    if (owner === this) owner = undefined;
  }
}
