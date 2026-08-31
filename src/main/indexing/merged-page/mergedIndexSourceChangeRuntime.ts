type MergedIndexSourceKeyEntry = {
  root?: string;
  indexDbPath?: string;
  installDbPath?: string;
  indexSignature?: string;
  installSignature?: string;
  sharedMetadataSignature?: string;
};

type SourceKeyField = keyof MergedIndexSourceKeyEntry;

const SOURCE_KEY_FIELDS: SourceKeyField[] = [
  'root',
  'indexDbPath',
  'installDbPath',
  'indexSignature',
  'installSignature',
  'sharedMetadataSignature',
];

function parseSourceKey(value: string): MergedIndexSourceKeyEntry[] | null {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedFieldValue(entry: MergedIndexSourceKeyEntry, field: SourceKeyField): string {
  if (field === 'sharedMetadataSignature') return entry.sharedMetadataSignature || 'metadata:none';
  return String(entry[field] || '');
}

function sourceKeyChangedOnlyByFields(
  previousKey: string,
  nextKey: string,
  allowedFields: SourceKeyField[],
): boolean {
  if (!previousKey || !nextKey || previousKey === nextKey) return false;
  const previous = parseSourceKey(previousKey);
  const next = parseSourceKey(nextKey);
  if (!previous || !next || previous.length !== next.length) return false;

  const allowed = new Set<SourceKeyField>(allowedFields);
  const previousByRoot = new Map<string, MergedIndexSourceKeyEntry>(
    previous.map((entry) => [entry.root || '', entry] as [string, MergedIndexSourceKeyEntry])
  );
  let allowedFieldChanged = false;
  for (const nextEntry of next) {
    const previousEntry = previousByRoot.get(nextEntry.root || '');
    if (!previousEntry) return false;
    for (const field of SOURCE_KEY_FIELDS) {
      const before = normalizedFieldValue(previousEntry, field);
      const after = normalizedFieldValue(nextEntry, field);
      if (before === after) continue;
      if (!allowed.has(field)) return false;
      allowedFieldChanged = true;
    }
  }
  return allowedFieldChanged;
}

export function isSharedMetadataIncrementalSyncReason(reason: string): boolean {
  const value = String(reason || '').toLowerCase();
  return value.includes('shared') && (value.includes('tag') || value.includes('metadata'));
}

export function isRootIndexIncrementalSyncReason(reason: string): boolean {
  const value = String(reason || '').toLowerCase();
  return value.includes('watcher') || value.includes('manual-folder-refresh');
}

export function isInstallStatusIncrementalSyncReason(reason: string): boolean {
  const value = String(reason || '').toLowerCase();
  return value.includes('install-status') || value.includes('activation');
}

export function sourceKeyChangedOnlyBySharedMetadata(
  previousKey: string,
  nextKey: string,
): boolean {
  return sourceKeyChangedOnlyByFields(previousKey, nextKey, ['sharedMetadataSignature']);
}

export function sourceKeyChangedOnlyByRootIndex(
  previousKey: string,
  nextKey: string,
): boolean {
  return sourceKeyChangedOnlyByFields(previousKey, nextKey, ['indexSignature']);
}

export function sourceKeyChangedOnlyByInstallStatus(
  previousKey: string,
  nextKey: string,
): boolean {
  return sourceKeyChangedOnlyByFields(previousKey, nextKey, ['installSignature']);
}
