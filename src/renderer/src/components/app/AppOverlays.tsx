import type { FontItem } from '@shared/types'
import { isKeyboardCompositionEvent } from '../../fontTagInputRuntime'
import type { LeaseLockConflictNotice as LeaseLockConflictNoticeState } from '../../runtime/lease-lock/leaseLockConflictNoticeRuntime'
import { LeaseLockConflictNotice } from './LeaseLockConflictNotice'

type AppOverlaysProps = {
  renameTarget: any
  setRenameTarget: (value: any) => void
  renameValue: string
  setRenameValue: (value: string) => void
  confirmRename: () => Promise<void>
  deleteTarget: any
  setDeleteTarget: (value: any) => void
  confirmDelete: () => Promise<void>
  folderChildTarget: any
  setFolderChildTarget: (value: any) => void
  newFolderName: string
  setNewFolderName: (value: string) => void
  createSubfolder: (target: any, name: string) => Promise<void>
  selectionRect: any
  normalizedSelectionRect: (rect: any) => DOMRect
  contextMenu: any
  contextSelectedFonts: FontItem[]
  selectionLabel: (fonts: FontItem[]) => string
  runFontContextAction: (action: 'install' | 'remove' | 'activate' | 'deactivate' | 'deleteFile' | 'protectToggle') => Promise<void>
  deleteFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  uninstallFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
  toggleFontDeleteProtection: (fontIds: string[], protect?: boolean) => Promise<void>
  runContextBatchActivate: () => void
  runContextBatchDeactivate: () => void
  runContextRefreshFolder: () => void
  runContextRename: () => void
  runContextAddSubfolder: () => void
  runContextDelete: () => void
  leaseLockConflictNotice: LeaseLockConflictNoticeState | null
  setLeaseLockConflictNotice: (value: LeaseLockConflictNoticeState | null) => void
}

