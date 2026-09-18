import { useSharedAvailability } from '../../sharedAvailabilityRuntime'
import { sharedTagBlocked, SHARED_UNAVAILABLE_MESSAGE } from '../../../../shared/sharedAvailability'
import type { MouseEvent } from 'react'
import { handleTagCreateInputKeyDown } from '../../fontTagInputRuntime'

type AppSidebarTagPageProps = {
  shared?: boolean
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
  shared = false,
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
  const availability = useSharedAvailability()
  const blocked = shared && sharedTagBlocked(availability)
  return (
    <div className="sidebar-page">
      <div className="section-title">新建{title}</div>
      <div className="inline-create">
        <input
          disabled={blocked}
          aria-disabled={blocked}
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          placeholder={inputPlaceholder}
          onKeyDown={(event) => !blocked && handleTagCreateInputKeyDown(event, createFromInput)}
        />
        <button disabled={blocked} aria-disabled={blocked} onClick={() => { if (!blocked) createFromInput() }}>添加</button>
      </div>

      {blocked && <div role="status">共享位置不可用，标签与上次记录保留。</div>}
      <div className="section-title with-gap">{title}管理</div>
      {tagList.length ? tagList.map((tag) => (
        <button
          key={tag}
          disabled={shared && sharedTagBlocked(availability, tag)}
          aria-disabled={shared && sharedTagBlocked(availability, tag)}
          data-compact-label="#"
          className={selectedTagName === tag ? 'nav active tag-nav' : 'nav tag-nav'}
          onClick={() => { if (!shared || !sharedTagBlocked(availability, tag)) setSelectedTagName(selectedTagName === tag ? '' : tag) }}
          onContextMenu={(event) => { event.preventDefault(); if (!shared || !sharedTagBlocked(availability, tag)) openTagMenu(event, tag) }}
          title={shared && sharedTagBlocked(availability, tag) ? SHARED_UNAVAILABLE_MESSAGE : navTitle}
        >
          #{tag}
          <span>{tagCounts[tag] || 0}</span>
        </button>
      )) : <div className="empty">{emptyText}</div>}
    </div>
  )
}
