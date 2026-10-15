// Real AppRoot ownership and page navigation, with deterministic IPC receipts.
// The clock replaces only the status poller's 2s/6s timers during its creation.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AppRootView } from '../../../src/renderer/src/components/app/AppRootView'
import { IS_DEVELOPMENT } from '../../../src/renderer/src/appRuntime'
import { buildFontViewLayout } from '../../../src/renderer/src/runtime/app/fontViewLayoutRuntime'

const noop = () => {}, frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const check = (ok: unknown, message: string) => { if (!ok) throw Error('[developer-status] ' + message) }
const normalPages = ['library', 'tags', 'sharedTags', 'folders', 'filters']
const diagnosticText = '文件夹刷新完成：缓存正常，索引新增/更新 0 个、确认文件缺失 0 个、无效索引清理 55 个，复用 4122 个。' + '0123456789abcdef'.repeat(45)
const operationText = '字体操作失败：文件不可用，请检查路径后重试。' + '错误详情与路径0123456789abcdef'.repeat(40)
let current: any, lastEvidence: unknown

function Fixture() {
  const [page, setPage] = useState('library'), [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState(''), node = useRef<HTMLDivElement>(null)
  const library = { fonts: {}, folders: [], folderNodes: [], collections: [], tags: [], localTags: [] }
  const layout = buildFontViewLayout('list', 'comfortable', Math.max(300, innerWidth - 240), 44, 1)
  const sidebar = {
    sidebarPage: page, setSidebarPage: setPage, activeFilter: { kind: 'all' }, setActiveFilter: noop,
    advancedFilterCount: 0, refreshDeveloperStatusDetails: async () => {}, categoryCounts: { all: 0 }, allFonts: [],
    favoriteCount: 0, installedCount: 0, notInstalledCount: 0, activeCount: 0, previewText: 'Aa', setPreviewText: noop,
    installStatusReady: true, installStatusMissingCount: 0, installStatusSyncSuffix: '',
    expandedFilterGroups: {}, setFilterGroupExpanded: noop, selectedWatchedFolders: [], setSelectedWatchedFolders: noop,
    library, folderCounts: {}, selectedFormats: [], setSelectedFormats: noop, formatCounts: {}, selectedScripts: [], setSelectedScripts: noop,
    scriptCounts: {}, selectedCategory: 'all', setSelectedCategory: noop, clearAdvancedFilters: noop,
    newSharedTagName: '', setNewSharedTagName: noop, createSharedTagOnlyFromInput: noop, sharedTagList: [], selectedSharedTagName: '', setSelectedSharedTagName: noop,
    openSharedTagMenu: noop, sharedTagCounts: {}, newTagName: '', setNewTagName: noop, createTagOnlyFromInput: noop, localTagList: [], selectedTagName: '', setSelectedTagName: noop,
    openTagMenu: noop, localTagCounts: {}, addFolder: async () => {}, selectedFolderId: '', setDatabasePageResult: noop, setDatabaseQueryResult: noop,
    setSelectedFolderId: noop, expandedFolderIds: {}, dropHoverFolderId: '', setDropHoverFolderId: noop, selectFolderFilter: noop,
    openFolderMenu: noop, fontIdsFromDropEvent: () => [], assignFontsToFolder: noop, toggleFolderExpanded: noop, flatFolderNodes: [], setDeveloperStatusLog: noop
  }
  const content = {
    sidebarPage: page, installStatus: 'all', timeSortMode: 'none', sortMode: 'nameAsc', viewMode: 'comfortable', cardPoolViewMode: 'list', activeFilter: { kind: 'all' },
    setCardPoolViewMode: noop, listPreviewFontSize: 44, setListPreviewFontSize: noop,
    updatePageToolbar: (key: string, value: string) => { if (key === 'search') setSearch(value) }, updateViewModeWithScroll: noop,
    search, closeDetail: noop, fontScrollerRef: node, handleFontScroll: noop, beginMarqueeSelection: noop,
    virtualLayout: { items: [], totalHeight: 3000, top: 0, columns: 1, startIndex: 0, endIndex: 0 }, viewLayout: layout, renderFontCard: () => null,
    databasePageReady: true, visibleFontTotal: 0, visibleFonts: [], fontFamilyGroupResult: null, fontFamilyGroupLoading: false,
    fontFamilyGroupError: '', expandedFontFamilyIds: [], toggleFontFamilyExpanded: noop
  }
  const developer = {
    IS_DEVELOPMENT, status: diagnosticText, refreshDeveloperStatusDetails: async () => {}, latestIndexProgress: null,
    developerArchitecture: null, developerSchedulerStatus: null, developerMigrationDiagnostics: null,
    developerSharedMetadataDiagnostics: null, setDeveloperSharedMetadataDiagnostics: noop,
    latestBackgroundTaskEvent: null, developerTasks: [], developerStatusLog: []
  }
  current = { page, setPage, setNotice }
  return <AppRootView {...({
    topbar: { themeMode: 'light', setThemeMode: noop, indexingActive: false, cacheMenuOpen: false, setCacheMenuOpen: noop, rescan: async () => {}, cancelIndexing: async () => {}, rebuildScanCache: async () => {}, clearAllCacheAction: async () => {} },
    sidebar, content, developer, detail: { visible: false }, overlays: {},
    operationNotice: { message: notice, onDismiss: () => setNotice(null) }
  } as any)} />
}

async function checkDeveloperStatus() {
  const host = document.getElementById('fixture')!, previousBridge = window.hfm
  const previousSidebar = localStorage.getItem('hfm.sidebarCollapsed')
  const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window)
  const timers = new Map<number, { at: number; callback: () => void }>()
  let now = 0, nextTimer = -1, reads = 0, inFlight = 0, maximumInFlight = 0
  const requests: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
  let root: ReturnType<typeof createRoot> | undefined, failedView: Node[] | undefined
  const base = { rootPath: '\\\\server\\fonts', phase: 'idle', lastCheckedAt: Date.UTC(2026, 9, 12, 8), pendingCount: 0 }
  const card = () => host.querySelector<HTMLElement>('[data-shared-watch-status]')
  const geometry = () => ({ development: IS_DEVELOPMENT, viewport: { width: innerWidth, height: innerHeight }, page: current?.page, reads, inFlight, maximumInFlight,
    nodes: Object.fromEntries(['.app', '.layout', '.font-list-panel', '.font-virtual-scroller', '.developer-status-page', '[data-shared-watch-status]', '.operation-status-notice'].map(selector => {
      const node = host.querySelector<HTMLElement>(selector)
      return [selector, node ? { rect: node.getBoundingClientRect().toJSON(), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth } : null]
    })), text: card()?.textContent })
  const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); await frame(); await frame() }
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at; timers.delete(due[0]); due[1].callback()
      await settle()
    }
    now = until; await settle()
  }
  const respond = async (value: unknown) => { check(requests.length > 0, 'no held IPC to answer'); requests.shift()!.resolve(value); await settle() }
  const nextResponse = async (value: unknown) => { await advance(2000); await respond(value) }
  const assertShell = () => {
    check(!host.querySelector('footer, .statusbar, .selection-command-status'), 'removed status row/footer leaked into AppRoot')
    const app = host.querySelector<HTMLElement>('.app')!, layout = host.querySelector<HTMLElement>('.layout')!
    const box = layout.getBoundingClientRect(), appBox = app.getBoundingClientRect()
    check(Math.abs(box.bottom - appBox.bottom) <= 1, 'removed footer left a bottom layout gap: ' + JSON.stringify(geometry()))
    for (const selector of ['.app', '.layout', '.font-list-panel', '.developer-status-page', '[data-shared-watch-status]', '.operation-status-notice']) {
      const element = host.querySelector<HTMLElement>(selector)
      if (!element) continue
      const bounds = element.getBoundingClientRect()
      check(bounds.left >= -1 && bounds.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1, selector + ' overflowed with long status: ' + JSON.stringify(geometry()))
    }
  }
  const assertNormal = () => {
    assertShell()
    check(!card() && !host.querySelector('.developer-status-page'), 'ordinary page exposed developer/NAS status')
    check(!host.textContent?.includes(diagnosticText), 'ordinary page exposed the current diagnostic status')
    check(!!host.querySelector('.font-virtual-scroller'), 'ordinary list lost its scroller')
  }
  const navigate = async (page: string) => {
    // Use the actual sidebar button, including the collapsed rail at 720px.
    const labels: Record<string, string> = { library: '库：', tags: '标签：', sharedTags: '共享标签：', folders: '文件夹：', filters: '筛选：', developer: '开发者状态：' }
    const button = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find(node => node.getAttribute('aria-label')?.startsWith(labels[page]))
    check(button, 'real sidebar page control missing: ' + page)
    flushSync(() => button!.click()); await settle()
    check(current.page === page, 'sidebar navigation did not reach ' + page)
  }
  try {
    localStorage.setItem('hfm.sidebarCollapsed', '0')
    ;(window as any).hfm = { getSharedWatchStatus: () => {
      reads++; inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight)
      return new Promise((resolve, reject) => requests.push({ resolve, reject })).finally(() => { inFlight-- })
    } }
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback === 'function' && (delay === 2000 || delay === 6000)) {
        const id = nextTimer--; timers.set(id, { at: now + delay, callback: () => callback(...args) }); return id
      }
      return nativeSet(callback, delay, ...args)
    }) as typeof window.setTimeout
    window.clearTimeout = ((id?: number) => { if (id !== undefined && timers.has(id)) timers.delete(id); else nativeClear(id) }) as typeof window.clearTimeout
    root = createRoot(host)
    flushSync(() => root!.render(<Fixture />))
    window.setTimeout = nativeSet; window.clearTimeout = nativeClear
    await settle()
    check(reads === 1 && inFlight === 1, 'App did not start exactly one shared status owner')
    assertNormal()
    // Held read must survive both ordinary and developer navigation; the App
    // stays mounted throughout, including beyond the poller's deadline.
    for (let n = 0; n < 3; n++) {
      for (const page of normalPages) { await navigate(page); assertNormal() }
      if (IS_DEVELOPMENT) { await navigate('developer'); check(card()?.textContent?.includes('状态待确认'), 'initial unknown status missing'); assertShell() }
    }
    await advance(600000)
    check(reads === 1 && maximumInFlight === 1 && inFlight === 1, 'page navigation or deadline overlapped held status IPC')
    await respond({ roots: [base] }) // Expired result must not publish.
    if (IS_DEVELOPMENT) check(card()?.textContent?.includes('状态待确认'), 'expired IPC published stale success')
    const receipts: [unknown, string][] = [
      [{ roots: [{ ...base, phase: 'checking', lastCheckedAt: null, pendingCount: null }] }, '正在检查'],
      [{ roots: [{ ...base, phase: 'applying', pendingCount: 12 }] }, '正在处理：12 项'],
      [{ roots: [base] }, '正在处理：0 项'],
      [{ roots: [{ ...base, phase: 'offline', pendingCount: null }] }, '离线'],
      [{ roots: [{ ...base, phase: 'error', pendingCount: null }] }, '检查异常'],
      [{ roots: [{ ...base, phase: 'stopped', pendingCount: null }] }, '已暂停'],
      [{ roots: 'invalid' }, '状态待确认'],
      [{ roots: [] }, '当前没有共享监听位置']
    ]
    for (const [receipt, label] of receipts) {
      await nextResponse(receipt)
      if (IS_DEVELOPMENT) {
        check(card()?.textContent?.includes(label), 'developer card lost phase: ' + label)
        check(host.querySelector('.developer-status-page')?.textContent?.includes(diagnosticText), 'developer page lost full current status')
        assertShell()
      }
      for (const page of normalPages) { await navigate(page); assertNormal() }
      if (IS_DEVELOPMENT) await navigate('developer')
    }
    await advance(2000); requests.shift()!.reject(Error('IPC unavailable')); await settle()
    if (IS_DEVELOPMENT) check(card()?.textContent?.includes('状态待确认'), 'rejected IPC retained success')
    const longPath = '\\\\server\\' + 'nested-folder-'.repeat(60)
    await nextResponse({ roots: Array.from({ length: 10 }, (_, index) => ({ ...base, rootPath: `${longPath}${index}`, phase: index % 2 ? 'offline' : 'applying', pendingCount: index % 2 ? null : 2 })) })
    if (IS_DEVELOPMENT) {
      check(card()?.textContent?.includes('目录检查和索引应用全部确认后更新'), 'ACK semantics lost from visible NAS detail')
      check(card()?.querySelector('pre'), 'NAS details are only a tooltip')
      assertShell()
    }
    await navigate('library'); assertNormal()
    check(!host.querySelector('.operation-status-notice'), 'background diagnostic triggered operation notification')
    flushSync(() => current.setNotice(operationText)); await settle()
    check(host.querySelector('.operation-status-notice')?.textContent?.includes(operationText), 'ordinary page lost operation feedback')
    const noticeStyle = getComputedStyle(host.querySelector<HTMLElement>('.operation-status-notice')!)
    check(noticeStyle.backgroundColor !== 'transparent' && !/^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(noticeStyle.backgroundColor), 'operation feedback background is transparent')
    check(noticeStyle.boxShadow !== 'none' && noticeStyle.boxShadow.length > 0, 'operation feedback lost its separating shadow')
    assertNormal()
    if (IS_DEVELOPMENT) { await navigate('developer'); check(host.querySelector('.operation-status-notice')?.textContent?.includes(operationText), 'navigation lost operation feedback'); assertShell() }
    const dismiss = host.querySelector<HTMLButtonElement>('[aria-label="关闭操作反馈"]')!
    check(dismiss, 'operation notice has no accessible dismissal')
    const dismissBox = dismiss.getBoundingClientRect()
    check(dismiss.contains(document.elementFromPoint(dismissBox.x + dismissBox.width / 2, dismissBox.y + dismissBox.height / 2)), 'long operation receipt covered its dismiss control')
    flushSync(() => dismiss.click()); await settle()
    check(!host.querySelector('.operation-status-notice'), 'operation notice did not dismiss')
    if (!IS_DEVELOPMENT) {
      check(![...host.querySelectorAll('button[aria-label]')].some(node => node.getAttribute('aria-label')?.startsWith('开发者状态：')), 'production exposed the developer navigation')
      flushSync(() => current.setPage('developer')); await settle(); assertNormal()
    }
    check(maximumInFlight === 1, 'status owner exceeded one in-flight IPC')
    const evidence = geometry(), settledReads = reads
    const screenshotView = Array.from(host.childNodes, node => node.cloneNode(true))
    flushSync(() => root!.unmount()); root = undefined
    await advance(600000)
    check(reads === settledReads && timers.size === 0 && inFlight === 0, 'unmounted App retained polling')
    check(localStorage.getItem('hfm.sidebarCollapsed') === '0', 'status navigation mutated persisted sidebar preference')
    // Retain only static pixels after verifying React/poller cleanup.
    host.replaceChildren(...screenshotView)
    return { ...evidence, heldIpc: true, phases: receipts.length, allOrdinaryPages: normalPages, operationNotice: true, dismissed: true, cleanup: true }
  } catch (error) {
    lastEvidence = geometry(); failedView = Array.from(host.childNodes, node => node.cloneNode(true)); throw error
  } finally {
    window.setTimeout = nativeSet; window.clearTimeout = nativeClear
    if (root) flushSync(() => root!.unmount())
    for (const request of requests) request.resolve({ roots: [] })
    await Promise.resolve()
    window.hfm = previousBridge
    if (previousSidebar === null) localStorage.removeItem('hfm.sidebarCollapsed'); else localStorage.setItem('hfm.sidebarCollapsed', previousSidebar)
    if (failedView) host.replaceChildren(...failedView)
  }
}
;(window as any)[IS_DEVELOPMENT ? 'checkDeveloperStatusDevelopment' : 'checkDeveloperStatusProduction'] = checkDeveloperStatus
;(window as any)[IS_DEVELOPMENT ? 'developerStatusDevelopmentEvidence' : 'developerStatusProductionEvidence'] = () => lastEvidence
