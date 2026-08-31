import { IS_DEVELOPMENT } from '../../appRuntime'
import { AppSidebarIcon } from './AppSidebarIcons'

type AppSidebarCollapsedRailProps = {
  sidebarPage: any
  setSidebarPage: (value: any) => void
  activeFilter: any
  setActiveFilter: (value: any) => void
  advancedFilterCount: number
  refreshDeveloperStatusDetails: () => Promise<void>
  categoryCounts: Record<string, number>
  allFonts: unknown[]
  favoriteCount: number
  installedCount: number
  notInstalledCount: number
  activeCount: number
  installStatusSyncSuffix: string
}

export function AppSidebarCollapsedRail({
  sidebarPage,
  setSidebarPage,
  activeFilter,
  setActiveFilter,
  advancedFilterCount,
  refreshDeveloperStatusDetails,
  categoryCounts,
  allFonts,
  favoriteCount,
  installedCount,
  notInstalledCount,
  activeCount,
  installStatusSyncSuffix
}: AppSidebarCollapsedRailProps): JSX.Element {
  return (
    <div className="sidebar-collapsed-rail">
      <div className="sidebar-rail-group" aria-label="侧边栏页面">
        <button className={sidebarPage === 'library' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title="库：查看全部字体、收藏、安装和激活状态" data-tooltip="库：查看全部字体、收藏、安装和激活状态" aria-label="库：查看全部字体、收藏、安装和激活状态" onClick={() => setSidebarPage('library')}><AppSidebarIcon name="library" /></button>
        <button className={sidebarPage === 'filters' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title={advancedFilterCount ? `筛选：已启用 ${advancedFilterCount} 项条件` : '筛选：按格式、语言、文件夹等条件过滤'} data-tooltip={advancedFilterCount ? `筛选：已启用 ${advancedFilterCount} 项条件` : '筛选：按格式、语言、文件夹等条件过滤'} aria-label={advancedFilterCount ? `筛选：已启用 ${advancedFilterCount} 项条件` : '筛选：按格式、语言、文件夹等条件过滤'} onClick={() => setSidebarPage('filters')}><AppSidebarIcon name="filters" /></button>
        <button className={sidebarPage === 'tags' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title="标签：管理本机私有标签" data-tooltip="标签：管理本机私有标签" aria-label="标签：管理本机私有标签" onClick={() => setSidebarPage('tags')}><AppSidebarIcon name="tags" /></button>
        <button className={sidebarPage === 'sharedTags' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title="共享标签：管理 NAS/共享库标签" data-tooltip="共享标签：管理 NAS/共享库标签" aria-label="共享标签：管理 NAS/共享库标签" onClick={() => setSidebarPage('sharedTags')}><AppSidebarIcon name="sharedTags" /></button>
        <button className={sidebarPage === 'folders' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title="文件夹：管理监听目录和物理文件夹" data-tooltip="文件夹：管理监听目录和物理文件夹" aria-label="文件夹：管理监听目录和物理文件夹" onClick={() => setSidebarPage('folders')}><AppSidebarIcon name="folders" /></button>
        {IS_DEVELOPMENT && <button className={sidebarPage === 'developer' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title="开发者状态：查看运行和任务状态" data-tooltip="开发者状态：查看运行和任务状态" aria-label="开发者状态：查看运行和任务状态" onClick={() => { setSidebarPage('developer'); void refreshDeveloperStatusDetails() }}><AppSidebarIcon name="developer" /></button>}
      </div>

      <div className="sidebar-rail-separator" aria-hidden="true" />

      <div className="sidebar-rail-group" aria-label="库筛选">
        <button className={activeFilter.kind === 'all' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title={`全部字体 · ${categoryCounts.all || allFonts.length}`} data-tooltip={`全部字体 · ${categoryCounts.all || allFonts.length}`} aria-label="全部字体" onClick={() => { setSidebarPage('library'); setActiveFilter({ kind: 'all', name: '全部字体' }) }}><AppSidebarIcon name="library" /></button>
        <button className={activeFilter.kind === 'favorites' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title={`收藏 · ${favoriteCount}`} data-tooltip={`收藏 · ${favoriteCount}`} aria-label="收藏" onClick={() => { setSidebarPage('library'); setActiveFilter({ kind: 'favorites', name: '收藏' }) }}><AppSidebarIcon name="favorites" /></button>
        <button className={activeFilter.kind === 'installed' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title={`已安装 · ${installedCount}${installStatusSyncSuffix}`} data-tooltip={`已安装 · ${installedCount}${installStatusSyncSuffix}`} aria-label="已安装" onClick={() => { setSidebarPage('library'); setActiveFilter({ kind: 'installed', name: '已安装' }) }}><AppSidebarIcon name="installed" /></button>
        <button className={activeFilter.kind === 'notInstalled' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title={`未安装 · ${notInstalledCount}${installStatusSyncSuffix}`} data-tooltip={`未安装 · ${notInstalledCount}${installStatusSyncSuffix}`} aria-label="未安装" onClick={() => { setSidebarPage('library'); setActiveFilter({ kind: 'notInstalled', name: '未安装' }) }}><AppSidebarIcon name="notInstalled" /></button>
        <button className={activeFilter.kind === 'active' ? 'sidebar-rail-button active' : 'sidebar-rail-button'} type="button" title={`已激活 · ${activeCount}`} data-tooltip={`已激活 · ${activeCount}`} aria-label="已激活" onClick={() => { setSidebarPage('library'); setActiveFilter({ kind: 'active', name: '已激活' }) }}><AppSidebarIcon name="active" /></button>
      </div>
    </div>
  )
}
