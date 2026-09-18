import React, { Profiler, StrictMode, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useBrowseDerivedRuntime as before } from 'u08-before'
import { useBrowseDerivedRuntime as after } from '../../src/renderer/src/runtime/app/useBrowseDerivedRuntime'
import { createEmptyLibrary } from '../../src/renderer/src/library-normalize/libraryNormalizeBase'
import { buildFontComputedIndex, buildFontMetrics } from '../../src/renderer/src/fontFilteringMetrics'
import type { BrowseDerivedOptions } from '../../src/renderer/src/runtime/app/useBrowseDerivedRuntime'
import type { FontItem, FontQueryPageResult } from '../../src/shared/types'

const fonts: FontItem[] = Array.from({ length: 1499 }, (_, i): FontItem => ({
  id: `font-${i}`, path: `C:\\Fonts\\Font-${i}.ttf`, fileName: `Font-${i}.ttf`,
  family: `Family ${i}`, fullName: `Family ${i} Regular`, style: 'Regular', format: 'ttf',
  fileSize: 100000 + i, modifiedAt: 1710000000000 + i, favorite: false,
  addedAt: '2024-03-09T00:00:00.000Z', postscriptName: `Fixture-${i}`, collectionIds: [],
  systemInstalled: false, systemInstallMatches: [], active: false, installStatusKnown: true, tagNames: ['共享'], localTagNames: ['本地']
}))
const library = { ...createEmptyLibrary(), fonts: Object.fromEntries(fonts.map(f => [f.id, f])), tags: ['共享'], localTags: ['本地'] }
const metrics = buildFontMetrics(fonts, new Map(fonts.map(f => [f.id, buildFontComputedIndex(f)])), library)
const page: FontQueryPageResult = { items: fonts, total: fonts.length, offset: 0, limit: fonts.length, queryKey: 'u08', engine: 'sql', elapsedMs: 1, truncated: false }
const base: BrowseDerivedOptions = {
  library, sidebarPage: 'library', databasePageReady: true, databasePageResult: page,
  databaseFontMetrics: metrics, allFonts: fonts, activeFilter: { kind: 'all', name: '全部字体' },
  selectedWatchedFolders: [], selectedFormats: [], selectedScripts: [], selectedCategory: 'all',
  selectedTagName: '', selectedSharedTagName: '', selectedFolderId: '', installStatus: 'all',
  timeSortMode: 'created', sortMode: 'nameAsc', deferredSearch: '', expandedFolderIds: {}
}
const roots = createRoot(document.getElementById('root')!)
const status = document.getElementById('status')!
const result = document.getElementById('result')!
const run = document.getElementById('run') as HTMLButtonElement
const strict = document.getElementById('strict') as HTMLInputElement
const frame = () => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('未取得绘制机会，请保持测试页面在前台后重测')), 3000)
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() }))
})
const percentile = (values: number[], p: number) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*p)-1)] || 0
const stats = (values: number[]) => ({ median: +percentile(values, .5).toFixed(3), p95: +percentile(values, .95).toFixed(3) })
const longTasks: { startTime: number; duration: number }[] = []
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push({ startTime: e.startTime, duration: e.duration }) })
if (PerformanceObserver.supportedEntryTypes.includes('longtask')) observer.observe({ entryTypes: ['longtask'] })
let latest: ReturnType<typeof before>
let commitDone: () => void
let durations: number[] = []
function Probe({ hook, options }: { hook: typeof before; options: BrowseDerivedOptions }) {
  latest = hook(options)
  useLayoutEffect(() => { commitDone() })
  return <><p>统计 {latest.fontMetrics.total} / 收藏 {latest.fontMetrics.favoriteCount}</p><div className="rows">{latest.visibleFonts.slice(0, 48).map(f => <div key={f.id}>{f.family} · {options.library.previewText}</div>)}</div></>
}
async function update(hook: typeof before, options: BrowseDerivedOptions, key: string) {
  if (document.visibilityState !== 'visible') throw Error('页面不在前台，本轮结果无效，请重测')
  durations = []
  const startedAt = performance.now()
  await new Promise<void>(resolve => {
    commitDone = resolve
    const tree = <Profiler id="browse" onRender={(_id, _phase, duration) => durations.push(duration)}><Probe key={key} hook={hook} options={options} /></Profiler>
    roots.render(strict.checked ? <StrictMode>{tree}</StrictMode> : tree)
  })
  const commitMs = performance.now() - startedAt
  await frame()
  if (document.visibilityState !== 'visible') throw Error('页面进入后台，本轮结果无效，请重测')
  return { startedAt, endedAt: performance.now(), commitMs, paintOpportunityMs: performance.now() - startedAt, actualMs: durations.reduce((a,b) => a+b, 0), commits: durations.length }
}
run.onclick = async () => {
  run.disabled = strict.disabled = true
  const report: any = { baseline: '08c07c7ecd6b58c6fb24481cef5f8ccaaa173a5a', react: React.version, mode: 'development', strict: strict.checked, userAgent: navigator.userAgent, fonts: fonts.length, warmup: 5, samples: 40, scope: 'actual browse hook + 48 simple DOM rows; no IPC/native rendering', cases: [] }
  try {
    for (const route of ['database', 'frontend']) for (const operation of ['metrics', 'preview-text', 'unrelated-update']) {
      const records: Record<string, any[]> = { before: [], after: [] }
      for (let round = 0; round < 2; round++) for (const name of round ? ['after', 'before'] : ['before', 'after']) {
        const hook = name === 'before' ? before : after
        const key = `${route}-${operation}-${round}-${name}`
        let options = { ...base, databasePageReady: route === 'database' }
        status.textContent = `运行 ${route} / ${operation} / ${name} / ${round + 1}`
        const cold = await update(hook, options, key)
        for (let i = -5; i < 20; i++) {
          const oldIndex = latest.fontIndexById, oldVisible = latest.visibleFonts
          options = operation === 'metrics' ? { ...options, databaseFontMetrics: { ...metrics, favoriteCount: (i + 6) % 2 } }
            : operation === 'preview-text' ? { ...options, library: { ...library, previewText: `预览文字 ${i % 2}` } } : { ...options }
          const sample = await update(hook, options, key)
          if (i >= 0) records[name].push({ ...sample, rebuiltIndex: oldIndex !== latest.fontIndexById, rebuiltVisible: oldVisible !== latest.visibleFonts, coldMountMs: cold.actualMs })
        }
      }
      for (const name of ['before', 'after']) {
        const rows = records[name]
        report.cases.push({ route, operation, version: name, n: rows.length, cache: 'warm after 5 updates', actualMs: stats(rows.map(r => r.actualMs)), requestToCommitMs: stats(rows.map(r => r.commitMs)), requestToPaintOpportunityMs: stats(rows.map(r => r.paintOpportunityMs)), commits: rows.reduce((n,r) => n+r.commits,0), indexRebuilds: rows.filter(r=>r.rebuiltIndex).length, visibleRebuilds: rows.filter(r=>r.rebuiltVisible).length, longTasks: longTasks.filter(t => rows.some(r => t.startTime >= r.startedAt && t.startTime < r.endedAt)), coldMountActualMs: [rows[0].coldMountMs, rows[20].coldMountMs] })
      }
    }
    result.textContent = JSON.stringify(report, null, 2)
    status.textContent = '完成'
  } catch (error) { status.textContent = '失败'; result.textContent = String(error) }
  finally { run.disabled = strict.disabled = false }
}
