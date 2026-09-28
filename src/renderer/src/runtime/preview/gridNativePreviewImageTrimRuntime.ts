import { useEffect,useState } from 'react'
import { isGridNativePreviewImage } from './gridNativePreviewImageRuntime'

const ALPHA_THRESHOLD = 8
const CROP_PADDING_X = 18
const CROP_PADDING_Y = 12
const TRIM_CACHE_LIMIT = 240

export type TrimmedPreviewImage = { image: string; clipped: boolean }
const trimCache = new Map<string, TrimmedPreviewImage>()
const trimInflight = new Map<string, Promise<TrimmedPreviewImage>>()

function rememberTrimmedImage(source: string, image: string, clipped = false): TrimmedPreviewImage {
  const value = { image, clipped }
  if (trimCache.has(source)) trimCache.delete(source)
  trimCache.set(source, value)
  while (trimCache.size > TRIM_CACHE_LIMIT) {
    const oldest = trimCache.keys().next().value
    if (!oldest) break
    trimCache.delete(oldest)
  }
  return value
}

function loadImage(source: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = source
  })
}

function clampCropRange(min: number, max: number, limit: number, padding: number): [number, number] {
  return [Math.max(0, min - padding), Math.min(limit - 1, max + padding)]
}

function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

async function trimGridNativePreviewImage(source: string): Promise<TrimmedPreviewImage> {
  if (!source.startsWith('data:image/png')) return { image: source, clipped: false }
  const cached = trimCache.get(source)
  if (cached) {
    trimCache.delete(source)
    trimCache.set(source, cached)
    return cached
  }
  const inflight = trimInflight.get(source)
  if (inflight) return inflight

  const task = (async () => {
    const image = await loadImage(source)
    const width = image?.naturalWidth || 0
    const height = image?.naturalHeight || 0
    if (!image || width <= 0 || height <= 0) return rememberTrimmedImage(source, source)

    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = width
    sourceCanvas.height = height
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
    if (!sourceContext) return rememberTrimmedImage(source, source)

    try {
      sourceContext.drawImage(image, 0, 0)
      const pixels = sourceContext.getImageData(0, 0, width, height).data
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const alpha = pixels[((y * width + x) * 4) + 3]
          if (alpha <= ALPHA_THRESHOLD) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }

      if (maxX < minX || maxY < minY) return rememberTrimmedImage(source, source)

      const clipped = minX <= 1 || minY <= 1 || maxX >= width - 2 || maxY >= height - 2
      const [cropX1, cropX2] = clampCropRange(minX, maxX, width, CROP_PADDING_X)
      const [cropY1, cropY2] = clampCropRange(minY, maxY, height, CROP_PADDING_Y)
      const cropWidth = Math.max(1, cropX2 - cropX1 + 1)
      const cropHeight = Math.max(1, cropY2 - cropY1 + 1)

      // If the rendered ink already uses almost the full canvas, keep the source.
      // This avoids lossy re-encoding for fonts whose native renderer did not add
      // large transparent margins. Scale-down CSS will still protect the card edge.
      if (cropWidth >= width - 4 && cropHeight >= height - 4) return rememberTrimmedImage(source, source, clipped)

      const targetCanvas = document.createElement('canvas')
      targetCanvas.width = cropWidth
      targetCanvas.height = cropHeight
      const targetContext = targetCanvas.getContext('2d')
      if (!targetContext) return rememberTrimmedImage(source, source)
      targetContext.drawImage(sourceCanvas, cropX1, cropY1, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
      return rememberTrimmedImage(source, canvasToDataUrl(targetCanvas) || source, clipped)
    } catch {
      return rememberTrimmedImage(source, source)
    }
  })().finally(() => {
    trimInflight.delete(source)
  })

  trimInflight.set(source, task)
  return task
}

export function useGridNativePreviewImageTrim(source?: string): TrimmedPreviewImage | undefined {
  const [result, setResult] = useState<{ source: string; value: TrimmedPreviewImage } | undefined>()
  useEffect(() => {
    let cancelled = false
    if (!source || !isGridNativePreviewImage(source)) return
    void trimGridNativePreviewImage(source).then(value => {
      if (!cancelled) setResult({ source, value })
    })
    return () => { cancelled = true }
  }, [source])
  // Never expose a previous font's crop during the render before effect cleanup.
  return result && result.source === source ? result.value : undefined
}
