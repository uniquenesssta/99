import type { FontParseJob } from '../fontScanWorkers'

import { normalizeRustMetadataDiagnostics, type RustMetadataDiagnostic } from '../../rust-core/fontMetadataDiagnostics'

// Local startup log only. No external upload and no change to scan admission.
export function createRustMetadataRejectionReporter(log: (line: string) => void, prefix: string) {
  const counts = new Map<string, number>()
  const nativeCounts = new Map<string, number>()
  const samples: string[] = []
  const sampled = new Map<string, number>()
  return {
    reject(job: FontParseJob, reason: string, diagnostics?: RustMetadataDiagnostic[], nativeError?: string): void {
      diagnostics = normalizeRustMetadataDiagnostics(diagnostics)
      counts.set(reason, (counts.get(reason) || 0) + 1)
      for (const key of new Set((diagnostics || []).map(item => `${item.stage}:${item.kind}`))) {
        nativeCounts.set(key, (nativeCounts.get(key) || 0) + 1)
      }
      if (samples.length >= 12 || (sampled.get(reason) || 0) >= 3) return
      sampled.set(reason, (sampled.get(reason) || 0) + 1)
      samples.push(JSON.stringify({ reason, jobId: job.jobId.slice(0, 128), path: job.filePath.slice(0, 1024),
        diagnostics: diagnostics || [], ...(nativeError ? { nativeError: nativeError.slice(0, 256) } : {}) }))
    },
    flush(): void {
      if (!counts.size) return
      log(`${prefix} rejected metadata: reasons=${JSON.stringify(Object.fromEntries(counts))}, native=${JSON.stringify(Object.fromEntries(nativeCounts))}, samples=${samples.length}, diagnosticLimitPerFont=16, sampleLimits=12-total/3-per-reason; diagnostic lists and samples are bounded, not exhaustive`)
      for (const sample of samples) log(`${prefix} rejected metadata sample: ${sample}`)
    },
  }
}
