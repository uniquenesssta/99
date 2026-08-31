import { AppSidebarIcon } from './AppSidebarIcons'
import type { AppSidebarProps } from './AppSidebarTypes'

type AppSidebarLibraryPageProps = Pick<
  AppSidebarProps,
  | 'activeFilter'
  | 'setActiveFilter'
  | 'categoryCounts'
  | 'allFonts'
  | 'favoriteCount'
  | 'installedCount'
  | 'notInstalledCount'
  | 'activeCount'
  | 'previewText'
  | 'setPreviewText'
  | 'installStatusReady'
  | 'installStatusMissingCount'
  | 'installStatusSyncSuffix'
>

export function AppSidebarLibraryPage({
  activeFilter,
  setActiveFilter,
  categoryCounts,
  allFonts,
  favoriteCount,
  installedCount,
  notInstalledCount,
  activeCount,
  previewText,
  setPreviewText,
  installStatusReady,
  installStatusMissingCount,
  installStatusSyncSuffix,
}: AppSidebarLibraryPageProps): JSX.Element {
  return (
    <div className="sidebar-page">
      <div className="section-title">库</div>
      <button data-compact-label="全部" className={activeFilter.kind === 'all' ? 'nav active' : 'nav'} onClick={() => setActiveFilter({ kind: 'all', name: '全部字体' })}>
        <span className="nav-label"><AppSidebarIcon name="library" /><span>全部字体</span></span><span>{categoryCounts.all || allFonts.length}</span>
      </button>
      <button data-compact-label="收藏" className={activeFilter.kind === 'favorites' ? 'nav active' : 'nav'} onClick={() => setActiveFilter({ kind: 'favorites', name: '收藏' })}>
        <span className="nav-label"><AppSidebarIcon name="favorites" /><span>收藏</span></span><span>{favoriteCount}</span>
      </button>
      <button data-compact-label="安装" className={activeFilter.kind === 'installed' ? 'nav active' : 'nav'} onClick={() => setActiveFilter({ kind: 'installed', name: '已安装' })} title={!installStatusReady ? `还有 ${installStatusMissingCount} 个字体安装状态正在同步，当前数量是已知快照。` : undefined}>
        <span className="nav-label"><AppSidebarIcon name="installed" /><span>已安装</span></span><span>{installedCount}{installStatusSyncSuffix}</span>
      </button>
      <button data-compact-label="未装" className={activeFilter.kind === 'notInstalled' ? 'nav active' : 'nav'} onClick={() => setActiveFilter({ kind: 'notInstalled', name: '未安装' })} title={!installStatusReady ? `还有 ${installStatusMissingCount} 个字体安装状态正在同步，当前数量是已知快照。` : undefined}>
        <span className="nav-label"><AppSidebarIcon name="notInstalled" /><span>未安装</span></span><span>{notInstalledCount}{installStatusSyncSuffix}</span>
      </button>
      <button data-compact-label="激活" className={activeFilter.kind === 'active' ? 'nav active' : 'nav'} onClick={() => setActiveFilter({ kind: 'active', name: '已激活' })}>
        <span className="nav-label"><AppSidebarIcon name="active" /><span>已激活</span></span><span>{activeCount}</span>
      </button>

      <div className="sidebar-preview-editor">
        <div className="sidebar-preview-title">预览文字</div>
        <textarea
          className="sidebar-preview-input"
          value={previewText}
          onChange={(event) => setPreviewText(event.target.value)}
          placeholder="输入字体预览文字"
          aria-label="字体预览文字"
        />
        {!installStatusReady && (
          <div className="sidebar-preview-hint">
            已安装状态正在同步：还有 {installStatusMissingCount} 个字体未确认。
          </div>
        )}
      </div>
    </div>
  )
}
