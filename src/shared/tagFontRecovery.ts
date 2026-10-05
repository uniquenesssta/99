export type TagFontRecoveryRequest = { tagName: string; scope: 'local' | 'shared'; mode: 'reindex' | 'relink' }
export type TagFontRecoveryResult = { linked: number; remaining: number; canceled: boolean; failures: string[]; message: string }
