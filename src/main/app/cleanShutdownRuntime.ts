import fs from "node:fs";
import { dirname } from "node:path";

export type CleanShutdownRuntimeOptions = {
  dataPath: (name: string) => string;
  cacheArchitectureVersion: number;
  appendLog: (message: string) => void;
};

export type ShutdownMarkerOutcome = {
  processExitClean: boolean;
  persistenceComplete: boolean;
  localCleanupComplete: boolean;
  cleanupRemaining?: number | null;
  cleanupTimedOut?: boolean;
  forced?: boolean;
  reason?: string;
};

export type CleanShutdownRuntime = {
  beginStartupSessionSync: () => void;
  markCleanShutdownSync: (outcome?: ShutdownMarkerOutcome) => void;
};

type ShutdownMarker = {
  clean?: boolean;
  at?: string;
  startedAt?: string;
  architectureVersion?: number;
  pid?: number;
  processExitClean?: boolean;
  persistenceComplete?: boolean;
  localCleanupComplete?: boolean;
  cleanupRemaining?: number | null;
  cleanupTimedOut?: boolean;
  forced?: boolean;
  reason?: string;
};

export function createCleanShutdownRuntime(
  options: CleanShutdownRuntimeOptions,
): CleanShutdownRuntime {
  const markerPath = options.dataPath("last-shutdown.json");
  const sessionStartedAt = new Date().toISOString();
  let sessionStarted = false;

  function writeMarkerSync(marker: ShutdownMarker): void {
    fs.mkdirSync(dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(marker), "utf-8");
  }

  function beginStartupSessionSync(): void {
    if (sessionStarted) return;
    sessionStarted = true;
    try {
      if (fs.existsSync(markerPath)) {
        const previous = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as ShutdownMarker;
        if (previous?.clean === false) {
          options.appendLog(
            `previous shutdown was unclean: startedAt=${previous.startedAt || "unknown"}, markerAt=${previous.at || "unknown"}, pid=${previous.pid || 0}, processExitClean=${previous.processExitClean ?? false}, persistenceComplete=${previous.persistenceComplete ?? false}, localCleanupComplete=${previous.localCleanupComplete ?? false}, cleanupRemaining=${previous.cleanupRemaining ?? "unknown"}, cleanupTimedOut=${previous.cleanupTimedOut ?? false}, forced=${previous.forced ?? false}, reason=${previous.reason || "legacy-unclean"}`,
          );
        } else if (previous?.clean === true) {
          if (previous.localCleanupComplete === false) {
            options.appendLog(
              `previous shutdown marker: clean with planned residual cleanup, at=${previous.at || "unknown"}, persistenceComplete=${previous.persistenceComplete ?? true}, cleanupRemaining=${previous.cleanupRemaining ?? "unknown"}, cleanupTimedOut=${previous.cleanupTimedOut ?? false}, forced=${previous.forced ?? false}, reason=${previous.reason || "residual"}`,
            );
          } else {
            options.appendLog(`previous shutdown marker: clean, at=${previous.at || "unknown"}`);
          }
        } else {
          options.appendLog("previous shutdown marker: unreadable state");
        }
      } else {
        options.appendLog("previous shutdown marker: none");
      }
      writeMarkerSync({
        clean: false,
        at: sessionStartedAt,
        startedAt: sessionStartedAt,
        architectureVersion: options.cacheArchitectureVersion,
        pid: process.pid,
      });
    } catch (error) {
      options.appendLog(
        `startup session mark skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function markCleanShutdownSync(outcome: ShutdownMarkerOutcome = {
    processExitClean: true,
    persistenceComplete: true,
    localCleanupComplete: true,
    cleanupRemaining: 0,
    cleanupTimedOut: false,
    forced: false,
    reason: "complete",
  }): void {
    try {
      const clean = outcome.processExitClean && outcome.persistenceComplete;
      writeMarkerSync({
        clean,
        at: new Date().toISOString(),
        startedAt: sessionStartedAt,
        architectureVersion: options.cacheArchitectureVersion,
        pid: process.pid,
        processExitClean: outcome.processExitClean,
        persistenceComplete: outcome.persistenceComplete,
        localCleanupComplete: outcome.localCleanupComplete,
        cleanupRemaining: outcome.cleanupRemaining,
        cleanupTimedOut: outcome.cleanupTimedOut,
        forced: outcome.forced,
        reason: outcome.reason,
      });
    } catch (error) {
      options.appendLog(
        `clean shutdown mark skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { beginStartupSessionSync, markCleanShutdownSync };
}
