// Development trial only. Packaging never changes the default renderer.
export function residentPreviewEnabled(): boolean {
  return process.platform === 'win32' && process.defaultApp === true && process.env.NODE_ENV !== 'production'
    && process.env.HFM_PREVIEW_BACKEND === 'directwrite-resident'
}
