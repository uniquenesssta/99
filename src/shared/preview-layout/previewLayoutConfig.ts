import type { PreviewLayoutMode,PreviewLayoutSpec } from './previewLayoutTypes'

// Fixed preview limit boxes: use a stable base size and only shrink when the
// sample text is clearly too wide for the box. This is closer to Word/PS and
// mature font managers than trying to normalize every font's visual ink area.
export const PREVIEW_LAYOUTS: Record<PreviewLayoutMode, PreviewLayoutSpec> = {
  grid: {
    width: 520,
    height: 150,
    paddingX: 28,
    paddingY: 20,
    maxFontSize: 42,
    minFontSize: 26,
    lineHeight: 1.04,
    maxLines: 1,
    capacityUnits: 16
  },
  list: {
    width: 760,
    height: 176,
    paddingX: 36,
    paddingY: 20,
    maxFontSize: 44,
    minFontSize: 24,
    lineHeight: 1.16,
    maxLines: 2,
    capacityUnits: 24
  },
  detail: {
    width: 760,
    height: 300,
    paddingX: 42,
    paddingY: 34,
    maxFontSize: 72,
    minFontSize: 34,
    lineHeight: 1.02,
    maxLines: 2,
    capacityUnits: 18
  }
}

export const DEFAULT_PREVIEW_TEXT = '字体预览\nAaBb 123'
