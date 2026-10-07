import { AppLayout } from './AppLayout'
import { AppOverlays } from './AppOverlays'
import { AppSidebar } from './AppSidebar'
import { AppTopbar } from './AppTopbar'
import { FontDetailPanel } from './FontDetailPanel'
import { FontListPanel } from './FontListPanel'

import type { ComponentProps } from 'react'

type DeveloperPanelKeys = 'developerArchitecture' | 'developerMigrationDiagnostics' | 'developerSchedulerStatus' | 'developerSharedMetadataDiagnostics' | 'developerStatusLog' | 'developerTasks' | 'latestBackgroundTaskEvent' | 'latestIndexProgress' | 'refreshDeveloperStatusDetails' | 'setDeveloperSharedMetadataDiagnostics' | 'status'

export type AppRootViewProps = {
  topbar: ComponentProps<typeof AppTopbar>
  sidebar: Omit<ComponentProps<typeof AppSidebar>, 'sidebarCollapsed' | 'setSidebarCollapsed'>
  content: Omit<ComponentProps<typeof FontListPanel>, DeveloperPanelKeys>
  detail: ComponentProps<typeof FontDetailPanel>
  overlays: ComponentProps<typeof AppOverlays>
  developer: Pick<ComponentProps<typeof FontListPanel>, DeveloperPanelKeys> & { IS_DEVELOPMENT: boolean }
}

