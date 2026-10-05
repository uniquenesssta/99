export type TagFontRecoveryRequest =
  | { mode: 'reindex'; tagName: string; scope: 'local' | 'shared' }
  | { mode: 'relink'; fontPath: string; scope: 'local' | 'shared' }
export type TagFontRecoveryResult = { linked: number; remaining: number; canceled: boolean; failures: string[]; message: string }
