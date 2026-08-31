import { app } from 'electron'
import fs from 'node:fs'
import { join } from 'node:path'
import type { HfmLicenseDocument } from './licenseTypes'

export type LicenseStorePaths = {
  candidates: string[]
  primary: string
}

export function licenseStorePaths(dataPath: (...parts: string[]) => string): LicenseStorePaths {
  const primary = dataPath('license', 'license.json')
  const candidates = [
    process.env.HFM_LICENSE_FILE || '',
    primary,
    app.isPackaged ? join(process.resourcesPath, 'license.json') : ''
  ].filter(Boolean)

  return { primary, candidates }
}

export function readFirstLicenseDocument(dataPath: (...parts: string[]) => string): { path: string; document: HfmLicenseDocument } | null {
  for (const candidate of licenseStorePaths(dataPath).candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue
    const document = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as HfmLicenseDocument
    return { path: candidate, document }
  }
  return null
}
