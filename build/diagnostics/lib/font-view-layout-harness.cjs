const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const root = path.resolve(__dirname, '../../..'), prefix = 'src/renderer/src/'
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
function loader({ hooks = require('react'), overrides = {}, globals = {} } = {}) {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file)
    const name = path.basename(file, path.extname(file))
    // Only unrelated panels, preview services and filtering are replaced. Card,
    // list panel, geometry, virtualization, scroll and selection are real sources.
    if (['FontCleanupPanel', 'SharedMetadataMaintenancePanel', 'SharedIndexSnapshotMaintenancePanel'].includes(name)) return { [name]: () => null }
    if (name === 'FontListToolbarControls') return Object.fromEntries(['InstallStatusControl', 'NameSortCycleButton', 'CardPoolViewToggle', 'ListPreviewSizeControl'].map(key => [key, () => null]))
    if (name === 'appConstants') return load(prefix + 'constants/layoutConstants.ts')
    if (name === 'appRuntime') return { ...load(prefix + 'constants/layoutConstants.ts'), ...load(prefix + 'fontDisplay.ts'), IS_DEVELOPMENT: false, scriptLabels: font => font.scripts || [] }
    if (['fontFilteringMetrics', 'fontSort', 'libraryNormalize', 'fontTagStateAuthorityRuntime'].includes(name)) return {}
    if (name === 'sharedAvailabilityRuntime') return { useSharedAvailability: () => null }
    if (name === 'previewTraceRuntime') return { previewTrace: () => null, previewEvent: () => {}, previewImageTrace: () => null, previewTraceEnabled: () => false }
    if (name === 'useResizeFrozenPreviewRuntime') return { useResizeFrozenPreviewRuntime: (_id, preview) => preview }
    if (name === 'gridNativePreviewImageTrimRuntime') return { useGridNativePreviewImageTrim: src => src }
    if (name === 'gridPreviewVisualFitRuntime') return { useGridPreviewVisualFitText: text => ({ fittedText: text, visualFitRef: null, visualFitActive: false }) }
    if (name === 'windowResizePhaseRuntime') return { markWindowResizeActive() {}, isWindowResizeActive: () => false, subscribeWindowResizeSettled: () => () => {} }
    const exports = {}; cache.set(file, exports)
    const output = ts.transpileModule(overrides[file] ?? read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const req = id => {
      if (id === 'react') return hooks
      if (id === 'react/jsx-runtime') return require(id)
      const base = id.startsWith('@shared/') ? 'src/shared/' + id.slice(8) : path.posix.normalize(path.posix.join(path.posix.dirname(file), id))
      const resolved = [base, base + '.ts', base + '.tsx'].find(p => fs.existsSync(path.join(root, p)))
      if (!resolved) throw Error('Unresolved test import: ' + id + ' from ' + file)
      return load(resolved)
    }
    vm.runInNewContext('(function(require,exports){' + output + '\n})', { console, performance, ...globals })(req, exports)
    return exports
  }
  return load
}
function css(file = prefix + 'styles.css', source = read) {
  return source(file).replace(/@import\s+["']([^"']+)["'];/g, (_match, target) => css(path.posix.join(path.posix.dirname(file), target), source))
}
const fonts = Array.from({ length: 1003 }, (_, i) => ({ id: `f${i}`, path: `C:/fonts/f${i}.ttf`, fileName: `Font ${i}.ttf`, family: `测试字体 ${i}`, fullName: `Font ${i} Regular`, postscriptName: `Font${i}-Regular`, format: 'ttf', fileSize: 12000, tagNames: ['测试'], scripts: ['latin'], installStatusKnown: true }))
function renderCase(load, { mode, density, width, size = 44, lines = 2, scrollTop = 0, offset = 0, total = fonts.length, previewText: suppliedPreviewText, previewImage }) {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server')
  const layout = load(prefix + 'runtime/app/fontViewLayoutRuntime.ts').buildFontViewLayout(mode, density, width, size, lines)
  const visibleFonts = offset ? fonts.slice(offset, offset + 100) : fonts.slice(0, total)
  const virtual = load(prefix + 'fontViewRuntime.ts').buildVirtualLayout({ ...layout, visibleFonts, databasePageReady: !!offset, databasePageResult: offset ? { offset, total, items: visibleFonts } : null, virtualViewport: { width, height: 520, scrollTop } })
  const { FontCard } = load(prefix + 'components/FontCard.tsx'), { FontListPanel } = load(prefix + 'components/app/FontListPanel.tsx')
  const previewText = suppliedPreviewText ?? (lines === 1 ? '测试字体 AaBb' : '测试字体\nAaBb 123'), noop = () => {}
  const html = renderToStaticMarkup(React.createElement(FontListPanel, {
    sidebarPage: 'library', activeFilter: { kind: 'all' }, status: '', search: '', installStatus: 'all', viewMode: density, cardPoolViewMode: mode,
    listPreviewFontSize: size, fontScrollerRef: { current: null }, updatePageToolbar: noop, visibleFonts, visibleFontTotal: total, databasePageReady: !!offset,
    virtualLayout: virtual, viewLayout: layout,
    fontFamilyGroupResult: { groups: [{ id: 'family', name: '测试家族', styles: ['Regular', 'Bold'], fonts: fonts.slice(0, 2), primaryFont: fonts[0] }] }, expandedFontFamilyIds: { family: true }, toggleFontFamilyExpanded: noop,
    renderFontCard: (font, compact) => React.createElement(FontCard, { key: font.id, font, compact, previewText, previewImage, listPreviewFontSize: size, onVisible: noop, onSelect: noop })
  }))
  return { html, layout, virtual: { ...virtual, items: virtual.items.map(font => font.id) }, width, scrollTop, offset, total, label: `${mode}/${density}/${width}/${size}/${lines}/${scrollTop}/${offset}` }
}
module.exports = { root, prefix, read, loader, css, fonts, renderCase }
