import type { FontParseJob } from '../fontScanWorkers'
import { buildFontParseResultFromRustMetadata } from './rustMetadataFastPathRuntime'

// Pure parse hints only: never retain mutable tags, install state, or root rows.
type Metadata = Pick<FontParseJob, 'signatureValid' | 'formatHint' | 'quickHash' | 'contentHash' | 'hashKind' | 'nameHint' | 'scriptHint' | 'styleHint' | 'familyHint' | 'parseDisposition' | 'sourceStability' | 'metadataDiagnostics'>
type Entry = { root: string; scope: string; identity: string; metadata: Metadata; bytes: number }
export const SCAN_METADATA_PARSER_VERSION = 2
export function createScanMetadataMemoRuntime(limits = { entries: 10000, bytes: 32 * 1024 * 1024 }) {
  const entries = new Map<string, Entry>()
  let bytes = 0
  const key = (root: string, file: string) => JSON.stringify([root, file])
  const identity = (job: FontParseJob) => JSON.stringify([job.signature, job.fileSize, job.modifiedAt, job.createdAt, job.contentHash || job.quickHash || ''])
  function remove(key: string) {
    const prior = entries.get(key)
    if (prior) { bytes -= prior.bytes; entries.delete(key) }
  }
  function clearRoot(root: string) {
    for (const [key, entry] of entries) if (entry.root === root) remove(key)
  }
  function read(root: string, scope: string, job: FontParseJob): FontParseJob | undefined {
    const id = key(root, job.cacheKey), entry = entries.get(id)
    if (!entry) return undefined
    if (entry.scope !== scope || entry.identity !== identity(job)) { remove(id); return undefined }
    entries.delete(id); entries.set(id, entry)
    // Return fresh copies: callers cannot mutate retained parse hints.
    return { ...job, ...JSON.parse(JSON.stringify(entry.metadata)) as Metadata }
  }
  function remember(root: string, scope: string, job: FontParseJob, scriptVersion: number, identityJob = job) {
    if (job.sourceStability !== 'stable' || job.signatureValid !== true) return
    if (job.metadataDiagnostics?.some(item => item.kind === 'io-error')) return
    const disposition = job.parseDisposition?.scripts
    if (!disposition || disposition === 'io-error' || disposition === 'resource-limit' || disposition === 'not-requested') return
    const success = buildFontParseResultFromRustMetadata(job, scriptVersion)?.status === 'ok'
    const deterministicMissingScript = !job.scriptHint && ['missing', 'empty', 'unsupported', 'malformed'].includes(disposition)
    if (!success && !deterministicMissingScript) return
    const metadata: Metadata = {
      signatureValid: job.signatureValid, formatHint: job.formatHint,
      quickHash: job.quickHash, contentHash: job.contentHash, hashKind: job.hashKind,
      nameHint: job.nameHint, scriptHint: job.scriptHint, styleHint: job.styleHint, familyHint: job.familyHint,
      parseDisposition: job.parseDisposition, sourceStability: job.sourceStability,
      metadataDiagnostics: job.metadataDiagnostics?.slice(0, 16),
    }
    const encoded = JSON.stringify(metadata), id = key(root, job.cacheKey)
    const size = Buffer.byteLength(encoded + id + scope + identity(identityJob), 'utf8')
    remove(id)
    if (size > limits.bytes || limits.entries < 1) return
    entries.set(id, { root, scope, identity: identity(identityJob), metadata: JSON.parse(encoded) as Metadata, bytes: size })
    bytes += size
    while (entries.size > limits.entries || bytes > limits.bytes) remove(entries.keys().next().value!)
  }
  function prune(root: string, seen: ReadonlySet<string>, completeListing: boolean) {
    if (!completeListing) return
    for (const [id, entry] of entries) if (entry.root === root && !seen.has(JSON.parse(id)[1])) remove(id)
  }
  return { read, remember, clearRoot, prune, size: () => ({ entries: entries.size, bytes }) }
}