export function AppRootView(props: AppRootViewProps): JSX.Element {
  const { topbar, sidebar, content, detail, overlays, developer } = props

  return (
    <div className="app">
      <AppTopbar
        themeMode={topbar.themeMode}
        setThemeMode={topbar.setThemeMode}
        indexingActive={topbar.indexingActive}
        cacheMenuOpen={topbar.cacheMenuOpen}
        setCacheMenuOpen={topbar.setCacheMenuOpen}
        rescan={topbar.rescan}
        cancelIndexing={topbar.cancelIndexing}
        rebuildScanCache={topbar.rebuildScanCache}
        clearAllCacheAction={topbar.clearAllCacheAction}
      />

      <AppLayout
        detailVisible={detail.visible}
        renderSidebar={(sidebarCollapsed, setSidebarCollapsed) => (
          <AppSidebar
            sidebarCollapsed={sidebarCollapsed}
            setSidebarCollapsed={setSidebarCollapsed}
            sidebarPage={sidebar.sidebarPage}
            setSidebarPage={sidebar.setSidebarPage}
            activeFilter={sidebar.activeFilter}
            setActiveFilter={sidebar.setActiveFilter}
            advancedFilterCount={sidebar.advancedFilterCount}
            refreshDeveloperStatusDetails={sidebar.refreshDeveloperStatusDetails}
            categoryCounts={sidebar.categoryCounts}
            allFonts={sidebar.allFonts}
            favoriteCount={sidebar.favoriteCount}
            installedCount={sidebar.installedCount}
            notInstalledCount={sidebar.notInstalledCount}
            activeCount={sidebar.activeCount}
            previewText={sidebar.previewText}
            setPreviewText={sidebar.setPreviewText}
            installStatusReady={sidebar.installStatusReady}
            installStatusMissingCount={sidebar.installStatusMissingCount}
            installStatusSyncSuffix={sidebar.installStatusSyncSuffix}
            expandedFilterGroups={sidebar.expandedFilterGroups}
            setFilterGroupExpanded={sidebar.setFilterGroupExpanded}
            selectedWatchedFolders={sidebar.selectedWatchedFolders}
            setSelectedWatchedFolders={sidebar.setSelectedWatchedFolders}
            library={sidebar.library}
            folderCounts={sidebar.folderCounts}
            selectedFormats={sidebar.selectedFormats}
            setSelectedFormats={sidebar.setSelectedFormats}
            formatCounts={sidebar.formatCounts}
            selectedScripts={sidebar.selectedScripts}
            setSelectedScripts={sidebar.setSelectedScripts}
            scriptCounts={sidebar.scriptCounts}
            selectedCategory={sidebar.selectedCategory}
            setSelectedCategory={sidebar.setSelectedCategory}
            clearAdvancedFilters={sidebar.clearAdvancedFilters}
            newSharedTagName={sidebar.newSharedTagName}
            setNewSharedTagName={sidebar.setNewSharedTagName}
            createSharedTagOnlyFromInput={sidebar.createSharedTagOnlyFromInput}
            sharedTagList={sidebar.sharedTagList}
            selectedSharedTagName={sidebar.selectedSharedTagName}
            setSelectedSharedTagName={sidebar.setSelectedSharedTagName}
            openSharedTagMenu={sidebar.openSharedTagMenu}
            sharedTagCounts={sidebar.sharedTagCounts}
            newTagName={sidebar.newTagName}
            setNewTagName={sidebar.setNewTagName}
            createTagOnlyFromInput={sidebar.createTagOnlyFromInput}
            localTagList={sidebar.localTagList}
            selectedTagName={sidebar.selectedTagName}
            setSelectedTagName={sidebar.setSelectedTagName}
            openTagMenu={sidebar.openTagMenu}
            localTagCounts={sidebar.localTagCounts}
            addFolder={sidebar.addFolder}
            selectedFolderId={sidebar.selectedFolderId}
            setDatabasePageResult={sidebar.setDatabasePageResult}
            setDatabaseQueryResult={sidebar.setDatabaseQueryResult}
            setSelectedFolderId={sidebar.setSelectedFolderId}
            expandedFolderIds={sidebar.expandedFolderIds}
            dropHoverFolderId={sidebar.dropHoverFolderId}
            setDropHoverFolderId={sidebar.setDropHoverFolderId}
            selectFolderFilter={sidebar.selectFolderFilter}
            openFolderMenu={sidebar.openFolderMenu}
            fontIdsFromDropEvent={sidebar.fontIdsFromDropEvent}
            assignFontsToFolder={sidebar.assignFontsToFolder}
            toggleFolderExpanded={sidebar.toggleFolderExpanded}
            flatFolderNodes={sidebar.flatFolderNodes}
            setDeveloperStatusLog={sidebar.setDeveloperStatusLog}
          />
        )}
      >
        <FontListPanel
          sidebarPage={content.sidebarPage}
          refreshDeveloperStatusDetails={developer.refreshDeveloperStatusDetails}
          status={developer.status}
          latestIndexProgress={developer.latestIndexProgress}
          developerArchitecture={developer.developerArchitecture}
          developerSchedulerStatus={developer.developerSchedulerStatus}
          developerMigrationDiagnostics={developer.developerMigrationDiagnostics}
          developerSharedMetadataDiagnostics={developer.developerSharedMetadataDiagnostics}
          setDeveloperSharedMetadataDiagnostics={developer.setDeveloperSharedMetadataDiagnostics}
          latestBackgroundTaskEvent={developer.latestBackgroundTaskEvent}
          developerTasks={developer.developerTasks}
          developerStatusLog={developer.developerStatusLog}
          installStatus={content.installStatus}
          timeSortMode={content.timeSortMode}
          sortMode={content.sortMode}
          viewMode={content.viewMode}
          cardPoolViewMode={content.cardPoolViewMode}
          activeFilter={content.activeFilter}
          setCardPoolViewMode={content.setCardPoolViewMode}
          listPreviewFontSize={content.listPreviewFontSize}
          setListPreviewFontSize={content.setListPreviewFontSize}
          updatePageToolbar={content.updatePageToolbar}
          updateViewModeWithScroll={content.updateViewModeWithScroll}
          search={content.search}
          closeDetail={content.closeDetail}
          fontScrollerRef={content.fontScrollerRef}
          handleFontScroll={content.handleFontScroll}
          beginMarqueeSelection={content.beginMarqueeSelection}
          virtualLayout={content.virtualLayout}
          viewLayout={content.viewLayout}
          renderFontCard={content.renderFontCard}
          databasePageReady={content.databasePageReady}
          visibleFontTotal={content.visibleFontTotal}
          visibleFonts={content.visibleFonts}
          fontFamilyGroupResult={content.fontFamilyGroupResult}
          fontFamilyGroupLoading={content.fontFamilyGroupLoading}
          fontFamilyGroupError={content.fontFamilyGroupError}
          expandedFontFamilyIds={content.expandedFontFamilyIds}
          toggleFontFamilyExpanded={content.toggleFontFamilyExpanded}
        />

        <FontDetailPanel
          visible={detail.visible}
          selectedFont={detail.selectedFont}
          previewText={detail.previewText}
          previewFamilies={detail.previewFamilies}
          selectedPreviewFamily={detail.selectedPreviewFamily}
          nativeDetailImage={detail.nativeDetailImage}
          selectedFontIds={detail.selectedFontIds}
          library={detail.library}
          visibleFonts={detail.visibleFonts}
          runFontCommand={detail.runFontCommand}
          assignTagName={detail.assignTagName}
          setAssignTagName={detail.setAssignTagName}
          handleLocalTagInputKeyDown={detail.handleLocalTagInputKeyDown}
          localTagSuggestions={detail.localTagSuggestions}
          activeLocalTagSuggestionIndex={detail.activeLocalTagSuggestionIndex}
          setActiveLocalTagSuggestionIndex={detail.setActiveLocalTagSuggestionIndex}
          addTagToSelectedByName={detail.addTagToSelectedByName}
          removeTagFromSelected={detail.removeTagFromSelected}
          assignSharedTagName={detail.assignSharedTagName}
          setAssignSharedTagName={detail.setAssignSharedTagName}
          handleSharedTagInputKeyDown={detail.handleSharedTagInputKeyDown}
          sharedTagSuggestions={detail.sharedTagSuggestions}
          activeSharedTagSuggestionIndex={detail.activeSharedTagSuggestionIndex}
          setActiveSharedTagSuggestionIndex={detail.setActiveSharedTagSuggestionIndex}
          addSharedTagToSelectedByName={detail.addSharedTagToSelectedByName}
          removeSharedTagFromSelected={detail.removeSharedTagFromSelected}
          updateFont={detail.updateFont}
          applyCompare={detail.applyCompare}
        />
      </AppLayout>

      <AppOverlays
        renameTarget={overlays.renameTarget}
        setRenameTarget={overlays.setRenameTarget}
        renameValue={overlays.renameValue}
        setRenameValue={overlays.setRenameValue}
        confirmRename={overlays.confirmRename}
        deleteTarget={overlays.deleteTarget}
        setDeleteTarget={overlays.setDeleteTarget}
        confirmDelete={overlays.confirmDelete}
        folderChildTarget={overlays.folderChildTarget}
        setFolderChildTarget={overlays.setFolderChildTarget}
        newFolderName={overlays.newFolderName}
        setNewFolderName={overlays.setNewFolderName}
        createSubfolder={overlays.createSubfolder}
        selectionRect={overlays.selectionRect}
        normalizedSelectionRect={overlays.normalizedSelectionRect}
        contextMenu={overlays.contextMenu}
        contextSelectedFonts={overlays.contextSelectedFonts}
        runFontContextAction={overlays.runFontContextAction}
        contextTargetCount={overlays.contextTargetCount}
        runContextBatchActivate={overlays.runContextBatchActivate}
        runContextBatchDeactivate={overlays.runContextBatchDeactivate}
        runContextRefreshFolder={overlays.runContextRefreshFolder}
        runContextRename={overlays.runContextRename}
        runContextAddSubfolder={overlays.runContextAddSubfolder}
        runContextDelete={overlays.runContextDelete}
        leaseLockConflictNotice={overlays.leaseLockConflictNotice}
        setLeaseLockConflictNotice={overlays.setLeaseLockConflictNotice}
      />

      {developer.IS_DEVELOPMENT && <footer className="statusbar">{developer.status}</footer>}
    </div>
  )
}
