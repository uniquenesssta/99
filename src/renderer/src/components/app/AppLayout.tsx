import type { ReactNode } from 'react'
import { useCallback, useRef, useState } from 'react'
import { markLayoutTransitionActive } from '../../runtime/app/windowResizePhaseRuntime'
import { shouldAutoCollapseSidebar,useNarrowWindowAutoSidebarCollapseRuntime } from '../../runtime/app/useNarrowWindowAutoSidebarCollapseRuntime'

type AppLayoutProps = {
  detailVisible: boolean
  renderSidebar: (sidebarCollapsed: boolean, setSidebarCollapsed: (value: boolean) => void) => ReactNode
  children: ReactNode
}

export function AppLayout({ detailVisible, renderSidebar, children }: AppLayoutProps): JSX.Element {
  const userSidebarCollapsedRef = useRef(window.localStorage.getItem('hfm.sidebarCollapsed') === '1')
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() => {
    return userSidebarCollapsedRef.current || shouldAutoCollapseSidebar(window.innerWidth || document.documentElement.clientWidth || 0)
  })
  const autoCollapsedRef = useNarrowWindowAutoSidebarCollapseRuntime({
    setSidebarCollapsedState,
    userSidebarCollapsedRef
  })

  const setSidebarCollapsed = useCallback((value: boolean): void => {
    markLayoutTransitionActive()
    userSidebarCollapsedRef.current = value
    setSidebarCollapsedState(shouldAutoCollapseSidebar(window.innerWidth || document.documentElement.clientWidth || 0) ? true : value)
    autoCollapsedRef.current = shouldAutoCollapseSidebar(window.innerWidth || document.documentElement.clientWidth || 0) && !value
    window.setTimeout(() => {
      window.localStorage.setItem('hfm.sidebarCollapsed', value ? '1' : '0')
    }, 0)
  }, [autoCollapsedRef])

  return (
    <main className={`layout detail-docked-layout hfm-smooth-layout${detailVisible ? '' : ' detail-hidden'}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {renderSidebar(sidebarCollapsed, setSidebarCollapsed)}
      {children}
    </main>
  )
}
