import { IS_DEVELOPMENT } from '../../appRuntime'
import { AppSidebarIcon } from './AppSidebarIcons'
import type { AppSidebarProps } from './AppSidebarTypes'

type AppSidebarShellProps = Pick<
  AppSidebarProps,
  | 'categoryCounts'
  | 'allFonts'
  | 'sidebarPage'
  | 'setSidebarPage'
  | 'advancedFilterCount'
  | 'refreshDeveloperStatusDetails'
>

export function AppSidebarIdentityCard({ categoryCounts, allFonts }: Pick<AppSidebarShellProps, 'categoryCounts' | 'allFonts'>): JSX.Element {
  return (
    <div className="sidebar-identity-card">
      <div className="sidebar-identity-title"><span>字体资产</span><span>{categoryCounts.all || allFonts.length}</span></div>
      <div className="sidebar-identity-meta">按库状态、标签、语言、格式和物理文件夹快速整理本机字体。</div>
    </div>
  )
}

export function AppSidebarTabs({
  sidebarPage,
  setSidebarPage,
  advancedFilterCount,
  refreshDeveloperStatusDetails,
}: Omit<AppSidebarShellProps, 'categoryCounts' | 'allFonts'>): JSX.Element {
  return (
    <div className="sidebar-tabs">
      <button data-compact-label="库" data-tooltip="库：查看全部字体、收藏、安装和激活状态" title="库：查看全部字体、收藏、安装和激活状态" aria-label="库：查看全部字体、收藏、安装和激活状态" className={sidebarPage === 'library' ? 'tab active' : 'tab'} onClick={() => setSidebarPage('library')}><span className="tab-label"><AppSidebarIcon name="library" /><span>库</span></span></button>
      <button data-compact-label="筛" data-tooltip={advancedFilterCount ? `筛选：已启用 ${advancedFilterCount} 项条件` : '筛选：按格式、语言、文件夹等条件过滤'} title={advancedFilterCount ? `筛选：已启用 ${advancedFilterCount} 项条件` : '筛选：按格式、语言、文件夹等条件过滤'} aria-label={advancedFilterCount ? `筛选：已启用 ${advancedFilterCount} 项条件` : '筛选：按格式、语言、文件夹等条件过滤'} className={sidebarPage === 'filters' ? 'tab active' : 'tab'} onClick={() => setSidebarPage('filters')}><span className="tab-label"><AppSidebarIcon name="filters" /><span>筛选{advancedFilterCount ? ` · ${advancedFilterCount}` : ''}</span></span></button>
      <button data-compact-label="标" data-tooltip="标签：管理本机私有标签" title="标签：管理本机私有标签" aria-label="标签：管理本机私有标签" className={sidebarPage === 'tags' ? 'tab active' : 'tab'} onClick={() => setSidebarPage('tags')}><span className="tab-label"><AppSidebarIcon name="tags" /><span>标签</span></span></button>
      <button data-compact-label="共" data-tooltip="共享标签：管理 NAS/共享库标签" title="共享标签：管理 NAS/共享库标签" aria-label="共享标签：管理 NAS/共享库标签" className={sidebarPage === 'sharedTags' ? 'tab active' : 'tab'} onClick={() => setSidebarPage('sharedTags')}><span className="tab-label"><AppSidebarIcon name="sharedTags" /><span>共享标签</span></span></button>
      <button data-compact-label="夹" data-tooltip="文件夹：管理监听目录和物理文件夹" title="文件夹：管理监听目录和物理文件夹" aria-label="文件夹：管理监听目录和物理文件夹" className={sidebarPage === 'folders' ? 'tab active' : 'tab'} onClick={() => setSidebarPage('folders')}><span className="tab-label"><AppSidebarIcon name="folders" /><span>文件夹</span></span></button>
      {IS_DEVELOPMENT && <button data-compact-label="开" data-tooltip="开发者状态：查看运行和任务状态" title="开发者状态：查看运行和任务状态" aria-label="开发者状态：查看运行和任务状态" className={sidebarPage === 'developer' ? 'tab active dev-tab' : 'tab dev-tab'} onClick={() => { setSidebarPage('developer'); void refreshDeveloperStatusDetails() }}><span className="tab-label"><AppSidebarIcon name="developer" /><span>开发者状态</span></span></button>}
    </div>
  )
}
