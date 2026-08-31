import { useEffect,useRef,useState } from 'react'
import { isWindowResizeActive,subscribeWindowResizeSettled } from '../app/windowResizePhaseRuntime'

export type ResizeFrozenPreviewValue = {
  previewFamily?: string
  previewImage?: string
  previewText?: string
  listPreviewFontSize?: number
}

function samePreviewValue(a: ResizeFrozenPreviewValue, b: ResizeFrozenPreviewValue): boolean {
  return a.previewFamily === b.previewFamily &&
    a.previewImage === b.previewImage &&
    a.previewText === b.previewText &&
    a.listPreviewFontSize === b.listPreviewFontSize
}

/**
 * Keep card preview DOM stable while the user is dragging the window size.
 *
 * Preview images / FontFace families can arrive during resize. Applying them
 * immediately makes every visible card mutate its preview subtree while CSS grid,
 * virtual viewport and detail docking are also recalculating. On slower GPUs this
 * turns a simple resize into layout + paint + image decode work. The card still
 * renders its shell/selection state, but the expensive preview subtree keeps the
 * last settled value until resize finishes, then applies the newest value once.
 */
export function useResizeFrozenPreviewRuntime(identityKey: string, value: ResizeFrozenPreviewValue): ResizeFrozenPreviewValue {
  const latestRef = useRef(value)
  const identityRef = useRef(identityKey)
  const [frozenValue,setFrozenValue] = useState(value)

  latestRef.current = value

  useEffect(() => {
    if (identityRef.current !== identityKey) {
      identityRef.current = identityKey
      setFrozenValue(value)
      return
    }

    if (isWindowResizeActive()) return
    setFrozenValue((current) => samePreviewValue(current, value) ? current : value)
  }, [identityKey, value.previewFamily, value.previewImage, value.previewText, value.listPreviewFontSize])

  useEffect(() => {
    return subscribeWindowResizeSettled(() => {
      setFrozenValue((current) => samePreviewValue(current, latestRef.current) ? current : latestRef.current)
    })
  }, [])

  return isWindowResizeActive() ? frozenValue : value
}
