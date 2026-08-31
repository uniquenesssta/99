import type { HfmApi } from '../../preload'

declare global {

interface ImportMetaEnv {
  readonly VITE_HFM_PREVIEW_BINARY_WEBFONT_FALLBACK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

  interface Window {
    hfm: HfmApi
  }
}

export { }
