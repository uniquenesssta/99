import { createFontPathAuthorizationRuntime, type FontPathAuthorizationRuntimeOptions } from '../../path/fontPathAuthorizationRuntime';
import { applicationSharedIoProcessRuntime, type SharedIoProcessError } from '../../path/sharedIoProcessRuntime';
import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime';
import { ensureStartupPathRootAvailable, getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime';
import { applicationWorkEpoch, isApplicationClosing } from '../../app/shutdownCoordinatorRuntime';

export interface FontSource {
  path: string; identity: string; generation: number; current: () => boolean;
}
export interface FontStageResult { digest: string; bytes: number; reused: boolean }
export interface FontStagingPort {
  prepare(parent: string): Promise<void>;
  authorize(path: string): Promise<FontSource>;
  copy(source: FontSource, target: string, known: string | undefined, signal: AbortSignal): Promise<FontStageResult>;
}
// The existing pool is the only owner of NAS admission, slots and termination.
// Neither authorization nor hashing performs direct NAS I/O in this module.
export function createDirectwriteFontStaging(command: string, authorization: Omit<FontPathAuthorizationRuntimeOptions, 'fileSystem'>): FontStagingPort {
  async function run(args: string[], paths: string[], signal?: AbortSignal, admit?: () => boolean, timeoutMs = 30000): Promise<any> {
    const roots = await sharedIoResourceKeys(paths);
    try {
      const output = await applicationSharedIoProcessRuntime().run({ file: command,
        args: [...args, String(process.pid)], roots: roots.length ? roots : ['dw-local-font-staging'],
        timeoutMs, maxBuffer: 65536, write: false, signal, admit, label: 'dw-font-staging' });
      const result = JSON.parse(output.stdout);
      if (result?.ok !== true || result.version !== 1) throw new Error('DW_STAGE_RECEIPT_INVALID');
      return result;
    } catch (error) {
      // A rejected promise is not proof that the writer has stopped. The store
      // cannot remove .part files or release reserved capacity before close.
      await (error as SharedIoProcessError)?.closed;
      throw error;
    }
  }
  return {
    async prepare(parent) {
      const result = await run(['--prepare-font-store', parent], [parent]);
      if (result.type !== 'font-store' || Object.keys(result).length !== 3) throw new Error('DW_STAGE_RECEIPT_INVALID');
    },
    async authorize(path) {
      const epoch = applicationWorkEpoch();
      if (isApplicationClosing()) throw new Error('DW_CLOSING');
      // All path resolution (including local junctions that secretly reach NAS)
      // stays in the existing killable pool. Reuse the existing authorization
      // rules/root providers with an isolated filesystem port, never a second
      // policy or an unbounded Node realpath/stat of a caller path.
      const inspect = async (target: string) => {
        const info = await run(['--font-path-info', target], [target], undefined, undefined, 500);
        if (info.type !== 'font-path' || Object.keys(info).length !== 6 || typeof info.pathHex !== 'string'
          || !/^(?:[0-9a-f]{4}){1,8192}$/.test(info.pathHex) || !Number.isSafeInteger(info.bytes)
          || info.bytes < 0 || typeof info.directory !== 'boolean') throw new Error('DW_STAGE_RECEIPT_INVALID');
        return { path: Buffer.from(info.pathHex, 'hex').toString('utf16le'), bytes: info.bytes, directory: info.directory };
      };
      const auth = await createFontPathAuthorizationRuntime({ ...authorization, maxFontReadBytes: 64 * 1024 * 1024,
        fileSystem: {
          realpath: async target => (await inspect(target)).path,
          stat: async target => { const info = await inspect(target); return { size: info.bytes, isFile: () => !info.directory, isDirectory: () => info.directory }; },
        },
      }).authorizeFontRead(path);
      if (!auth.ok) throw new Error(`DW_FONT_UNAUTHORIZED_${auth.reason}`);
      const file = auth.value;
      // Indexed files without a watched root use their existing availability
      // resource owner; this does not create another online-state registry.
      if (!await ensureStartupPathRootAvailable(file.rootPath || file.realPath.replace(/[\\/][^\\/]+$/, ''), undefined, 'dw-font-staging')) throw new Error('DW_SOURCE_OFFLINE');
      const snapshot = getStartupPathRootState(file.rootPath || file.realPath.replace(/[\\/][^\\/]+$/, ''));
      const statePath = file.rootPath || file.realPath.replace(/[\\/][^\\/]+$/, '');
      const current = () => {
        const state = getStartupPathRootState(statePath);
        return !isApplicationClosing() && applicationWorkEpoch() === epoch && state.state === 'online'
          && state.rootId === snapshot.rootId && state.generation === snapshot.generation;
      };
      if (!current() || file.size <= 0 || file.size > 64 * 1024 * 1024) throw new Error('DW_SOURCE_UNAVAILABLE');
      return { path: file.realPath, identity: JSON.stringify([snapshot.rootId, file.realComparePath]), generation: snapshot.generation, current };
    },
    async copy(source, target, known, signal) {
      const result = await run(['--stage-font', source.path, source.path, target, known || '-'], [source.path], signal, source.current);
      if (result.type !== 'font-stage' || Object.keys(result).length !== 6 || !/^[0-9a-f]{64}$/.test(result.digest)
        || !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || result.bytes > 64 * 1024 * 1024
        || typeof result.reused !== 'boolean' || (result.reused && result.digest !== known)) throw new Error('DW_STAGE_RECEIPT_INVALID');
      if (signal.aborted || !source.current()) throw new Error('DW_STALE');
      return { digest: result.digest, bytes: result.bytes, reused: result.reused };
    },
  };
}
