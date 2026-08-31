import { promises as fsp } from 'node:fs'
import type { TemporaryActiveFontsFile } from './fontRuntimeTypes'

export interface TemporaryActiveFontsStoreOptions {
  dataRoot: () => string
  dataPath: (...parts: string[]) => string
}

export function createTemporaryActiveFontsStoreRuntime(options: TemporaryActiveFontsStoreOptions) {
  const { dataRoot, dataPath } = options

  function temporaryActiveFontsPath(): string {
    return dataPath('temporary-active-fonts.json')
  }

  async function loadTemporaryActiveFonts(): Promise<TemporaryActiveFontsFile> {
    try {
      const raw = await fsp.readFile(temporaryActiveFontsPath(), 'utf-8')
      const parsed = JSON.parse(raw) as TemporaryActiveFontsFile
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('bad temporary-active-fonts file')
      return parsed
    } catch {
      return { version: 1, records: [] }
    }
  }

  async function saveTemporaryActiveFonts(state: TemporaryActiveFontsFile): Promise<void> {
    await fsp.mkdir(dataRoot(), { recursive: true })
    await fsp.writeFile(temporaryActiveFontsPath(), JSON.stringify(state), 'utf-8')
  }

  return { loadTemporaryActiveFonts, saveTemporaryActiveFonts }
}
