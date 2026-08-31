import type { JSX } from 'react'

type SidebarIconName =
  | 'library'
  | 'filters'
  | 'tags'
  | 'sharedTags'
  | 'folders'
  | 'favorites'
  | 'installed'
  | 'notInstalled'
  | 'active'
  | 'developer'

type SidebarIconProps = {
  name: SidebarIconName
  className?: string
}

function iconPath(name: SidebarIconName): JSX.Element {
  switch (name) {
    case 'library':
      return (
        <>
          <rect x="3" y="3" width="5" height="5" rx="1.2" />
          <rect x="10" y="3" width="5" height="5" rx="1.2" />
          <rect x="3" y="10" width="5" height="5" rx="1.2" />
          <rect x="10" y="10" width="5" height="5" rx="1.2" />
        </>
      )
    case 'filters':
      return <path d="M3 4h10l-4 4.8v3.7l-2 1.2V8.8L3 4Z" />
    case 'tags':
      return <path d="M4 5.2V12l4.7 3L14.8 9 11 5.2H4Zm2.2 2.1a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
    case 'sharedTags':
      return (
        <>
          <path d="M4 5.2V12l4.7 3L14.8 9 11 5.2H4Zm2.2 2.1a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" />
          <path d="M9.8 3.3c1.9-.1 3.5 1.1 3.9 2.8" />
          <path d="M12.2 2.1 14 3.6l-1.9 1.2" />
        </>
      )
    case 'folders':
      return <path d="M2.8 5.5h3.2l1.5 1.6H13a1.5 1.5 0 0 1 1.5 1.5v3.7A1.7 1.7 0 0 1 12.8 14H4.2a1.7 1.7 0 0 1-1.7-1.7V6.9a1.4 1.4 0 0 1 1.4-1.4Z" />
    case 'favorites':
      return <path d="m8 2.9 1.6 3.3 3.7.5-2.7 2.6.7 3.7L8 11.2 4.7 13l.7-3.7L2.7 6.7l3.7-.5L8 2.9Z" />
    case 'installed':
      return <path d="M8 2.8v6.3m0 0 2.6-2.6M8 9.1 5.4 6.5M3.5 11.2v1a1.3 1.3 0 0 0 1.3 1.3h6.4a1.3 1.3 0 0 0 1.3-1.3v-1" />
    case 'notInstalled':
      return <path d="M8 13.2V6.9m0 0 2.6 2.6M8 6.9 5.4 9.5M3.5 4.8v-1a1.3 1.3 0 0 1 1.3-1.3h6.4a1.3 1.3 0 0 1 1.3 1.3v1" />
    case 'active':
      return <path d="M8 2.9v10.2M4.8 6.1 8 2.9l3.2 3.2M4 11.7h8" />
    case 'developer':
      return <path d="m5.2 12.6-2.3-2.3 2.3-2.3M10.8 7.9l2.3 2.4-2.3 2.3M9.3 3.6 6.7 13" />
    default:
      return <circle cx="8" cy="8" r="4.5" />
  }
}

export function AppSidebarIcon({ name, className = '' }: SidebarIconProps): JSX.Element {
  return (
    <span className={`sidebar-icon ${className}`.trim()} aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {iconPath(name)}
      </svg>
    </span>
  )
}
