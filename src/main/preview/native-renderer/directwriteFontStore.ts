import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isApplicationClosing, onApplicationClosing } from '../../app/shutdownCoordinatorRuntime';
import type { FontStagingPort } from './directwriteFontStaging';

const MAX_FILE = 64 * 1024 * 1024, MAX_BYTES = 512 * 1024 * 1024, MAX_FILES = 128;
const MARKER = 'HFM DirectWrite font snapshots 1\n';
const OWNED = /^[a-f0-9]{32}\.(?:part|font)$/;
interface Entry { source: string; generation: number; digest: string; path: string; bytes: number; refs: number; stale: boolean }
export interface FontLease {
  fontPath: string; fontIdentity: string; sourceGeneration: number;
  current(): boolean; release(): Promise<void>;
}
export interface FontAdmission { signal?: AbortSignal; isCurrent(): boolean }
// Owns only immutable preview font copies. Never receives activation locations,
// modifies font sources, or touches the existing PNG cache/database.
export class DirectwriteFontStore {
  private readonly directory: string;
  private entries: Entry[] = [];
  private initialized = false;
  private lock?: Awaited<ReturnType<typeof fs.open>>;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private disposed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly unsubscribe: () => void;
  constructor(private readonly parent: string, private readonly staging: FontStagingPort) {
    this.directory = path.join(parent, 'dw-fonts');
    this.unsubscribe = onApplicationClosing(() => { for (const controller of this.controllers) controller.abort(); });
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action); this.tail = next.catch(() => undefined); return next;
  }
  private async initialize(signal: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.staging.prepare(this.parent, signal); // Native local-drive/reparse validation precedes Node filesystem calls.
    const marker = path.join(this.directory, 'owner');
    const names = await fs.readdir(this.directory);
    for (const name of names) {
      if (!['owner', 'lock'].includes(name) && !OWNED.test(name)) throw new Error('DW_STORE_UNKNOWN_CONTENT');
      const stat = await fs.lstat(path.join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('DW_STORE_UNSAFE_CONTENT');
    }
    if (names.includes('owner')) {
      if ((await fs.stat(marker)).size !== Buffer.byteLength(MARKER) || await fs.readFile(marker, 'utf8') !== MARKER) throw new Error('DW_STORE_UNKNOWN_OWNER');
    } else {
      if (names.length) throw new Error('DW_STORE_UNKNOWN_OWNER');
      await fs.writeFile(marker, MARKER, { flag: 'wx' });
    }
    const lockPath = path.join(this.directory, 'lock');
    if (names.includes('lock')) {
      if ((await fs.stat(lockPath)).size > 32) throw new Error('DW_STORE_LOCK_INVALID');
      const text = await fs.readFile(lockPath, 'utf8');
      if (!/^[1-9][0-9]{0,9}\n$/.test(text)) throw new Error('DW_STORE_LOCK_INVALID');
      let alive = true;
      try { process.kill(Number(text), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('DW_STORE_IN_USE');
      await fs.unlink(lockPath);
    }
    this.lock = await fs.open(lockPath, 'wx');
    try {
      await this.lock.writeFile(`${process.pid}\n`); await this.lock.sync();
      // No previous-process bytes are trusted. Only marked, flat, regular
      // files of this store are recovered; no recursive removal or symlinks.
      for (const name of names) if (OWNED.test(name)) await fs.unlink(path.join(this.directory, name));
      this.initialized = true;
    } catch (error) { await this.lock.close(); this.lock = undefined; await fs.unlink(lockPath); throw error; }
  }
  private async remove(entry: Entry): Promise<boolean> {
    if (entry.refs) return false;
    try { await fs.unlink(entry.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { entry.stale = true; return false; } }
    this.entries.splice(this.entries.indexOf(entry), 1); return true;
  }
  async acquire(rawPath: string, admission: FontAdmission): Promise<FontLease> {
    if (this.disposed || isApplicationClosing()) throw new Error('DW_CLOSING');
    if (this.pending >= 64) throw new Error('DW_STAGE_QUEUE_FULL');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    admission.signal?.addEventListener('abort', cancel, { once: true });
    if (admission.signal?.aborted) cancel();
    this.controllers.add(controller); this.pending++;
    const current = () => !this.disposed && !isApplicationClosing() && !controller.signal.aborted && !admission.signal?.aborted && admission.isCurrent();
    try {
      return await this.serialize(async () => {
        if (!current()) throw new Error('DW_STALE');
        const source = await this.staging.authorize(rawPath, controller.signal);
        if (!current() || !source.current()) throw new Error('DW_STALE');
        await this.initialize(controller.signal);
        for (const entry of [...this.entries]) {
          if (entry.source === source.identity && entry.generation !== source.generation) entry.stale = true;
          if (entry.stale) await this.remove(entry);
        }
        let candidate = this.entries.find(entry => !entry.stale && entry.source === source.identity && entry.generation === source.generation);
        // Reserve a full source-size ceiling BEFORE the child creates any bytes.
        while (this.entries.reduce((sum, entry) => sum + entry.bytes, 0) + MAX_FILE > MAX_BYTES || this.entries.length >= MAX_FILES) {
          const victim = this.entries.find(entry => !entry.refs && entry !== candidate && !entry.stale);
          if (!victim || !await this.remove(victim)) throw new Error('DW_FONT_BUDGET');
        }
        const part = path.join(this.directory, `${randomBytes(16).toString('hex')}.part`);
        let published: string | undefined;
        try {
          const result = await this.staging.copy(source, part, candidate?.digest, controller.signal);
          if (!current() || !source.current()) throw new Error('DW_STALE');
          if (result.reused) {
            if (!candidate || candidate.bytes !== result.bytes) throw new Error('DW_STAGE_RECEIPT_INVALID');
            const stat = await fs.lstat(candidate.path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.bytes) { candidate.stale = true; throw new Error('DW_FONT_COPY_CHANGED'); }
          } else {
            const stat = await fs.lstat(part);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== result.bytes || result.bytes <= 0 || result.bytes > MAX_FILE) throw new Error('DW_STAGE_RECEIPT_INVALID');
            published = part.replace(/\.part$/, '.font');
            await fs.rename(part, published);
            if (!current() || !source.current()) throw new Error('DW_STALE');
            for (const entry of [...this.entries]) if (entry.source === source.identity) { entry.stale = true; await this.remove(entry); }
            candidate = { source: source.identity, generation: source.generation, digest: result.digest, path: published, bytes: result.bytes, refs: 0, stale: false };
            this.entries.push(candidate); published = undefined;
          }
          const entry = candidate!; entry.refs++;
          this.entries.splice(this.entries.indexOf(entry), 1); this.entries.push(entry);
          let released = false;
          return { fontPath: entry.path, fontIdentity: entry.digest, sourceGeneration: source.generation,
            current: () => !released && !entry.stale && current() && source.current(),
            release: () => this.serialize(async () => { if (released) return; released = true; entry.refs--; if (entry.stale || this.disposed) await this.remove(entry); }),
          };
        } finally {
          // copy() retains its Shared I/O slot until the process really closes.
          for (const file of [part, published]) if (file) {
            try { await fs.unlink(file); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.disposed = true; throw new Error('DW_FONT_CLEANUP_FAILED'); } }
          }
        }
      });
    } finally { this.pending--; this.controllers.delete(controller); admission.signal?.removeEventListener('abort', cancel); }
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.unsubscribe(); for (const controller of this.controllers) controller.abort();
    await this.serialize(async () => {
      for (const entry of [...this.entries]) { entry.stale = true; await this.remove(entry); }
      if (this.entries.length) throw new Error('DW_FONT_LEASES_OR_CLEANUP_PENDING');
      if (this.lock) { await this.lock.close(); this.lock = undefined; await fs.unlink(path.join(this.directory, 'lock')); }
    });
  }
}
