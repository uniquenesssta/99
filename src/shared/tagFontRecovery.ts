export type TagFontRecoveryRequest =
  | { mode: 'reindex'; tagName: string; scope: 'local' | 'shared' }
  | { mode: 'relink'; fontPath: string; scope: 'local' | 'shared' }
export type TagFontRecoveryResult = { linked: number; remaining: number; canceled: boolean; busy?: boolean; failures: string[]; scope?: 'local' | 'shared'; pendingAssociations?: string[]; unresolved?: Array<{ path: string; reason: string }>; message: string }
