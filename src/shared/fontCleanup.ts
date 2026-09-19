export type FontCleanupRecord = {
  key: string
  fileName: string
  path: string
  stage: string
  error: string
  canAdopt: boolean
  canDismissMissing?: boolean
  observedToken?: string
}
export type FontCleanupReport = { records: FontCleanupRecord[]; errors: string[] }
export type FontCleanupAction = { action: 'retry' | 'restart' | 'open-records' | 'open-fonts' } | { action: 'adopt'; key: string; observedToken: string } | { action: 'dismiss-missing'; key: string; windowsRestarted: true }
