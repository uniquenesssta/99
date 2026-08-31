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

export function createFontActivationCopyRuntime(deps: FontActivationRuntimeDeps) {
  const { normalizePathForCacheCompare, withGlobalIo, appendStartupLog, runRustFontActivationFiles } = deps;

  async function copyTemporaryActiveFontWithTrace(
    item: FontItem,
    dest: string,
    batchLabel = "single",
  ): Promise<"copied" | "reused" | "skipped-same-path"> {
    const source = normalizePathForCacheCompare(resolve(item.path));
    const target = normalizePathForCacheCompare(resolve(dest));
    if (source === target) return "skipped-same-path";

    if (runRustFontActivationFiles) {
      const rustResult = await runRustFontActivationFiles({
        copies: [{ id: item.id, source: item.path, dest }],
      }).catch((error) => {
        appendStartupLog(`rust activation copy route failed: fontId=${item.id}, ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      const rustRow = rustResult?.copyResults?.[0];
      if (rustRow?.ok) {
        const mode = rustRow.mode === "reused" || rustRow.mode === "skipped-same-path" ? rustRow.mode : "copied";
        appendStartupLog(`rust activation copy used: fontId=${item.id}, mode=${mode}`);
        return mode as "copied" | "reused" | "skipped-same-path";
      }
    }

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

    const sourceStat = await withGlobalIo(
      `activate:${batchLabel}:stat-source`,
      () => fsp.stat(item.path),
      { priority: "foreground", storagePath: item.path },
    );
    const targetStat = await fsp.stat(dest).catch(() => null);
    if (
      targetStat?.isFile() &&
      targetStat.size === sourceStat.size &&
      Math.round(targetStat.mtimeMs) === Math.round(sourceStat.mtimeMs)
    ) {
      return "reused";
    }

    await withGlobalIo(
      `activate:${batchLabel}:copy-font`,
      async () => {
        await fsp.copyFile(item.path, dest);
        await fsp
          .utimes(dest, sourceStat.atime, sourceStat.mtime)
          .catch(() => undefined);
      },
      { priority: "foreground", storagePath: item.path },
    );
    return "copied";
  }

  return { copyTemporaryActiveFontWithTrace };
}

export type FontActivationCopyRuntime = ReturnType<typeof createFontActivationCopyRuntime>;
