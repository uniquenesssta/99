import { folderDisplayName, folderHasChildren } from '../../appRuntime'
import type { AppSidebarProps } from './AppSidebarTypes'

type AppSidebarFoldersPageProps = Pick<
  AppSidebarProps,
  | 'addFolder'
  | 'selectedFolderId'
  | 'setDatabasePageResult'
  | 'setDatabaseQueryResult'
  | 'setSelectedFolderId'
  | 'library'
  | 'categoryCounts'
  | 'expandedFolderIds'
  | 'dropHoverFolderId'
  | 'setDropHoverFolderId'
  | 'selectFolderFilter'
  | 'openFolderMenu'
  | 'fontIdsFromDropEvent'
  | 'assignFontsToFolder'
  | 'toggleFolderExpanded'
  | 'folderCounts'
  | 'flatFolderNodes'
>

export function AppSidebarFoldersPage({
  addFolder,
  selectedFolderId,
  setDatabasePageResult,
  setDatabaseQueryResult,
  setSelectedFolderId,
  library,
  categoryCounts,
  expandedFolderIds,
  dropHoverFolderId,
  setDropHoverFolderId,
  selectFolderFilter,
  openFolderMenu,
  fontIdsFromDropEvent,
  assignFontsToFolder,
  toggleFolderExpanded,
  folderCounts,
  flatFolderNodes,
}: AppSidebarFoldersPageProps): JSX.Element {
  return (
    <div className="sidebar-page">
      <div className="section-title">字体文件夹</div>
      <button className="clear-filter-button" onClick={() => void addFolder()}>添加监听文件夹</button>
      <div className="watch-hint">自动监听已开启，磁盘新增、删除、重命名后会同步刷新。新增/重命名子文件夹会影响真实磁盘；拖入字体卡会物理移动字体文件。系统字体会被保护。</div>
      <div className="folder-list">
        {library.folders.length ? (
          <>
            <button
              className={!selectedFolderId ? 'folder-row active' : 'folder-row'}
              onClick={() => { setDatabasePageResult(null); setDatabaseQueryResult(null); setSelectedFolderId('') }}
            >
              <span className="folder-toggle placeholder" aria-hidden="true" />
              <span className="folder-name">全部已归类/监听字体</span>
              <em>{categoryCounts.all || 0}</em>
            </button>
            {library.folders.map((folder: string) => {
              const name = folderDisplayName(library, folder)
              const hasChildren = folderHasChildren(library, folder)
              const expanded = !!expandedFolderIds[folder]
              return (
                <button
                  key={folder}
                  className={`${selectedFolderId === folder ? 'folder-row active' : 'folder-row'} ${dropHoverFolderId === folder ? 'drop-hover' : ''}`}
                  onClick={() => selectFolderFilter(folder)}
                  onContextMenu={(event) => openFolderMenu(event, { kind: 'folder', id: folder, name, rootPath: folder, virtual: false })}
                  onDragOver={(event) => { event.preventDefault(); setDropHoverFolderId(folder) }}
                  onDragLeave={() => setDropHoverFolderId('')}
                  onDrop={(event) => {
                    event.preventDefault()
                    const fontIds = fontIdsFromDropEvent(event)
                    setDropHoverFolderId('')
                    if (fontIds.length) void assignFontsToFolder(fontIds, folder)
                  }}
                  title="左键查看/取消查看；点击三角展开/收拢；右键物理重命名、移除监听或新增物理子文件夹；可拖入字体卡"
                >
                  <span
                    className={hasChildren ? 'folder-toggle' : 'folder-toggle placeholder'}
                    aria-label={hasChildren ? (expanded ? '收拢文件夹' : '展开文件夹') : undefined}
                    onClick={(event) => {
                      if (!hasChildren) return
                      event.preventDefault()
                      event.stopPropagation()
                      toggleFolderExpanded(folder)
                    }}
                  >
                    {hasChildren ? (expanded ? '▾' : '▸') : ''}
                  </span>
                  <span className="folder-name">{name}</span>
                  <em>{folderCounts[folder] || 0}</em>
                </button>
              )
            })}
            {flatFolderNodes.map((node) => (
              <button
                key={node.id}
                className={`${selectedFolderId === node.id ? 'folder-row virtual active' : 'folder-row virtual'} ${dropHoverFolderId === node.id ? 'drop-hover' : ''}`}
                style={{ paddingLeft: 8 + node.depth * 14 }}
                onClick={() => selectFolderFilter(node.id)}
                onContextMenu={(event) => openFolderMenu(event, { kind: 'folder', id: node.id, name: folderDisplayName(library, node.id, node.name), rootPath: node.rootPath, virtual: true })}
                onDragOver={(event) => { event.preventDefault(); setDropHoverFolderId(node.id) }}
                onDragLeave={() => setDropHoverFolderId('')}
                onDrop={(event) => {
                  event.preventDefault()
                  const fontIds = fontIdsFromDropEvent(event)
                  setDropHoverFolderId('')
                  if (fontIds.length) void assignFontsToFolder(fontIds, node.id)
                }}
                title="物理子文件夹：点击三角展开/收拢；创建、重命名和拖入会影响磁盘；移除只影响软件记录"
              >
                <span
                  className={node.hasChildren ? 'folder-toggle' : 'folder-toggle placeholder'}
                  aria-label={node.hasChildren ? (node.expanded ? '收拢文件夹' : '展开文件夹') : undefined}
                  onClick={(event) => {
                    if (!node.hasChildren) return
                    event.preventDefault()
                    event.stopPropagation()
                    toggleFolderExpanded(node.id)
                  }}
                >
                  {node.hasChildren ? (node.expanded ? '▾' : '▸') : ''}
                </span>
                <span className="folder-name">{folderDisplayName(library, node.id, node.name)}</span>
                <em>{folderCounts[node.id] || 0}</em>
              </button>
            ))}
          </>
        ) : (
          <div className="empty">还没有添加监听文件夹</div>
        )}
      </div>
    </div>
  )
}
