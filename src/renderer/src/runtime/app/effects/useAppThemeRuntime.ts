import { useEffect } from 'react'
import type { ThemeMode } from '../../../appRuntime'
import { setupFloatingScrollbars } from '../../../utils/floatingScrollbars'

export function useAppThemeRuntime(themeMode: ThemeMode): void {
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
    window.localStorage.setItem('hfm.themeMode', themeMode)
  }, [themeMode])

  useEffect(() => setupFloatingScrollbars(), [])
}
