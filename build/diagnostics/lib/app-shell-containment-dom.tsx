// Real shell, toolbar, cards and footer. Only backend receipts and sidebar /
// detail contents are fixtures; the production layout owns every measured box.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AppTopbar } from '../../../src/renderer/src/components/app/AppTopbar'
import { AppLayout } from '../../../src/renderer/src/components/app/AppLayout'
import { FontListPanel } from '../../../src/renderer/src/components/app/FontListPanel'
import { FontCard } from '../../../src/renderer/src/components/FontCard'
import { SharedWatchStatusBar } from '../../../src/renderer/src/components/app/SharedWatchStatusBar'
import { buildFontViewLayout } from '../../../src/renderer/src/runtime/app/fontViewLayoutRuntime'
import { buildVirtualLayout } from '../../../src/renderer/src/fontViewRuntime'
import { useFontViewportResizeObserverRuntime } from '../../../src/renderer/src/runtime/app/effects/useFontViewportResizeObserverRuntime'
import { setupFloatingScrollbars } from '../../../src/renderer/src/utils/floatingScrollbars'

const refreshStatus = '文件夹刷新完成：缓存正常，索引新增/更新 0 个、确认文件缺失 0 个、无效索引清理 55 个、重新解析 0 个（元数据修复 0 个），复用 4122 个，用时 4 秒。'
const fonts = Array.from({ length: 100 }, (_, i) => ({ id: `shell-${i}`, path: `C:/fonts/shell-${i}.ttf`, fileName: `Font ${i}.ttf`, family: 'Arial', fullName: `Font ${i}`, format: 'ttf', tagNames: [], scripts: ['latin'], systemInstalled: true, installStatusKnown: true })) as any
const noop = () => {}, frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const check = (ok: unknown, message: string) => { if (!ok) throw Error('[app-shell] ' + message) }
type Scenario = { mode: 'list' | 'grid'; detail: boolean; developer: boolean; stress?: boolean; indexing?: boolean }
let root: ReturnType<typeof createRoot> | undefined, current: any, scenario: Scenario
let previousBridge: typeof window.hfm, sidebarPreference: string | null
let cleanupScrollbars: (() => void) | undefined, originalCss: string, style: HTMLStyleElement
let actions: string[] = [], trustedClicks: string[] = [], lastEvidence: unknown
let nativeBusyGeometry: unknown
const host = () => document.getElementById('fixture')!
const select = (selector: string) => host().querySelector<HTMLElement>(selector)!
const point = (node: Element) => { const box = node.getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } }

function Fixture(props: Scenario) {
  const node = useRef<HTMLDivElement>(null), [search, setSearch] = useState('')
  const [indexingActive, setIndexingActive] = useState(Boolean(props.indexing))
  const [viewport, setViewport] = useState({ width: innerWidth - 240, height: 520, scrollTop: 0 })
  useFontViewportResizeObserverRuntime({ fontScrollerRef: node, viewportKey: props.mode, detailVisible: props.detail, setVirtualViewport: setViewport })
  const layout = buildFontViewLayout(props.mode, 'comfortable', viewport.width, 47, 2)
  const virtual = buildVirtualLayout({ ...layout, visibleFonts: fonts, virtualViewport: viewport, databasePageReady: true, databasePageResult: { offset: 0, total: 5491, items: fonts } as any })
  const status = (indexingActive ? '正在刷新文件夹索引，正在复用已有缓存。' : refreshStatus) + (props.stress ? ' [refresh-receipt:' + '0123456789abcdef'.repeat(40) + ']' : '')
  current = { node, viewport, search, status, indexingActive, setIndexingActive }
  return <div className="app" onClickCapture={event => { if (event.isTrusted) trustedClicks.push((event.target as HTMLElement).className) }}>
    <AppTopbar themeMode="light" setThemeMode={noop} indexingActive={indexingActive} cacheMenuOpen={false} setCacheMenuOpen={noop} rescan={async () => { actions.push('refresh') }} cancelIndexing={async () => { actions.push('cancel'); setIndexingActive(false) }} rebuildScanCache={async () => {}} clearAllCacheAction={async () => {}} />
    <AppLayout detailVisible={props.detail} renderSidebar={collapsed => <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}><div className="sidebar-body"><div className="sidebar-identity-card">字体资产 5491</div><button className="nav active">全部字体 <span>5491</span></button></div></aside>}>
      <FontListPanel {...({ sidebarPage: 'library', activeFilter: { kind: 'all' }, status, search, installStatus: 'all', sortMode: 'nameAsc', viewMode: 'comfortable', cardPoolViewMode: props.mode, listPreviewFontSize: 47, fontScrollerRef: node,
        updatePageToolbar: (key: string, value: string) => { if (key === 'search') setSearch(value) }, setCardPoolViewMode: noop, setListPreviewFontSize: noop,
        visibleFonts: fonts, visibleFontTotal: 5491, databasePageReady: true, virtualLayout: virtual, viewLayout: layout, closeDetail: noop, beginMarqueeSelection: noop,
        handleFontScroll: (event: any) => { const scrollTop = event.currentTarget.scrollTop; setViewport(value => ({ ...value, scrollTop })) },
        renderFontCard: (font: any, compact: boolean) => <FontCard key={font.id} font={font} compact={compact} previewFamily="Arial" previewText={'中文字体预览 字体管理器\nAaBbCc 0123456789'} listPreviewFontSize={47} onVisible={noop} onSelect={noop} />
      } as any)} />
      {props.detail && <section className="detail-panel detail-dock-panel"><div className="detail-header">字体详情</div><button>关闭详情</button></section>}
    </AppLayout>
    <SharedWatchStatusBar developerStatus={props.developer ? status : undefined} />
  </div>
}

