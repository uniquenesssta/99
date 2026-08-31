import { IS_DEVELOPMENT } from '../../appRuntime'

import { AppSidebarCollapsedRail } from './AppSidebarCollapsedRail'
import { AppSidebarDeveloperPage } from './AppSidebarDeveloperPage'
import { AppSidebarFilterPage } from './AppSidebarFilterPage'
import { AppSidebarFoldersPage } from './AppSidebarFoldersPage'
import { AppSidebarLibraryPage } from './AppSidebarLibraryPage'
import { AppSidebarIdentityCard, AppSidebarTabs } from './AppSidebarShell'
import { AppSidebarTagPage } from './AppSidebarTagPage'
import type { AppSidebarProps } from './AppSidebarTypes'

export function AppSidebar(props: AppSidebarProps): JSX.Element {
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
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
    previewText,
    setPreviewText,
    installStatusReady,
    installStatusMissingCount,
    installStatusSyncSuffix,
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
    clearAdvancedFilters,
    newSharedTagName,
    setNewSharedTagName,
    createSharedTagOnlyFromInput,
    sharedTagList,
    selectedSharedTagName,
    setSelectedSharedTagName,
    openSharedTagMenu,
    sharedTagCounts,
    newTagName,
    setNewTagName,
    createTagOnlyFromInput,
    localTagList,
    selectedTagName,
    setSelectedTagName,
    openTagMenu,
    localTagCounts,
    addFolder,
    selectedFolderId,
    setDatabasePageResult,
    setDatabaseQueryResult,
    setSelectedFolderId,
    expandedFolderIds,
    dropHoverFolderId,
    setDropHoverFolderId,
    selectFolderFilter,
    openFolderMenu,
    fontIdsFromDropEvent,
    assignFontsToFolder,
    toggleFolderExpanded,
    flatFolderNodes,
    setDeveloperStatusLog,
  } = props

  const collapseToggle = (
    <button
      className="sidebar-collapse-button"
      type="button"
      title={sidebarCollapsed ? '展开侧边栏' : '收拢侧边栏'}
      aria-label={sidebarCollapsed ? '展开侧边栏' : '收拢侧边栏'}
      aria-expanded={!sidebarCollapsed}
      onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
    >
      <span aria-hidden="true">{sidebarCollapsed ? '›' : '‹'}</span>
    </button>
  )

  return (
    <aside className={sidebarCollapsed ? 'sidebar collapsed' : 'sidebar'}>
      {sidebarCollapsed ? (
        <>
          {collapseToggle}
          <AppSidebarCollapsedRail
          sidebarPage={sidebarPage}
          setSidebarPage={setSidebarPage}
          activeFilter={activeFilter}
          setActiveFilter={setActiveFilter}
          advancedFilterCount={advancedFilterCount}
          refreshDeveloperStatusDetails={refreshDeveloperStatusDetails}
          categoryCounts={categoryCounts}
          allFonts={allFonts}
          favoriteCount={favoriteCount}
          installedCount={installedCount}
          notInstalledCount={notInstalledCount}
          activeCount={activeCount}
            installStatusSyncSuffix={installStatusSyncSuffix}
          />
        </>
      ) : (
        <div className="sidebar-body">
          <div className="sidebar-expanded-header">
            <AppSidebarIdentityCard categoryCounts={categoryCounts} allFonts={allFonts} />
            {collapseToggle}
          </div>
          <AppSidebarTabs
            sidebarPage={sidebarPage}
            setSidebarPage={setSidebarPage}
            advancedFilterCount={advancedFilterCount}
            refreshDeveloperStatusDetails={refreshDeveloperStatusDetails}
          />

          {sidebarPage === 'library' && (
            <AppSidebarLibraryPage
              activeFilter={activeFilter}
              setActiveFilter={setActiveFilter}
              categoryCounts={categoryCounts}
              allFonts={allFonts}
              favoriteCount={favoriteCount}
              installedCount={installedCount}
              notInstalledCount={notInstalledCount}
              activeCount={activeCount}
              previewText={previewText}
              setPreviewText={setPreviewText}
              installStatusReady={installStatusReady}
              installStatusMissingCount={installStatusMissingCount}
              installStatusSyncSuffix={installStatusSyncSuffix}
            />
          )}

          {sidebarPage === 'filters' && (
            <AppSidebarFilterPage
              expandedFilterGroups={expandedFilterGroups}
              setFilterGroupExpanded={setFilterGroupExpanded}
              selectedWatchedFolders={selectedWatchedFolders}
              setSelectedWatchedFolders={setSelectedWatchedFolders}
              library={library}
              folderCounts={folderCounts}
              selectedFormats={selectedFormats}
              setSelectedFormats={setSelectedFormats}
              formatCounts={formatCounts}
              selectedScripts={selectedScripts}
              setSelectedScripts={setSelectedScripts}
              scriptCounts={scriptCounts}
              selectedCategory={selectedCategory}
              setSelectedCategory={setSelectedCategory}
              categoryCounts={categoryCounts}
              clearAdvancedFilters={clearAdvancedFilters}
            />
          )}

          {sidebarPage === 'sharedTags' && (
            <AppSidebarTagPage
              title="共享标签"
              inputValue={newSharedTagName}
              setInputValue={setNewSharedTagName}
              createFromInput={createSharedTagOnlyFromInput}
              tagList={sharedTagList}
              selectedTagName={selectedSharedTagName}
              setSelectedTagName={setSelectedSharedTagName}
              openTagMenu={openSharedTagMenu}
              tagCounts={sharedTagCounts}
              emptyText="还没有共享标签"
              inputPlaceholder="共享标签名称"
              navTitle="左键筛选/取消这个共享标签；未选择时显示所有已添加共享标签的字体；右键重命名或删除共享标签"
            />
          )}

          {sidebarPage === 'tags' && (
            <AppSidebarTagPage
              title="标签"
              inputValue={newTagName}
              setInputValue={setNewTagName}
              createFromInput={createTagOnlyFromInput}
              tagList={localTagList}
              selectedTagName={selectedTagName}
              setSelectedTagName={setSelectedTagName}
              openTagMenu={openTagMenu}
              tagCounts={localTagCounts}
              emptyText="还没有标签"
              inputPlaceholder="标签名称"
              navTitle="左键筛选/取消这个标签；未选择时显示所有已添加标签的字体；右键重命名或删除标签"
            />
          )}

          {sidebarPage === 'folders' && (
            <AppSidebarFoldersPage
              addFolder={addFolder}
              selectedFolderId={selectedFolderId}
              setDatabasePageResult={setDatabasePageResult}
              setDatabaseQueryResult={setDatabaseQueryResult}
              setSelectedFolderId={setSelectedFolderId}
              library={library}
              categoryCounts={categoryCounts}
              expandedFolderIds={expandedFolderIds}
              dropHoverFolderId={dropHoverFolderId}
              setDropHoverFolderId={setDropHoverFolderId}
              selectFolderFilter={selectFolderFilter}
              openFolderMenu={openFolderMenu}
              fontIdsFromDropEvent={fontIdsFromDropEvent}
              assignFontsToFolder={assignFontsToFolder}
              toggleFolderExpanded={toggleFolderExpanded}
              folderCounts={folderCounts}
              flatFolderNodes={flatFolderNodes}
            />
          )}

          {IS_DEVELOPMENT && sidebarPage === 'developer' && (
            <AppSidebarDeveloperPage
              refreshDeveloperStatusDetails={refreshDeveloperStatusDetails}
              setDeveloperStatusLog={setDeveloperStatusLog}
            />
          )}
        </div>
      )}
    </aside>
  )
}
