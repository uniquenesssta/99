import type { FontParseJob } from '../fontScanWorkers'

// A completed read may be unclassifiable. Keep that outcome distinct from a
// failed or unperformed read; the latter still requires recovery/retry.
export function canClassifyUnknownScriptAsOther(job: FontParseJob): boolean {
  return job.signatureValid === true && job.sourceStability === 'stable'
    && ['missing', 'empty', 'unsupported', 'malformed', 'resource-limit', 'complete'].includes(job.parseDisposition?.scripts || '')
    && !(job.metadataDiagnostics || []).some(item => item.kind === 'io-error')
}