function geometry() {
  const selectors = ['.app', '.topbar', '.topbar-right', '.window-controls', '.window-close', '.cache-split', '.layout', '.font-list-panel', '.font-command-header', '.list-toolbar', '.search-input', '.font-virtual-scroller', '.font-card', '.detail-dock-panel', '.statusbar']
  return { viewport: { width: innerWidth, height: innerHeight }, scenario: { ...scenario, indexing: current?.indexingActive }, nodes: Object.fromEntries(selectors.map(selector => {
    const node = select(selector)
    if (!node) return [selector, null]
    const computed = getComputedStyle(node)
    return [selector, { rect: node.getBoundingClientRect().toJSON(), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, minWidth: computed.minWidth, gridTemplateColumns: computed.gridTemplateColumns, overflowX: computed.overflowX }]
  })), footer: select('.statusbar')?.textContent, search: current?.search, actions: actions.slice(), trustedClicks: trustedClicks.slice() }
}
;(window as any).appShellContainmentEvidence = () => lastEvidence || geometry()

async function settle() {
  for (let n = 0; n < 60; n++) {
    await wait(20)
    if (!document.documentElement.hasAttribute('data-hfm-layout-transitioning') && !document.documentElement.hasAttribute('data-hfm-window-resizing') && current.node.current?.clientWidth === current.viewport.width) break
  }
  await frame(); await frame()
  check(current.node.current?.clientWidth === current.viewport.width, 'virtual viewport did not converge to production scroller')
}
async function mount(next: Scenario) {
  cleanupScrollbars?.(); cleanupScrollbars = undefined
  if (root) flushSync(() => root!.unmount())
  scenario = next; root = createRoot(host())
  flushSync(() => root!.render(<Fixture {...next} />))
  await settle()
}
function assertBounds() {
  for (const selector of ['.app', '.topbar', '.topbar-right', '.window-controls', '.cache-split', '.layout', '.font-list-panel', '.font-command-header', '.list-toolbar', '.search-input', '.font-virtual-scroller', '.statusbar']) {
    const node = select(selector), box = node.getBoundingClientRect()
    check(box.left >= -1 && box.right <= innerWidth + 1, selector + ' outside viewport: ' + JSON.stringify(geometry()))
    check(node.scrollWidth <= node.clientWidth + 1, selector + ' has concealed horizontal overflow: ' + JSON.stringify(geometry()))
  }
  const footer = select('.statusbar'), box = footer.getBoundingClientRect()
  check(Math.abs(box.height - 30) <= 1 && Math.abs(box.bottom - innerHeight) <= 1, 'footer changed its existing visible row')
  check(footer.textContent?.includes('正在处理：0 项'), 'fixture omitted simultaneous NAS status')
  if (scenario.developer) check(footer.lastElementChild?.getAttribute('title') === current.status, 'truncated developer text lost full title')
  else check(footer.children.length === 1, 'production footer exposed developer text')
  for (const selector of ['.window-minimize', '.window-maximize', '.window-close', '.search-input']) {
    const node = select(selector), p = point(node)
    check(node.contains(document.elementFromPoint(p.x, p.y)), selector + ' is unreachable at its actual location')
  }
  for (const node of host().querySelectorAll<HTMLButtonElement>('.cache-split button')) {
    const p = point(node)
    check(node.contains(document.elementFromPoint(p.x, p.y)), node.textContent + ' index control is clipped or covered')
  }
  const input = select('.search-input'), edge = input.getBoundingClientRect()
  check(document.elementFromPoint(edge.right - 8, edge.y + edge.height / 2) === input, 'search right edge is clipped or covered')
  const card = select('.font-card')?.getBoundingClientRect(), scroller = select('.font-virtual-scroller').getBoundingClientRect()
  check(card && card.right <= scroller.right + 1 && card.left >= scroller.left - 1, 'production card escapes scroller')
  if (scenario.detail) {
    const detail = select('.detail-dock-panel').getBoundingClientRect()
    check(detail.left >= 0 && detail.right <= innerWidth + 1, 'detail dock escapes viewport')
  }
}

