import type { FontItem,InstallCompareResult } from '@shared/types'
import {
fontCategoryLabel,
fontFileDisplayName,
fontPostScriptDisplayName,
formatSize,
installLabel,
IS_DEVELOPMENT,
isCleanWindowsDefaultFont,
isInstalled,
scriptLabels
} from '../../appRuntime'

type FontDetailPanelProps = {
  visible: boolean
  selectedFont: FontItem | undefined
  previewText: string
  previewFamilies: Record<string, string>
  selectedPreviewFamily: string
  nativeDetailImage: string
  toggleFontFavorite: (font: FontItem) => Promise<void>
  installSelected: () => Promise<void>
  removeSelected: () => Promise<void>
  activateSelected: () => Promise<void>
  deactivateSelected: () => Promise<void>
  toggleFontDeleteProtection: (fontIds: string[], protect?: boolean) => Promise<void>
  assignTagName: string
  setAssignTagName: (value: string) => void
  handleLocalTagInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  localTagSuggestions: string[]
  activeLocalTagSuggestionIndex: number
  setActiveLocalTagSuggestionIndex: (index: number) => void
  addTagToSelectedByName: (name: string) => void
  removeTagFromSelected: (tag: string) => void
  assignSharedTagName: string
  setAssignSharedTagName: (value: string) => void
  handleSharedTagInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  sharedTagSuggestions: string[]
  activeSharedTagSuggestionIndex: number
  setActiveSharedTagSuggestionIndex: (index: number) => void
  addSharedTagToSelectedByName: (name: string) => void
  removeSharedTagFromSelected: (tag: string) => void
  updateFont: (fontId: string, updater: (font: FontItem) => FontItem) => void
  applyCompare: (font: FontItem, result: InstallCompareResult) => FontItem
}

