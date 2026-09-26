import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { encodeDirectwriteRequest, parseDirectwriteMessage, validateDirectwriteReady, validateDirectwriteReceipt,
  type DirectwriteRequest, type DirectwriteReceipt } from './directwriteProtocol';

// One process/one wire request. The service owns admission, deadlines and restart.
export class DirectwriteProcess {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private child: ChildProcessWithoutNullStreams;
  private broken: Error | undefined;
  private handshaken = false;
  private pending?: { request: DirectwriteRequest; resolve: (value: DirectwriteReceipt) => void; reject: (error: Error) => void; received: boolean };

  constructor(command: string, args: string[], readonly generation: number) {
    this.child = spawn(command, [...args, '--serve', String(generation), String(process.pid)], { windowsHide: true, stdio: 'pipe' });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const startup = setTimeout(() => this.fail(new Error('DW_START_TIMEOUT')), 3000);
    let buffer = '', stderrBytes = 0;
    const onFailure = (error: Error) => {
      clearTimeout(startup); readyReject(error); this.pending?.reject(error); this.pending = undefined;
    };
    this.closed = new Promise(resolve => {
      this.child.once('close', () => {
        this.broken ??= new Error('DW_PROCESS_CLOSED');
        onFailure(this.broken); resolve();
      });
    });
    this.child.on('error', error => { this.fail(error); onFailure(error); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stderr.on('error', error => this.fail(error));
    this.child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) this.fail(new Error('DW_STDERR_LIMIT')); });
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.broken) return;
      try {
        // Receipts contain ASCII tokens/codes only. Reject oversized chunks before decoding.
        if (chunk.length > 8192 || chunk.some(byte => byte > 127)) throw new Error('DW_PROTOCOL_INVALID');
        buffer += chunk.toString('ascii');
        if (buffer.length > 8192) throw new Error('DW_STDOUT_LIMIT');
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const message = parseDirectwriteMessage(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1);
          if (!this.handshaken) {
            validateDirectwriteReady(message, generation); this.handshaken = true; clearTimeout(startup); readyResolve();
          } else {
            const pending = this.pending;
            if (!pending || pending.received) throw new Error('DW_UNEXPECTED_RECEIPT');
            const receipt = validateDirectwriteReceipt(message, pending.request); pending.received = true;
            // Drain this turn's frames first: a duplicate cannot resolve success.
            setImmediate(() => {
              if (!this.broken && this.pending === pending) { this.pending = undefined; pending.resolve(receipt); }
            });
          }
        }
      } catch (error) { this.fail(error as Error); }
    });
    // A failure wakes callers immediately, but the service retains its slot until closed.
    this.onFailure = onFailure;
    void this.ready.catch(() => undefined);
  }
  private onFailure: (error: Error) => void;
  private fail(error: Error): void {
    if (!this.broken) { this.broken = error; this.onFailure(error); }
    this.child.kill('SIGKILL');
  }
  render(request: DirectwriteRequest): Promise<DirectwriteReceipt> {
    if (this.broken || !this.handshaken || this.pending) return Promise.reject(this.broken ?? new Error('DW_PROCESS_BUSY'));
    const frame = encodeDirectwriteRequest(request);
    return new Promise((resolve, reject) => {
      this.pending = { request, resolve, reject, received: false };
      this.child.stdin.write(frame, error => { if (error) this.fail(error); });
    });
  }
  stop(reason = 'DW_CANCELLED'): Promise<void> { this.fail(new Error(reason)); return this.closed; }
}