export function AppOverlays({
  renameTarget,
  setRenameTarget,
  renameValue,
  setRenameValue,
  confirmRename,
  deleteTarget,
  setDeleteTarget,
  confirmDelete,
  folderChildTarget,
  setFolderChildTarget,
  newFolderName,
  setNewFolderName,
  createSubfolder,
  selectionRect,
  normalizedSelectionRect,
  contextMenu,
  contextSelectedFonts,
  selectionLabel,
  runFontContextAction,
  deleteFontsBatch,
  uninstallFontsBatch,
  toggleFontDeleteProtection,
  runContextBatchActivate,
  runContextBatchDeactivate,
  runContextRefreshFolder,
  runContextRename,
  runContextAddSubfolder,
  runContextDelete,
  leaseLockConflictNotice,
  setLeaseLockConflictNotice
}: AppOverlaysProps): JSX.Element {
  return (
    <>
      <LeaseLockConflictNotice
        notice={leaseLockConflictNotice}
        onClose={() => setLeaseLockConflictNotice(null)}
      />

      {renameTarget && (
        <div className="modal-backdrop" onClick={() => setRenameTarget(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">
              重命名{renameTarget.kind === 'folder' ? '文件夹' : renameTarget.scope === 'shared' ? '共享标签' : '标签'}
            </div>
            <div className="modal-subtitle">{renameTarget.kind === 'folder' ? `原名称：${renameTarget.name}。保存后会重命名磁盘文件夹。` : `原名称：${renameTarget.name}`}</div>
            <input
              className="modal-input"
              value={renameValue}
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (isKeyboardCompositionEvent(event)) return
                if (event.key === 'Enter') void confirmRename()
                if (event.key === 'Escape') setRenameTarget(null)
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setRenameTarget(null)}>取消</button>
              <button onClick={() => void confirmRename()}>保存</button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">
              删除{deleteTarget.kind === 'folder' ? '文件夹' : deleteTarget.scope === 'shared' ? '共享标签' : '标签'}
            </div>
            <div className="modal-subtitle">
              {deleteTarget.kind === 'folder' ? `确定从软件列表移除“${deleteTarget.name}”吗？磁盘上的真实文件夹不会被删除。` : `确定删除“${deleteTarget.name}”吗？字体文件不会被删除，只会移除关系。`}
            </div>
            <div className="modal-actions danger">
              <button onClick={() => setDeleteTarget(null)}>取消</button>
              <button onClick={() => void confirmDelete()}>删除</button>
            </div>
          </div>
        </div>
      )}

      {folderChildTarget && (
        <div className="modal-backdrop" onClick={() => setFolderChildTarget(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">新增物理子文件夹</div>
            <div className="modal-subtitle">父级：{folderChildTarget.name}。将在磁盘创建真实子文件夹。</div>
            <input
              className="modal-input"
              value={newFolderName}
              autoFocus
              placeholder="子文件夹名称"
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (isKeyboardCompositionEvent(event)) return
                if (event.key === 'Enter') {
                  void createSubfolder(folderChildTarget, newFolderName)
                  setFolderChildTarget(null)
                  setNewFolderName('')
                }
                if (event.key === 'Escape') setFolderChildTarget(null)
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setFolderChildTarget(null)}>取消</button>
              <button onClick={() => {
                void createSubfolder(folderChildTarget, newFolderName)
                setFolderChildTarget(null)
                setNewFolderName('')
              }}>创建</button>
            </div>
          </div>
        </div>
      )}

      {selectionRect && (
        <div
          className="selection-rect"
          style={{
            left: normalizedSelectionRect(selectionRect).left,
            top: normalizedSelectionRect(selectionRect).top,
            width: normalizedSelectionRect(selectionRect).width,
            height: normalizedSelectionRect(selectionRect).height
          }}
        />
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.kind === 'font' ? (
            contextSelectedFonts.length > 1 ? (
              <>
                <div className="context-menu-title">{selectionLabel(contextSelectedFonts)}</div>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runFontContextAction('activate')}>批量激活</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runFontContextAction('deactivate')}>批量取消激活</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void deleteFontsBatch(contextSelectedFonts, '批量选择')}>批量删除文件</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void uninstallFontsBatch(contextSelectedFonts, '批量选择')}>批量卸载字体</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void toggleFontDeleteProtection(contextSelectedFonts.map((font) => font.id), true)}>加入保护不可删除</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void toggleFontDeleteProtection(contextSelectedFonts.map((font) => font.id), false)}>取消删除保护</button>
              </>
            ) : (
              <>
                <div className="context-menu-title">{selectionLabel(contextSelectedFonts)}</div>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runFontContextAction('install')}>安装</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runFontContextAction('remove')}>卸载/移除安装</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runFontContextAction('deleteFile')}>删除字体文件</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runFontContextAction('activate')}>激活</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runFontContextAction('deactivate')}>取消激活</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runFontContextAction('protectToggle')}>{contextSelectedFonts[0]?.deleteProtected ? '取消删除保护' : '加入保护不可删除'}</button>
              </>
            )
          ) : (
            <>
              {contextMenu.kind === 'tag' && <button onMouseDown={(event) => event.preventDefault()} onClick={runContextBatchActivate}>批量激活</button>}
              {contextMenu.kind === 'tag' && <button onMouseDown={(event) => event.preventDefault()} onClick={runContextBatchDeactivate}>批量取消激活</button>}
              {contextMenu.kind === 'folder' && <button onMouseDown={(event) => event.preventDefault()} onClick={runContextRefreshFolder}>刷新</button>}
              <button onMouseDown={(event) => event.preventDefault()} onClick={runContextRename}>重命名</button>
              {contextMenu.kind === 'folder' && <button onMouseDown={(event) => event.preventDefault()} onClick={runContextAddSubfolder}>新增子文件夹</button>}
              <button onMouseDown={(event) => event.preventDefault()} onClick={runContextDelete}>删除</button>
            </>
          )}
        </div>
      )}
    </>
  )
}
