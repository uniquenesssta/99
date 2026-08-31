import fs from "node:fs";
import { dirname } from "node:path";

export type CleanShutdownRuntimeOptions = {
  dataPath: (name: string) => string;
  cacheArchitectureVersion: number;
  appendLog: (message: string) => void;
};

export type CleanShutdownRuntime = {
  beginStartupSessionSync: () => void;
  markCleanShutdownSync: () => void;
};

type ShutdownMarker = {
  clean?: boolean;
  at?: string;
  startedAt?: string;
  architectureVersion?: number;
  pid?: number;
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
            `previous shutdown was unclean: startedAt=${previous.startedAt || "unknown"}, markerAt=${previous.at || "unknown"}, pid=${previous.pid || 0}`,
          );
        } else if (previous?.clean === true) {
          options.appendLog(`previous shutdown marker: clean, at=${previous.at || "unknown"}`);
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

  function markCleanShutdownSync(): void {
    try {
      writeMarkerSync({
        clean: true,
        at: new Date().toISOString(),
        startedAt: sessionStartedAt,
        architectureVersion: options.cacheArchitectureVersion,
        pid: process.pid,
      });
    } catch (error) {
      options.appendLog(
        `clean shutdown mark skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { beginStartupSessionSync, markCleanShutdownSync };
}
