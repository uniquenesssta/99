import { createFontActivationTraceRuntime } from "./fontActivationTraceRuntime";
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
  const { activationTraceStep, activationTraceSync } = createFontActivationTraceRuntime(deps);
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

  async function reconcileDeactivatedInstallStatus(items: FontItem[], removedPaths: string[] = []): Promise<Record<string, InstallCompareResult>> {
    const unique = uniqueFontItems(items);
    if (!unique.length) return {};
    // Ignore cached UI/index state: a missing session record cannot prove that
    // the font is not permanently installed. A fresh system read owns that fact.
    deps.clearInstalledFontsMemoryCache();
    const removed = new Set(removedPaths.map(deps.normalizePathForCacheCompare));
    const installed = (await activationTraceStep("deactivate:system-enumerate", undefined, () => getSystemInstalledFontsCached(true))).filter(record =>
      !removed.has(deps.normalizePathForCacheCompare(record.path || record.value || '')));
    const results = activationTraceSync("deactivate:status-compare", undefined, () => {
      // Build once per snapshot; preserve original record order and OR-match semantics.
      const temporaryPaths = new Map<string, number[]>();
      const temporaryNames = new Map<string, number[]>();
      const temporaryRegistryNames = new Map<string, number[]>();
      const add = (index: Map<string, number[]>, key: string, position: number): void => {
        const positions = index.get(key) || [];
        positions.push(position);
        index.set(key, positions);
      };
      installed.forEach((record, index) => {
        if (!isTemporaryActiveInstalledRecord(record)) return;
        add(temporaryPaths, deps.normalizePathForCacheCompare(record.path || record.value || ''), index);
        add(temporaryNames, String(record.fileName || basename(record.path || record.value || '')).toLowerCase(), index);
        add(temporaryRegistryNames, String(record.registryName || '').toLowerCase(), index);
      });
      const results: Record<string, InstallCompareResult> = {};
      for (const item of unique) {
        const compared = compareFontInstalledWithList(item, installed);
        // The permanent-install comparator intentionally excludes temporary
        // resources. Match those separately using this font's managed identity.
        const matchingIndexes = new Set<number>();
        if (temporaryPaths.size || temporaryNames.size || temporaryRegistryNames.size) {
          for (const indexes of [
            temporaryPaths.get(deps.normalizePathForCacheCompare(item.managedInstallPath || '')),
            temporaryNames.get(deps.safeTemporaryActiveFontName(item).toLowerCase()),
            temporaryRegistryNames.get(deps.temporaryActiveRegistryNameFor(item).toLowerCase()),
          ]) for (const index of indexes || []) matchingIndexes.add(index);
        }
        const temporaryMatches = [...matchingIndexes].sort((a, b) => a - b).map(index => installed[index]);
        const matches = [...(compared.matches || []).filter(record => !isTemporaryActiveInstalledRecord(record)), ...temporaryMatches];
        const temporary = temporaryMatches.length > 0;
        const permanent = matches.some(record => !isTemporaryActiveInstalledRecord(record));
        results[item.id] = {
          ...compared, matches, installed: compared.installed || temporary,
          by: temporary ? (permanent ? 'both' : 'managed')
            : compared.by === 'managed' || compared.by === 'both' ? (matches.some(record => record.source === 'HKLM' || record.source === 'WindowsFontsFolder') ? 'system' : 'user') : compared.by,
        };
      }
      return results;
    });
    activationTraceSync("deactivate:status-save-enqueue", undefined, () =>
      scheduleActivationInstallStatusSave(results, new Map(unique.map(item => [item.id, item])), 'deactivate-reconcile'));
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
    reconcileDeactivatedInstallStatus,
    installCompareFromFontItemSnapshot,
    readActivationInstallStatusSnapshot,
    compareActivationInstallStatus,
    readActivationInstallStatusBatch,
    temporaryActiveRecordToInstalledRecord,
    saveActivationInstallStatus,
  };
}

export type FontActivationInstallStatusRuntime = ReturnType<typeof createFontActivationInstallStatusRuntime>;
