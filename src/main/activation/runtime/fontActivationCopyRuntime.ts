import { SharedIoProcessError, rethrowSharedIoProcessError } from '../../path/sharedIoProcessRuntime';
import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime';
import { validManagedIdentity, retainManagedCopyUntilClosed, createManagedActivationIdentityRuntime } from './managedActivationIdentityRuntime';
import { createHash } from 'node:crypto';
import { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import type { FontItem } from "../../../shared/types";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";
import {
  logNodeBridgeFallbackDisabled,
  logNodeBridgeFallbackUsed,
  nodeBridgeFallbackCompatibilityAllowed,
  nodeBridgeFallbackDeniedMessage,
} from "../../rust-core/nodeBridgeFallbackCompatibilityRuntime";

export type ManagedFontCopyReceipt = { mode: 'copied' | 'reused'; identity: import('../../windows/runtime/fontRuntimeTypes').ManagedActivationFileIdentity };

export function createFontActivationCopyRuntime(deps: FontActivationRuntimeDeps) {
  const { normalizePathForCacheCompare, withGlobalIo, appendStartupLog, runRustFontActivationFiles } = deps;

  async function copyTemporaryActiveFontWithTrace(
    item: FontItem,
    dest: string,
    batchLabel = "single",
  ): Promise<ManagedFontCopyReceipt> {
    const source = normalizePathForCacheCompare(resolve(item.path));
    const target = normalizePathForCacheCompare(resolve(dest));
    if (source === target) throw new Error("临时激活必须使用独立的本机副本。");

    if (runRustFontActivationFiles) {
      const rustResult = await runRustFontActivationFiles({
        copies: [{ id: item.id, source: item.path, dest }],
        allowedDeleteDir: deps.currentUserFontsDir(), allowedNamePrefix: `${deps.appName}_ACTIVE_`,
      }).catch((error) => {
        if (error instanceof SharedIoProcessError && error.closed) retainManagedCopyUntilClosed(dest, error.closed);
        rethrowSharedIoProcessError(error);
        appendStartupLog(`rust activation copy route failed: fontId=${item.id}, ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      const rustRow = rustResult?.copyResults?.find(row => row.id === item.id && row.source === item.path && row.dest === dest);
      if (rustResult && (!rustRow || (rustRow.ok && !validManagedIdentity(rustRow.identity)))) throw new SharedIoProcessError('复制回执的字体或文件身份不匹配。', 'unknown', 'invalid-receipt');
      if (rustRow && !rustRow.ok) throw new Error(rustRow.message || '字体复制失败。');
      if (rustRow?.ok) {
        if (rustRow.mode !== "copied" && rustRow.mode !== "reused") throw new Error("无效的独立副本回执。");
        const mode = rustRow.mode;
        appendStartupLog(`rust activation copy used: fontId=${item.id}, mode=${mode}`);
        return { mode, identity: rustRow.identity! };
      }
    }

    if ((await sharedIoResourceKeys([item.path])).length) throw new SharedIoProcessError('共享字体复制未确认，禁止回退复制。', 'not-started', 'copy-unavailable');
    if (!nodeBridgeFallbackCompatibilityAllowed()) {
      logNodeBridgeFallbackDisabled({
        appendStartupLog,
        source: "activation-copy",
        reason: runRustFontActivationFiles ? "rust-activation-copy-missed" : "rust-activation-copy-unavailable",
        detail: `fontId=${item.id}`,
      });
      throw new Error(nodeBridgeFallbackDeniedMessage("activation-copy"));
    }

    logNodeBridgeFallbackUsed({
      appendStartupLog,
      source: "activation-copy",
      reason: runRustFontActivationFiles ? "rust-activation-copy-missed" : "rust-activation-copy-unavailable",
      detail: `fontId=${item.id}`,
    });

    const identityRuntime = createManagedActivationIdentityRuntime(deps);
    const receipt = async (mode: 'copied' | 'reused', sha1: string): Promise<ManagedFontCopyReceipt> => {
      const identity = await identityRuntime.inspect(dest);
      if (!identity || identity.sha1 !== sha1) throw new Error('发布后的副本身份已变化。');
      return { mode, identity };
    };
    return withGlobalIo(`activate:${batchLabel}:copy-font`, async () => {
      const sourceBytes = await fsp.readFile(item.path);
      const hash = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');
      const sourceHash = hash(sourceBytes);
      const old = await fsp.readFile(dest).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (old) {
        if (hash(old) === sourceHash) return receipt('reused', sourceHash);
        throw new Error('目标文件内容不同，未覆盖已有字体。');
      }
      const temporary = `${dest}.partial`;
      const handle = await fsp.open(temporary, 'wx');
      try {
        await handle.writeFile(sourceBytes); await handle.sync();
        if (hash(await fsp.readFile(temporary)) !== sourceHash || hash(await fsp.readFile(item.path)) !== sourceHash) throw new Error('源字体已变化或副本不完整。');
        await fsp.link(temporary, dest);
      } finally { await handle.close(); await fsp.rm(temporary, { force: true }); }
      return receipt('copied', sourceHash);
    }, { priority: 'foreground', storagePath: item.path });
  }

  return { copyTemporaryActiveFontWithTrace };
}

export type FontActivationCopyRuntime = ReturnType<typeof createFontActivationCopyRuntime>;
