import type { FontItem } from '@shared/types'
import type { CSSProperties,MouseEvent } from 'react'
import {
IS_DEVELOPMENT,
stringifyDeveloperValue
} from '../../appRuntime'
import { effectiveCardPoolViewMode as resolveEffectiveCardPoolViewMode, isFontFamilyViewAllowed } from '../../runtime/app/cardPoolViewModePolicyRuntime'
import { FontFamilyGroupPanel } from './FontFamilyGroupPanel'
import { SharedMetadataMaintenancePanel } from './SharedMetadataMaintenancePanel'
import { SharedIndexSnapshotMaintenancePanel } from './SharedIndexSnapshotMaintenancePanel'
import type { FontListPanelProps } from './FontListPanelTypes'
import { CardPoolViewToggle,ListPreviewSizeControl,NameSortCycleButton } from './FontListToolbarControls'

export function FontListPanel({
  sidebarPage,
  refreshDeveloperStatusDetails,
  status,
  latestIndexProgress,
  developerArchitecture,
  developerSchedulerStatus,
  developerMigrationDiagnostics,
  developerSharedMetadataDiagnostics,
  setDeveloperSharedMetadataDiagnostics,
  latestBackgroundTaskEvent,
  developerTasks,
  developerStatusLog,
  timeSortMode,
  sortMode,
  viewMode,
  cardPoolViewMode,
  activeFilter,
  setCardPoolViewMode,
  listPreviewFontSize,
  setListPreviewFontSize,
  updatePageToolbar,
  updateViewModeWithScroll,
  search,
  selectedFontIds,
  library,
  activateFontsBatch,
  deactivateFontsBatch,
  deleteFontsBatch,
  uninstallFontsBatch,
  toggleFontDeleteProtection,
  setSelectedFontIds,
  closeDetail,
  fontScrollerRef,
  handleFontScroll,
  beginMarqueeSelection,
  virtualLayout,
  viewLayout,
  renderFontCard,
  databasePageReady,
  visibleFontTotal,
  visibleFonts,
  fontFamilyGroupResult,
  fontFamilyGroupLoading,
  fontFamilyGroupError,
  expandedFontFamilyIds,
  toggleFontFamilyExpanded
}: FontListPanelProps): JSX.Element {
  const familyViewAllowed = isFontFamilyViewAllowed(sidebarPage, activeFilter)
  const effectiveCardPoolViewMode = resolveEffectiveCardPoolViewMode(cardPoolViewMode, sidebarPage, activeFilter)

  function closeDetailFromBlankClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea, a, .font-card, [data-no-marquee]')) return
    closeDetail()
  }

  return (
    <section className={`font-list-panel${effectiveCardPoolViewMode === 'list' ? ' simple-wide-list-mode' : ''}${selectedFontIds.length > 1 ? ' has-selection-actionbar' : ''}`}>
      {IS_DEVELOPMENT && sidebarPage === 'developer' ? (
        <div className="developer-status-page">
          <div className="developer-status-header">
            <div>
              <h2>开发者状态</h2>
              <p>底部状态栏迁移到这里；生产封包不会显示。</p>
            </div>
            <button onClick={() => void refreshDeveloperStatusDetails()}>刷新</button>
          </div>

          <div className="developer-status-grid">
            <div className="developer-card">
              <h3>当前状态</h3>
              <p>{status}</p>
            </div>
            <div className="developer-card">
              <h3>最近索引进度</h3>
              <pre>{latestIndexProgress ? stringifyDeveloperValue(latestIndexProgress) : '暂无索引进度事件'}</pre>
            </div>
            <div className="developer-card">
              <h3>缓存架构</h3>
              <pre>{developerArchitecture ? stringifyDeveloperValue(developerArchitecture) : '暂无缓存架构信息'}</pre>
            </div>
            <div className="developer-card">
              <h3>后台任务调度器</h3>
              <pre>{developerSchedulerStatus ? stringifyDeveloperValue(developerSchedulerStatus) : '暂无调度器信息'}</pre>
            </div>
            <div className="developer-card wide">
              <h3>Rust 迁移 / fallback 诊断</h3>
              <pre>{developerMigrationDiagnostics ? stringifyDeveloperValue(developerMigrationDiagnostics) : '暂无迁移诊断信息'}</pre>
            </div>
            <div className="developer-card wide">
              <SharedMetadataMaintenancePanel
                diagnostics={developerSharedMetadataDiagnostics}
                refreshDeveloperStatusDetails={refreshDeveloperStatusDetails}
                onDiagnosticsUpdated={setDeveloperSharedMetadataDiagnostics}
              />
              <pre>{developerSharedMetadataDiagnostics ? stringifyDeveloperValue(developerSharedMetadataDiagnostics) : '暂无共享元数据诊断信息'}</pre>
            </div>
            <div className="developer-card wide">
              <SharedIndexSnapshotMaintenancePanel />
            </div>
            <div className="developer-card wide">
              <h3>后台任务事件</h3>
              <pre>{latestBackgroundTaskEvent ? stringifyDeveloperValue(latestBackgroundTaskEvent) : '暂无后台任务事件'}</pre>
            </div>
            <div className="developer-card wide">
              <h3>最近任务</h3>
              <pre>{developerTasks.length ? stringifyDeveloperValue(developerTasks) : '暂无任务'}</pre>
            </div>
            <div className="developer-card wide">
              <h3>状态日志</h3>
              <div className="developer-log">
                {developerStatusLog.length ? developerStatusLog.map((entry) => (
                  <div key={entry.id} className="developer-log-row">
                    <div><strong>{entry.source}</strong><span>{entry.at}</span></div>
                    <p>{entry.message}</p>
                    {entry.payload !== undefined && <pre>{stringifyDeveloperValue(entry.payload)}</pre>}
                  </div>
                )) : <div className="empty compact">暂无状态日志</div>}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="list-toolbar">
            <div className="toolbar-left toolbar-icon-controls" data-no-marquee>
              <NameSortCycleButton
                sortMode={sortMode}
                onChange={(value) => updatePageToolbar('sortMode', value)}
              />
              <CardPoolViewToggle
                value={effectiveCardPoolViewMode}
                onChange={setCardPoolViewMode}
                allowFamily={familyViewAllowed}
              />
              {effectiveCardPoolViewMode === 'list' && (
                <ListPreviewSizeControl
                  value={listPreviewFontSize}
                  onChange={setListPreviewFontSize}
                />
              )}
            </div>
            <input
              className="search-input dynamic-search-input"
              value={search}
              onChange={(event) => updatePageToolbar('search', event.target.value)}
              placeholder="搜索字体 / 标签 / 名称"
              aria-label="搜索字体名称、文件名、共享标签或安装状态"
              title="搜索字体名称、文件名、共享标签或安装状态"
            />
          </div>

          {selectedFontIds.length > 1 && (
            <div className="selection-actionbar" data-no-marquee>
              <span>已选择 {selectedFontIds.length} 个字体</span>
              <button onClick={() => void activateFontsBatch(selectedFontIds.map((id) => library.fonts[id]).filter((font: FontItem | undefined): font is FontItem => !!font), '批量选择')}>批量激活</button>
              <button onClick={() => void deactivateFontsBatch(selectedFontIds.map((id) => library.fonts[id]).filter((font: FontItem | undefined): font is FontItem => !!font), '批量选择')}>批量取消激活</button>
              <button onClick={() => void deleteFontsBatch(selectedFontIds.map((id) => library.fonts[id]).filter((font: FontItem | undefined): font is FontItem => !!font), '批量选择')}>批量删除文件</button>
              <button onClick={() => void uninstallFontsBatch(selectedFontIds.map((id) => library.fonts[id]).filter((font: FontItem | undefined): font is FontItem => !!font), '批量选择')}>批量卸载字体</button>
              <button onClick={() => void toggleFontDeleteProtection(selectedFontIds, true)}>加入保护</button>
              <button onClick={() => void toggleFontDeleteProtection(selectedFontIds, false)}>取消保护</button>
              <button onClick={() => setSelectedFontIds([])}>取消选择</button>
            </div>
          )}

          {effectiveCardPoolViewMode === 'family' ? (
            <div
              ref={fontScrollerRef}
              className="font-family-group-scroller font-virtual-scroller waterfall pool-family"
              onMouseDown={closeDetailFromBlankClick}
              onScroll={handleFontScroll}
            >
              <FontFamilyGroupPanel
                result={fontFamilyGroupResult}
                loading={fontFamilyGroupLoading}
                error={fontFamilyGroupError}
                expandedIds={expandedFontFamilyIds}
                toggleExpanded={toggleFontFamilyExpanded}
                renderFontCard={renderFontCard}
              />
            </div>
          ) : (
            <div
              ref={fontScrollerRef}
              className={`font-virtual-scroller waterfall view-${viewMode} pool-${effectiveCardPoolViewMode}${effectiveCardPoolViewMode === 'list' ? ' font-list-scroller' : ''}`}
              onScroll={handleFontScroll}
              onMouseDown={(event) => {
                closeDetailFromBlankClick(event)
                beginMarqueeSelection(event)
              }}
            >
              <div className="font-virtual-inner" style={{ height: virtualLayout.totalHeight }}>
                <div
                  className={`font-virtual-page waterfall view-${viewMode} pool-${effectiveCardPoolViewMode}${effectiveCardPoolViewMode === 'list' ? ' font-list-rows' : ''}`}
                  style={{
                    transform: `translateY(${virtualLayout.top}px)`,
                    gridTemplateColumns: effectiveCardPoolViewMode === 'list' ? 'minmax(0, 1fr)' : `repeat(${virtualLayout.columns}, minmax(${viewLayout.minCardWidth}px, 1fr))`,
                    '--hfm-list-row-height': `${viewLayout.rowHeight}px`
                  } as CSSProperties}
                >
                  {virtualLayout.items.map((font: FontItem) => renderFontCard(font, effectiveCardPoolViewMode === 'list'))}
                </div>

                {!visibleFonts.length && !(databasePageReady ? visibleFontTotal : 0) && (
                  <div className="empty-state virtual-empty">
                    <div>没有找到字体</div>
                    <p>点击顶部“更新索引”建立或增量更新 SQLite 共享索引库；已有索引会自动读取。</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
