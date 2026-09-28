import { useEffect,useState,useSyncExternalStore } from 'react'
import { createGridPreviewPostprocessRuntime,GRID_POSTPROCESS_LIMITS } from './gridPreviewPostprocessRuntime'
import type { GridPreviewCrop,TrimmedPreviewImage } from './gridPreviewPostprocessRuntime'
import { isGridNativePreviewImage } from './gridNativePreviewImageRuntime'

const ALPHA_THRESHOLD = 8
const CROP_PADDING_X = 18
function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    const settled = () => { image.onload = null; image.onerror = null; resolve(image) }
    image.onload = settled
    image.onerror = settled
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

async function trimGridNativePreviewImage(source: string, wanted: () => boolean): Promise<GridPreviewCrop | undefined> {
  const image = await loadImage(source)
  const canvases: HTMLCanvasElement[] = []
  const canvas = () => { const value = document.createElement('canvas'); canvases.push(value); return value }
  try {
    const width = image.naturalWidth || 0, height = image.naturalHeight || 0
    if (!wanted() || width <= 0 || height <= 0 || width > 4096 || width * height > GRID_POSTPROCESS_LIMITS.pixels) return
    const sourceCanvas = canvas()
    sourceCanvas.width = width
    sourceCanvas.height = height
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
    if (!sourceContext) return
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

    if (maxX < minX || maxY < minY) {
      const blank = canvas()
      blank.width = CROP_PADDING_X * 2
      blank.height = height
      const encoded = canvasToDataUrl(blank)
      return encoded ? { image: encoded, clipped: false, width: blank.width, height } : undefined
    }

    const clipped = minX <= 1 || minY <= 1 || maxX >= width - 2 || maxY >= height - 2
    const [cropX1, cropX2] = clampCropRange(minX, maxX, width, CROP_PADDING_X)
    // Vertical space belongs to grid-v1's explicit lines, not the ink box.
    // Cropping it would erase a leading blank line and change the shared scale.
    const [cropY1, cropY2] = [0, height - 1]
    const cropWidth = Math.max(1, cropX2 - cropX1 + 1)
    const cropHeight = Math.max(1, cropY2 - cropY1 + 1)

    // If the rendered ink already uses almost the full canvas, keep the source.
    // This avoids lossy re-encoding for fonts whose native renderer did not add
    // large transparent margins. The bounded whole-sample fit still protects the card edge.
    if (cropWidth >= width - 4 && cropHeight >= height - 4) return { image: source, clipped, width, height }

    const targetCanvas = canvas()
    targetCanvas.width = cropWidth
    targetCanvas.height = cropHeight
    const targetContext = targetCanvas.getContext('2d')
    if (!targetContext) return
    targetContext.drawImage(sourceCanvas, cropX1, cropY1, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
    const encoded = canvasToDataUrl(targetCanvas)
    return encoded ? { image: encoded, clipped, width: cropWidth, height: cropHeight } : undefined
  } catch {
    return undefined
  } finally {
    // Decode has settled before releasing the image. Reset canvas backing stores
    // on success, failure and abandonment; synchronous scans cannot be preempted.
    image.removeAttribute('src')
    for (const value of canvases) { value.width = 0; value.height = 0 }
  }
}

export const gridPreviewPostprocess = createGridPreviewPostprocessRuntime(trimGridNativePreviewImage)

export function useGridNativePreviewImageTrim(source?: string): TrimmedPreviewImage | undefined {
  const revision = useSyncExternalStore(gridPreviewPostprocess.subscribe, gridPreviewPostprocess.getSnapshot, gridPreviewPostprocess.getSnapshot)
  const [result, setResult] = useState<{ source: string; value: TrimmedPreviewImage } | undefined>()
  useEffect(() => {
    setResult(previous => previous?.source === source ? previous : undefined)
    if (!source || !isGridNativePreviewImage(source)) return
    return gridPreviewPostprocess.request(source, value => setResult({ source, value }))
  }, [source, revision])
  // Keep an already displayed crop during scroll/close pauses, but never expose
  // a previous font during render before cleanup. Retired jobs cannot publish.
  return result && result.source === source ? result.value : undefined
}
