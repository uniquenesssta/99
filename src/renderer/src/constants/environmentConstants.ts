export const STARTUP_AUTO_SYSTEM_FONT_IMPORT_ENABLED = false
export const APP_VERSION = '3.0.0'
export const RENDERER_ENV = (import.meta as unknown as { env?: { DEV?: boolean; PROD?: boolean } }).env
export const IS_DEVELOPMENT = RENDERER_ENV?.DEV === true && RENDERER_ENV?.PROD !== true