export function FontDetailPanel({
  visible,
  selectedFont,
  previewText,
  previewFamilies,
  selectedPreviewFamily,
  nativeDetailImage,
  toggleFontFavorite,
  installSelected,
  removeSelected,
  activateSelected,
  deactivateSelected,
  toggleFontDeleteProtection,
  assignTagName,
  setAssignTagName,
  handleLocalTagInputKeyDown,
  localTagSuggestions,
  activeLocalTagSuggestionIndex,
  setActiveLocalTagSuggestionIndex,
  addTagToSelectedByName,
  removeTagFromSelected,
  assignSharedTagName,
  setAssignSharedTagName,
  handleSharedTagInputKeyDown,
  sharedTagSuggestions,
  activeSharedTagSuggestionIndex,
  setActiveSharedTagSuggestionIndex,
  addSharedTagToSelectedByName,
  removeSharedTagFromSelected,
  updateFont,
  applyCompare
}: FontDetailPanelProps): JSX.Element | null {
  if (!visible) return null

  const installMatches = selectedFont?.systemInstallMatches || []
  return (
    <section className="detail-panel detail-dock-panel">
      {selectedFont ? (
        <>
          <div className="detail-header">
            <div>
              <div className="detail-title">{fontFileDisplayName(selectedFont)}</div>
              <div className="detail-subtitle">{fontPostScriptDisplayName(selectedFont)}</div>
            </div>
          </div>


          <div className="detail-actions primary-actions">
            <button onClick={installSelected}>安装</button>
            <button onClick={removeSelected}>移除</button>
            <button onClick={activateSelected}>激活</button>
            <button onClick={deactivateSelected}>取消激活</button>
            <button title={selectedFont.deleteProtected ? '取消删除保护' : '加入保护不可删除'} onClick={() => { if (selectedFont) void toggleFontDeleteProtection([selectedFont.id]) }}>{selectedFont.deleteProtected ? '取消保护' : '保护'}</button>
            <button className={selectedFont.favorite ? 'detail-favorite-action active' : 'detail-favorite-action'} title={selectedFont.favorite ? '取消收藏' : '收藏'} onClick={() => void toggleFontFavorite(selectedFont)}>
              ★
            </button>
          </div>

          <div className="tag-box">
            <div className="tag-box-title">安装 / 激活状态</div>
            <div className="install-detail">
              <span className={isInstalled(selectedFont) || selectedFont.active ? 'state-pill active' : 'state-pill'}>
                {installLabel(selectedFont)}
              </span>
              {IS_DEVELOPMENT && installMatches.length ? (
                <div className="match-list">
                  {installMatches.slice(0, 5).map((match, index) => (
                    <div key={`${match.source}-${index}`} className="match-item">
                      {match.source} · {match.registryName || match.fileName}
                      {match.path ? <span>{match.path}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="tag-box">
            <div className="tag-box-title">标签</div>
            <div className="inline-create detail-create">
              <div className="tag-input-wrap">
                <input
                  value={assignTagName}
                  onChange={(event) => setAssignTagName(event.target.value)}
                  placeholder="输入标签名称"
                  onKeyDown={handleLocalTagInputKeyDown}
                />
                {localTagSuggestions.length > 0 && (
                  <div className="tag-suggestion-list">
                    {localTagSuggestions.map((tag, index) => (
                      <button
                        key={tag}
                        className={index === activeLocalTagSuggestionIndex ? 'active' : ''}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveLocalTagSuggestionIndex(index)}
                        onClick={() => addTagToSelectedByName(tag)}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => addTagToSelectedByName(localTagSuggestions[activeLocalTagSuggestionIndex] || assignTagName)}>添加标签</button>
            </div>
            <div className="tag-row">
              {(selectedFont.localTagNames || []).length ? (selectedFont.localTagNames || []).map((tag) => (
                <button key={tag} className="tag-pill removable" onClick={() => removeTagFromSelected(tag)}>
                  #{tag} ×
                </button>
              )) : <span className="empty">这个字体还没有标签</span>}
            </div>
          </div>

          <div className="tag-box">
            <div className="tag-box-title">共享标签</div>
            <div className="inline-create detail-create">
              <div className="tag-input-wrap">
                <input
                  value={assignSharedTagName}
                  onChange={(event) => setAssignSharedTagName(event.target.value)}
                  placeholder="输入共享标签名称"
                  onKeyDown={handleSharedTagInputKeyDown}
                />
                {sharedTagSuggestions.length > 0 && (
                  <div className="tag-suggestion-list">
                    {sharedTagSuggestions.map((tag, index) => (
                      <button
                        key={tag}
                        className={index === activeSharedTagSuggestionIndex ? 'active' : ''}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveSharedTagSuggestionIndex(index)}
                        onClick={() => addSharedTagToSelectedByName(tag)}
                      >
                        #{tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => addSharedTagToSelectedByName(sharedTagSuggestions[activeSharedTagSuggestionIndex] || assignSharedTagName)}>添加共享标签</button>
            </div>
            <div className="tag-row">
              {(selectedFont.tagNames || []).length ? selectedFont.tagNames.map((tag) => (
                <button key={tag} className="tag-pill removable" onClick={() => removeSharedTagFromSelected(tag)}>
                  #{tag} ×
                </button>
              )) : <span className="empty">这个字体还没有共享标签</span>}
            </div>
          </div>

          <div className="detail-actions secondary-actions">
            <button onClick={() => void window.hfm.compareFontInstalled(selectedFont).then((result) => updateFont(selectedFont.id, (font) => applyCompare(font, result)))}>重新检测这个字体</button>
            <button onClick={() => window.hfm.showItemInFolder(selectedFont.path)}>在资源管理器中显示</button>
          </div>

          <div className="info-grid">
            <div>文件名</div><div>{selectedFont.fileName}</div>
            <div>格式</div><div>{selectedFont.format.toUpperCase()}</div>
            <div>语言</div><div>{scriptLabels(selectedFont).join(' / ') || '未知'}</div>
            <div>分类</div><div>{fontCategoryLabel(selectedFont)}</div>
            <div>样式</div><div>{selectedFont.style || '未知'}</div>
            <div>PostScript</div><div>{selectedFont.postscriptName || '未知'}</div>
            <div>大小</div><div>{formatSize(selectedFont.fileSize)}</div>
            <div>路径</div><div className="path">{selectedFont.path}</div>
            <div>来源</div><div>{selectedFont.systemImported ? 'Windows 已安装字体' : '字体文件夹扫描'}</div>
            <div>临时激活</div><div>{selectedFont.active ? `已激活 ${selectedFont.activeSince || ''}` : '未激活'}</div>
            <div>删除保护</div><div>{selectedFont.deleteProtected ? '已保护，不允许删除/卸载' : isCleanWindowsDefaultFont(selectedFont) ? '自动保护' : '未保护'}</div>
          </div>
        </>
      ) : (
        <div className="empty-state">
          <div>请选择一个字体</div>
          <p>读取索引或更新索引后，这里会显示预览和详细信息。</p>
        </div>
      )}
    </section>
  )
}
