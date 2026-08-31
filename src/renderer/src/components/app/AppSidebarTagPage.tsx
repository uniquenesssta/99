import type { MouseEvent } from 'react'
import { handleTagCreateInputKeyDown } from '../../fontTagInputRuntime'

type AppSidebarTagPageProps = {
  title: string
  inputValue: string
  setInputValue: (value: string) => void
  createFromInput: () => void
  tagList: string[]
  selectedTagName: string
  setSelectedTagName: (value: string) => void
  openTagMenu: (event: MouseEvent, tag: string) => void
  tagCounts: Record<string, number>
  emptyText: string
  inputPlaceholder: string
  navTitle: string
}

export function AppSidebarTagPage({
  title,
  inputValue,
  setInputValue,
  createFromInput,
  tagList,
  selectedTagName,
  setSelectedTagName,
  openTagMenu,
  tagCounts,
  emptyText,
  inputPlaceholder,
  navTitle,
}: AppSidebarTagPageProps): JSX.Element {
  return (
    <div className="sidebar-page">
      <div className="section-title">新建{title}</div>
      <div className="inline-create">
        <input
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder={inputPlaceholder}
          onKeyDown={(event) => handleTagCreateInputKeyDown(event, createFromInput)}
        />
        <button onClick={createFromInput}>添加</button>
      </div>

      <div className="section-title with-gap">{title}管理</div>
      {tagList.length ? tagList.map((tag) => (
        <button
          key={tag}
          data-compact-label="#"
          className={selectedTagName === tag ? 'nav active tag-nav' : 'nav tag-nav'}
          onClick={() => setSelectedTagName(selectedTagName === tag ? '' : tag)}
          onContextMenu={(event) => openTagMenu(event, tag)}
          title={navTitle}
        >
          #{tag}
          <span>{tagCounts[tag] || 0}</span>
        </button>
      )) : <div className="empty">{emptyText}</div>}
    </div>
  )
}
