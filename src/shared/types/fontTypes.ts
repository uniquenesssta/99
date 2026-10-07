export type FontFormat = 'ttf' | 'otf' | 'ttc' | 'otc' | 'unknown'
export type FontScript = 'latin' | 'chinese' | 'japanese' | 'korean' | 'symbol' | 'other' | 'arabic' | 'hebrew' | 'thai' | 'cyrillic' | 'greek' | 'devanagari' | 'bengali' | 'tamil' | 'telugu' | 'gujarati' | 'gurmukhi' | 'lao' | 'khmer' | 'myanmar' | 'ethiopic' | 'armenian' | 'georgian' | 'vietnamese'

export interface SystemInstalledFont {
  source: 'HKCU' | 'HKLM' | 'WindowsFontsFolder'
  registryName: string
  value: string
  path?: string
  fileName?: string
  nameCandidates?: string[]
}

export interface FontItem {
  id: string
  sourceId?: string
  path: string
  fileName: string
  family: string
  fullName: string
  postscriptName: string
  style: string
  familyKey?: string
  styleKey?: string
  familySource?: 'rust' | 'fontkit' | 'name' | 'fallback'
  format: FontFormat
  scripts?: FontScript[]
  scriptVersion?: number
  fileSize: number
  modifiedAt: number
  createdAt?: number
  addedAt: string
  favorite: boolean
  collectionIds: string[]
  tagNames: string[]
  localTagNames?: string[]
  __sharedTagRevision?: number
  __localTagRevision?: number
  __sharedTagDirtyUntil?: number
  __localTagDirtyUntil?: number
  systemInstalled: boolean
  installStatusKnown?: boolean
  systemInstallMatches: SystemInstalledFont[]
  active: boolean
  systemImported?: boolean
  previewDisabled?: boolean
  previewError?: string
  activeSince?: string
  managedInstallPath?: string
  managedRegistryName?: string
  deleteProtected?: boolean
  __earlyVisible?: boolean
}
