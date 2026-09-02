import { promises as fsp } from "node:fs";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";

export interface FontActivationCompensationStages {
  file: boolean;
  registry: boolean;
  resource: boolean;
}

export interface PendingFontActivationCompensation {
  record: TemporaryActiveFontRecord;
  pending: FontActivationCompensationStages;
  queuedAt: string;
  attempts: number;
  reason: string;
  lastError: string;
}

interface PendingFontActivationCompensationsFile {
  version: 1;
  records: PendingFontActivationCompensation[];
}

function compensationKey(record: TemporaryActiveFontRecord): string {
  return record.installPath.toLowerCase();
}

export function createFontActivationCompensationQueue(
  deps: Pick<FontActivationRuntimeDeps, "dataPath" | "dataRoot">,
) {
  let mutationTail: Promise<void> = Promise.resolve();

  function pendingCompensationsPath(): string {
    return deps.dataPath("pending-font-activation-compensations.json");
  }

  async function readPendingCompensations(): Promise<
    PendingFontActivationCompensation[]
  > {
    try {
      const raw = await fsp.readFile(pendingCompensationsPath(), "utf-8");
      const parsed = JSON.parse(raw) as PendingFontActivationCompensationsFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return [];
      return parsed.records.filter(
        (entry) => !!entry?.record?.installPath && !!entry.pending,
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code || "")
          : "";
      if (code === "ENOENT") return [];
      throw error;
    }
  }

  async function writePendingCompensations(
    records: PendingFontActivationCompensation[],
  ): Promise<void> {
    await fsp.mkdir(deps.dataRoot(), { recursive: true });
    await fsp.writeFile(
      pendingCompensationsPath(),
      JSON.stringify({ version: 1, records }),
      "utf-8",
    );
  }

  async function mutatePendingCompensations(
    mutation: (records: PendingFontActivationCompensation[]) => void,
  ): Promise<void> {
    const task = mutationTail.then(async () => {
      const records = await readPendingCompensations();
      mutation(records);
      await writePendingCompensations(records);
    });
    mutationTail = task.catch(() => undefined);
    return task;
  }

  async function upsert(
    entry: PendingFontActivationCompensation,
  ): Promise<void> {
    await mutatePendingCompensations((records) => {
      const key = compensationKey(entry.record);
      const index = records.findIndex(
        (candidate) => compensationKey(candidate.record) === key,
      );
      if (index >= 0) records[index] = entry;
      else records.push(entry);
    });
  }

  async function remove(record: TemporaryActiveFontRecord): Promise<void> {
    await mutatePendingCompensations((records) => {
      const key = compensationKey(record);
      const index = records.findIndex(
        (candidate) => compensationKey(candidate.record) === key,
      );
      if (index >= 0) records.splice(index, 1);
    });
  }

  async function load(): Promise<PendingFontActivationCompensation[]> {
    await mutationTail.catch(() => undefined);
    return readPendingCompensations();
  }

  return { load, upsert, remove };
}

export type FontActivationCompensationQueue = ReturnType<
  typeof createFontActivationCompensationQueue
>;
