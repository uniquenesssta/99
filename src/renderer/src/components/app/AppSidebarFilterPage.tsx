import {
  folderDisplayName,
  FONT_CATEGORY_FILTERS,
  FONT_CATEGORY_LABELS,
  FORMAT_FILTERS,
  SCRIPT_LANGUAGE_LABELS,
  SCRIPT_LANGUAGE_ORDER,
  selectionSummary,
  toggleArrayValue,
} from '../../appRuntime'
import type { AppSidebarProps } from './AppSidebarTypes'

type AppSidebarFilterPageProps = Pick<
  AppSidebarProps,
  | 'expandedFilterGroups'
  | 'setFilterGroupExpanded'
  | 'selectedWatchedFolders'
  | 'setSelectedWatchedFolders'
  | 'library'
  | 'folderCounts'
  | 'selectedFormats'
  | 'setSelectedFormats'
  | 'formatCounts'
  | 'selectedScripts'
  | 'setSelectedScripts'
  | 'scriptCounts'
  | 'selectedCategory'
  | 'setSelectedCategory'
  | 'categoryCounts'
  | 'clearAdvancedFilters'
>

export function AppSidebarFilterPage({
  expandedFilterGroups,
  setFilterGroupExpanded,
  selectedWatchedFolders,
  setSelectedWatchedFolders,
  library,
  folderCounts,
  selectedFormats,
  setSelectedFormats,
  formatCounts,
  selectedScripts,
  setSelectedScripts,
  scriptCounts,
  selectedCategory,
  setSelectedCategory,
  categoryCounts,
  clearAdvancedFilters,
}: AppSidebarFilterPageProps): JSX.Element {
  return (
    <div className="sidebar-page">
      <div className="section-title">组合筛选</div>
      <div className="filter-note">
        筛选页可先按监听文件夹缩小范围，再叠加字体类型、语言和字体分类。标签、共享标签在各自页面独立生效。
      </div>
      <button className="clear-filter-button" onClick={clearAdvancedFilters}>清空组合筛选</button>

      <details className={selectedWatchedFolders.length ? 'filter-dropdown has-selection' : 'filter-dropdown'} open={!!expandedFilterGroups.watchedFolders} onToggle={(event) => setFilterGroupExpanded('watchedFolders', event.currentTarget.open)}>
        <summary data-compact-label="文件">监听文件夹 <span>{selectionSummary(selectedWatchedFolders.length)}</span></summary>
        <div className="check-list">
          {library.folders.length ? library.folders.map((folder: string) => (
            <label key={folder} className={selectedWatchedFolders.includes(folder) ? 'check-item selected' : 'check-item'} title={folder}>
              <input
                type="checkbox"
                checked={selectedWatchedFolders.includes(folder)}
                onChange={() => setSelectedWatchedFolders((prev: string[]) => toggleArrayValue(prev, folder))}
              />
              <span>{folderDisplayName(library, folder)}</span>
              <em>{folderCounts[folder] || 0}</em>
            </label>
          )) : <div className="empty compact">还没有监听文件夹</div>}
        </div>
      </details>

      <details className={selectedFormats.length ? 'filter-dropdown has-selection' : 'filter-dropdown'} open={!!expandedFilterGroups.formats} onToggle={(event) => setFilterGroupExpanded('formats', event.currentTarget.open)}>
        <summary data-compact-label="类型">字体类型 <span>{selectionSummary(selectedFormats.length)}</span></summary>
        <div className="check-list">
          {FORMAT_FILTERS.map((item) => (
            <label key={item.id} className={selectedFormats.includes(item.id) ? 'check-item selected' : 'check-item'}>
              <input
                type="checkbox"
                checked={selectedFormats.includes(item.id)}
                onChange={() => setSelectedFormats((prev: any[]) => toggleArrayValue(prev, item.id))}
              />
              <span>{item.label}</span>
              <em>{formatCounts[item.id]}</em>
            </label>
          ))}
        </div>
      </details>

      <details className={selectedScripts.length ? 'filter-dropdown has-selection' : 'filter-dropdown'} open={!!expandedFilterGroups.scripts} onToggle={(event) => setFilterGroupExpanded('scripts', event.currentTarget.open)}>
        <summary data-compact-label="语言">字体语言 <span>{selectionSummary(selectedScripts.length)}</span></summary>
        <div className="check-list">
          {SCRIPT_LANGUAGE_ORDER.map((script) => (
            <label key={script} className={selectedScripts.includes(script) ? 'check-item selected' : 'check-item'}>
              <input
                type="checkbox"
                checked={selectedScripts.includes(script)}
                onChange={() => setSelectedScripts((prev: any[]) => toggleArrayValue(prev, script))}
              />
              <span>{SCRIPT_LANGUAGE_LABELS[script] || script}</span>
              <em>{scriptCounts[script] || 0}</em>
            </label>
          ))}
        </div>
      </details>

      <details className={selectedCategory !== 'all' ? 'filter-dropdown has-selection' : 'filter-dropdown'} open={!!expandedFilterGroups.category} onToggle={(event) => setFilterGroupExpanded('category', event.currentTarget.open)}>
        <summary data-compact-label="分类">字体分类 <span>{FONT_CATEGORY_LABELS[selectedCategory as keyof typeof FONT_CATEGORY_LABELS]}</span></summary>
        <div className="category-filter-list">
          {FONT_CATEGORY_FILTERS.map((item) => (
            <button
              key={item.id}
              className={selectedCategory === item.id ? 'category-filter active' : 'category-filter'}
              onClick={() => setSelectedCategory(item.id)}
            >
              <span>{item.label}</span>
              <em>{categoryCounts[item.id]}</em>
            </button>
          ))}
        </div>
      </details>
    </div>
  )
}
