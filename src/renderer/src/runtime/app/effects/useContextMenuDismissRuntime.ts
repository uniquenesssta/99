import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ContextMenuState } from '../../../appRuntime'

export function useContextMenuDismissRuntime(setContextMenu: Dispatch<SetStateAction<ContextMenuState>>): void {
  useEffect(() => {
    const closeContextMenu = (): void => setContextMenu(null)
    window.addEventListener('click', closeContextMenu)
    window.addEventListener('blur', closeContextMenu)
    return () => {
      window.removeEventListener('click', closeContextMenu)
      window.removeEventListener('blur', closeContextMenu)
    }
  }, [])
}
