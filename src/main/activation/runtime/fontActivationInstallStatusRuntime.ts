import { basename } from "node:path";
import type { FontItem,InstallCompareResult,SystemInstalledFont } from "../../../shared/types";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";

export function uniqueFontItems(items: FontItem[]): FontItem[] {
  return Array.from(
    new Map(
      (items || [])
        .filter((item) => !!item?.id)
        .map((item) => [item.id, item]),
    ).values(),
  );
}

export function createFontActivationInstallStatusRuntime(
  deps: FontActivationRuntimeDeps,
) {
  const {
    isTemporaryActiveInstalledRecord,
    compareFontInstalledWithList,
    getSystemInstalledFontsCached,
    readInstallStatusIndex,
    saveInstallStatusIndex,
    scheduleActivationInstallStatusSave,
    appendStartupLog,
  } = deps;

  function installCompareFromFontItemSnapshot(
    item: FontItem,
  ): InstallCompareResult | null {
    if (item.installStatusKnown !== true) return null;
    return {
      installed: !!item.systemInstalled,
      by: item.systemInstalled
        ? item.systemInstallMatches?.some(isTemporaryActiveInstalledRecord)
          ? "managed"
          : "system"
        : "none",
      matches: item.systemInstallMatches || [],
    };
  }

  async function readActivationInstallStatusSnapshot(
    items: FontItem[],
  ): Promise<{
    results: Record<string, InstallCompareResult>;
    misses: FontItem[];
  }> {
    const unique = uniqueFontItems(items);
    const results: Record<string, InstallCompareResult> = {};
    const needsIndex: FontItem[] = [];

    for (const item of unique) {
      const snapshot = installCompareFromFontItemSnapshot(item);
      if (snapshot) {
        results[item.id] = snapshot;
      } else {
        needsIndex.push(item);
      }
    }

    if (!needsIndex.length) return { results, misses: [] };

    try {
      const indexed = await readInstallStatusIndex(needsIndex, {
        enqueueMissTasks: false,
      });
      Object.assign(results, indexed.results || {});
      return { results, misses: indexed.misses || [] };
    } catch (error) {
      appendStartupLog(
        `activation install status cache read skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { results, misses: needsIndex };
    }
  }

  async function compareActivationInstallStatus(
    item: FontItem,
  ): Promise<InstallCompareResult> {
    const snapshot = await readActivationInstallStatusSnapshot([item]);
    const cached = snapshot.results[item.id];
    if (cached) {
      appendStartupLog(
        `activation install status cache hit: fontId=${item.id}, installed=${cached.installed}, by=${cached.by}`,
      );
      return cached;
    }

    appendStartupLog(`activation install status cache miss: fontId=${item.id}`);
    const installed = await getSystemInstalledFontsCached(false);
    const result = compareFontInstalledWithList(item, installed);
    await saveInstallStatusIndex(
      { [item.id]: result },
      new Map([[item.id, item]]),
    ).catch((error) =>
      appendStartupLog(
        `activation install status cache write skipped: fontId=${item.id}, ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return result;
  }

  async function readActivationInstallStatusBatch(
    items: FontItem[],
  ): Promise<Record<string, InstallCompareResult>> {
    const unique = uniqueFontItems(items);
    const snapshot = await readActivationInstallStatusSnapshot(unique);
    const results: Record<string, InstallCompareResult> = {
      ...snapshot.results,
    };
    const misses = snapshot.misses.filter((item) => !results[item.id]);
    if (!misses.length) {
      appendStartupLog(
        `activation batch install status cache: total=${unique.length}, hits=${Object.keys(results).length}, misses=0`,
      );
      return results;
    }

    appendStartupLog(
      `activation batch install status cache: total=${unique.length}, hits=${Object.keys(results).length}, misses=${misses.length}`,
    );
    const installed = await getSystemInstalledFontsCached(false);
    const fresh: Record<string, InstallCompareResult> = {};
    for (const item of misses) {
      const result = compareFontInstalledWithList(item, installed);
      results[item.id] = result;
      fresh[item.id] = result;
    }
    await saveInstallStatusIndex(
      fresh,
      new Map(misses.map((item) => [item.id, item])),
    ).catch((error) =>
      appendStartupLog(
        `activation batch install status cache write skipped: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return results;
  }

  function temporaryActiveRecordToInstalledRecord(
    record: TemporaryActiveFontRecord,
  ): SystemInstalledFont {
    return {
      source: "HKCU",
      registryName: record.registryName,
      value: record.installPath,
      path: record.installPath,
      fileName: basename(record.installPath),
    };
  }

  async function saveActivationInstallStatus(
    item: FontItem,
    result: InstallCompareResult,
  ): Promise<void> {
    scheduleActivationInstallStatusSave(
      { [item.id]: result },
      new Map([[item.id, item]]),
      "single",
    );
  }

  return {
    installCompareFromFontItemSnapshot,
    readActivationInstallStatusSnapshot,
    compareActivationInstallStatus,
    readActivationInstallStatusBatch,
    temporaryActiveRecordToInstalledRecord,
    saveActivationInstallStatus,
  };
}

export type FontActivationInstallStatusRuntime = ReturnType<typeof createFontActivationInstallStatusRuntime>;
