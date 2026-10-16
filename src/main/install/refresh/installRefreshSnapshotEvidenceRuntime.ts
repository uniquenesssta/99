import { dirname } from 'node:path'
import { readFontContentIdentity } from '../../fonts/fontContentIdentityRuntime'
import type { FontItem } from '../../../shared/types'
import type { InstallSourceIdentity } from '../fontInstallEvidenceRuntime'
import type { FontParseJob } from '../../indexing/fontScanWorkers'
import type { RustFontParseBatchResult } from '../../rust-core/rustCoreWorkerContracts'

export type ReadInstallSnapshotNames = (jobs: FontParseJob[]) => Promise<RustFontParseBatchResult | null>
type Names = Pick<FontItem, 'family' | 'fullName' | 'postscriptName' | 'style'>

// Use the same native name-table authority as the production scan. A missing
// native receipt stays unknown; this repair does not enable Node parsing.
// Script/cmap completeness is irrelevant to installation-name evidence.
export async function assertInstallSnapshotNamesCurrent(item: FontItem, source: InstallSourceIdentity, readNative?: ReadInstallSnapshotNames): Promise<void> {
  if (!readNative) throw new Error('fresh native names reader unavailable')
  if (item.recoveryContentHash && item.recoveryContentHash !== source.sha256) throw new Error('snapshot content identity changed')
  const job: FontParseJob = { jobId: item.id, rootPath: dirname(item.path), filePath: item.path, fileSize: item.fileSize,
    modifiedAt: item.modifiedAt, createdAt: item.createdAt || item.modifiedAt, cacheKey: item.fileName,
    signature: item.id, requireSourceStability: true }
  const response = await readNative([job])
  const row = response?.results.find(row => row.jobId === item.id)
  if (!row || row.signatureValid !== true || row.sourceStability !== 'stable' || row.metadataDiagnostics?.some(value => value.stage === 'name') || !row.nameHint) throw new Error('fresh native names unavailable')
  // Native aggregation covers every attempted face independently of the 16
  // diagnostic samples. Until separate name completeness exists, any metadata
  // I/O/resource failure conservatively keeps installation unknown (including
  // cmap I/O); deterministic unsupported/malformed cmap does not block names.
  if (!row.parseDisposition || !['complete', 'missing', 'empty', 'unsupported', 'malformed'].includes(row.parseDisposition.scripts)) {
    throw new Error('fresh metadata completeness unavailable')
  }
  const hint = row.nameHint
  let style = String(hint.displaySubfamily || hint.preferredSubfamily || hint.subfamilyName || '').trim()
  const postscriptName = String(hint.postscriptName || '').trim()
  const rawFamily = String(hint.displayFamily || hint.preferredFamily || hint.familyName || '').trim()
  const rawFull = String(hint.fullName || [rawFamily, style].filter(Boolean).join(' ') || rawFamily || postscriptName || '').trim()
  const family = rawFamily || rawFull || postscriptName
  if (!family) throw new Error('fresh native names empty')
  if (!style && row.styleHint) {
    const parts: string[] = [], weight = Number(row.styleHint.weightClass || 0)
    if (weight >= 700 || row.styleHint.bold) parts.push('Bold')
    else if (weight > 0 && weight <= 300) parts.push('Light')
    if (row.styleHint.italic) parts.push('Italic')
    style = parts.join(' ')
  }
  const names: Names = {family, fullName: rawFull || family, postscriptName, style}
  // The native reader pins its own stat. Bind that read to this operation's
  // whole-content evidence too, including same-size/same-mtime replacements.
  const after = await readFontContentIdentity(item.path)
  if (after.sha256 !== source.sha256 || after.stamp !== source.stamp) throw new Error('source changed during native name confirmation')
  if (!(['family','fullName','postscriptName','style'] as const).every(field => String(item[field] || '') === names[field])) {
    throw new Error('snapshot names changed or unavailable')
  }
}