;(window as any).checkAppShellContainment = async () => {
  previousBridge = window.hfm; sidebarPreference = localStorage.getItem('hfm.sidebarCollapsed')
  localStorage.setItem('hfm.sidebarCollapsed', '0')
  style = document.querySelector('style')!; originalCss = style.textContent!
  actions = []; trustedClicks = []; lastEvidence = undefined
  ;(window as any).hfm = {
    getSharedWatchStatus: async () => ({ roots: [1, 2].map(index => ({ rootPath: `\\\\fixture\\fonts-${index}`, phase: 'idle', lastCheckedAt: Date.UTC(2026, 9, 13, 8, 21, 49), pendingCount: 0 })) }),
    windowMinimize: async () => { actions.push('minimize') }, windowToggleMaximize: async () => { actions.push('maximize') }, windowClose: async () => { actions.push('close') }
  }
  const cases = [], busyTransitions = []
  try {
    for (const mode of ['list', 'grid'] as const) for (const detail of [false, true]) for (const developer of [false, true]) {
      await mount({ mode, detail, developer }); assertBounds(); cases.push(geometry())
    }
    // The real BrowserWindow minimum is 980px (windowRuntime.ts). Keep 720px
    // as the existing defensive gate; cover the added cancel button and the
    // busy-to-completed status transition at supported screenshot/wide sizes.
    if (innerWidth >= 980) for (const detail of [false, true]) {
      await mount({ mode: 'list', detail, developer: true, indexing: true }); assertBounds()
      check(host().querySelectorAll('.cache-primary-button').length === 2, 'busy header omitted cancel-index control')
      const busy = geometry()
      flushSync(() => current.setIndexingActive(false))
      await settle(); assertBounds()
      check(host().querySelectorAll('.cache-primary-button').length === 1 && current.status === refreshStatus, 'same-mounted refresh completion did not restore long status')
      busyTransitions.push({ busy, completed: geometry() })
    }
    // Record the reported text separately from the adversarial long receipt.
    // Font metrics can differ between Windows installations, so expose the
    // exact-case result instead of substituting a stress-only causal claim.
    await mount({ mode: 'list', detail: false, developer: true })
    style.textContent = (window as any).appShellOriginalCss
    await settle()
    const exactOriginal = geometry(), exactFooter = select('.statusbar').getBoundingClientRect(), exactTopbar = select('.topbar').getBoundingClientRect()
    const exactOriginalReproduced = exactFooter.right > innerWidth + 1 && exactTopbar.right > innerWidth + 1 && Math.abs(exactFooter.width - exactTopbar.width) < 2
    style.textContent = originalCss
    await settle(); assertBounds()
    await mount({ mode: 'list', detail: false, developer: true, stress: true }); assertBounds()
    const stress = geometry()
    // Same mounted production tree and receipts, with only the two repaired
    // source declarations removed. A specific joint header/footer expansion
    // proves this gate rejects the original cause, not an incidental exception.
    style.textContent = (window as any).appShellOriginalCss
    await settle()
    const mutant = geometry(), footer = select('.statusbar').getBoundingClientRect(), topbar = select('.topbar').getBoundingClientRect()
    check(footer.right > innerWidth + 20 && topbar.right > innerWidth + 20 && Math.abs(footer.width - topbar.width) < 2, 'original CSS failed to reproduce shared shell-track expansion: ' + JSON.stringify(mutant))
    style.textContent = originalCss
    await settle(); assertBounds()
    await mount({ mode: 'list', detail: false, developer: true }); assertBounds()
    cleanupScrollbars = setupFloatingScrollbars()
    return { cases, busyTransitions, exactOriginal, exactOriginalReproduced, stress, mutant, originalSourceRejected: true, screenshot: geometry() }
  } catch (error) { lastEvidence = geometry(); throw error }
}
;(window as any).appShellOriginalPixels = async (enabled: boolean) => {
  // Keep the same exact-text tree mounted for an honest before/after capture.
  style.textContent = enabled ? (window as any).appShellOriginalCss : originalCss
  await settle()
  if (!enabled) assertBounds()
  return geometry()
}
;(window as any).appShellNativeTargets = () => ({
  minimize: point(select('.window-minimize')), maximize: point(select('.window-maximize')),
  close: point(select('.window-close')), search: point(select('.search-input'))
})
;(window as any).prepareAppShellBusyCancel = async () => {
  flushSync(() => current.setIndexingActive(true))
  await settle(); assertBounds()
  const cancel = [...host().querySelectorAll<HTMLButtonElement>('.cache-primary-button')].find(node => node.textContent === '取消索引')!
  check(cancel && !cancel.disabled, 'busy header has no enabled cancel-index control')
  nativeBusyGeometry = geometry()
  return point(cancel)
}
;(window as any).finishAppShellBusyCancel = async () => {
  await settle(); assertBounds()
  check(actions.filter(action => action === 'cancel').length === 1 && trustedClicks.some(value => value.includes('cache-primary-button')), 'native cancel-index input did not reach production header')
  check(!current.indexingActive && current.status === refreshStatus, 'cancel callback did not settle same-mounted header and long status')
  return { busy: nativeBusyGeometry, completed: geometry(), nativeCancel: true }
}
;(window as any).checkAppShellNativeAction = async (action: string) => {
  await frame(); await frame()
  check(actions.filter(value => value === action).length === 1 && trustedClicks.some(value => value.includes('window-' + action)), 'native window control missed: ' + action)
  return geometry()
}
;(window as any).checkAppShellSearch = async (text: string) => {
  await wait(220); await frame()
  check(current.search === text && (select('.search-input') as HTMLInputElement).value === text, 'native search typing did not reach production input')
  assertBounds()
  return point(select('.font-virtual-scroller'))
}
;(window as any).appShellScrollbarTarget = async () => {
  await frame(); await frame(); await frame()
  const bounds = select('.font-virtual-scroller').getBoundingClientRect()
  const bar = [...document.querySelectorAll<HTMLElement>('.hfm-floating-scrollbar.vertical.visible')].find(node => Math.abs(node.getBoundingClientRect().right - (bounds.right - 3)) < 2)!
  check(bar, 'production right-edge scrollbar is missing')
  const p = point(bar.firstElementChild!), rect = bar.getBoundingClientRect()
  check(bar.contains(document.elementFromPoint(p.x, p.y)) && rect.right <= innerWidth, 'right-edge scrollbar cannot receive native input')
  return { ...p, endY: Math.round(rect.bottom - 2) }
}
;(window as any).finishAppShellContainment = async () => {
  await frame(); await frame()
  check(select('.font-virtual-scroller').scrollTop > 10000, 'native right-edge scrollbar drag did not navigate the real list')
  const result = geometry()
  cleanupScrollbars?.(); cleanupScrollbars = undefined
  flushSync(() => root!.unmount()); root = undefined
  window.hfm = previousBridge
  if (sidebarPreference === null) localStorage.removeItem('hfm.sidebarCollapsed'); else localStorage.setItem('hfm.sidebarCollapsed', sidebarPreference)
  check(!document.querySelector('.hfm-floating-scrollbar'), 'shell fixture leaked scrollbar owners')
  return { ...result, nativeControls: true, nativeSearch: true, nativeScrollbar: true, cleanup: true }
}
