import type { TemporaryActiveFontsFile, TemporaryActiveFontRecord } from './fontRuntimeTypes'
import { createLocalRecoveryFileRuntime, isTemporaryActiveFontRecord } from '../../activation/runtime/localRecoveryFileRuntime'

export interface TemporaryActiveFontsStoreOptions {
  dataRoot: () => string
  dataPath: (...parts: string[]) => string
}

export function createTemporaryActiveFontsStoreRuntime(options: TemporaryActiveFontsStoreOptions) {
  const { dataPath } = options

  function temporaryActiveFontsPath(): string {
    return dataPath('temporary-active-fonts.json')
  }
  const store = createLocalRecoveryFileRuntime<TemporaryActiveFontRecord>(temporaryActiveFontsPath, isTemporaryActiveFontRecord)

  async function loadTemporaryActiveFonts(): Promise<TemporaryActiveFontsFile> {
    return { version: 1, records: await store.load() }
  }

  async function saveTemporaryActiveFonts(state: TemporaryActiveFontsFile): Promise<void> {
    if (state.version !== 1) throw new Error('不支持的临时字体记录版本。')
    await store.save(state.records)
  }

  return { loadTemporaryActiveFonts, saveTemporaryActiveFonts }
}
