import { createLocalRecoveryFileRuntime, isTemporaryActiveFontRecord } from "./localRecoveryFileRuntime";
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

function compensationKey(record: TemporaryActiveFontRecord): string {
  return record.installPath.toLowerCase();
}

export function createFontActivationCompensationQueue(
  deps: Pick<FontActivationRuntimeDeps, "dataPath" | "dataRoot">,
) {

  function pendingCompensationsPath(): string {
    return deps.dataPath("pending-font-activation-compensations.json");
  }

  const store = createLocalRecoveryFileRuntime<PendingFontActivationCompensation>(pendingCompensationsPath, value => {
    const entry = value as PendingFontActivationCompensation | undefined;
    return !!entry && isTemporaryActiveFontRecord(entry.record)
      && !!entry.pending && [entry.pending.file, entry.pending.registry, entry.pending.resource].every(value => typeof value === "boolean")
      && typeof entry.queuedAt === "string" && Number.isInteger(entry.attempts) && entry.attempts >= 0
      && typeof entry.reason === "string" && typeof entry.lastError === "string";
  });

  async function mutatePendingCompensations(mutation: (records: PendingFontActivationCompensation[]) => void): Promise<void> {
    await store.update(records => { mutation(records); return records; });
  }

  async function upsert(
    entry: PendingFontActivationCompensation,
  ): Promise<void> {
    entry = { ...entry, record: { ...entry.record }, pending: { ...entry.pending } };
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
    return store.load();
  }

  return { load, upsert, remove };
}

export type FontActivationCompensationQueue = ReturnType<
  typeof createFontActivationCompensationQueue
>;
