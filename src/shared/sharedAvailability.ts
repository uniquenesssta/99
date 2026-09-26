import type { FontItem } from './types'

export type SharedAvailability = {
  roots: Array<{ path: string; rootId: string; state: 'checking' | 'online' | 'offline' | 'recovering'; generation: number; resourceKeys?: string[]; tags: string[] }>
  tags: string[]
  unattributedTags: string[]
}
export function isSharedAvailability(value: unknown): value is SharedAvailability {
  if (!value || typeof value !== 'object') return false
  const dto = value as Partial<SharedAvailability>
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string')
  return strings(dto.tags) && strings(dto.unattributedTags) && Array.isArray(dto.roots) && dto.roots.every(root =>
    root && typeof root.path === 'string' && !!root.path && typeof root.rootId === 'string' && !!root.rootId &&
    ['checking', 'online', 'offline', 'recovering'].includes(root.state) && Number.isFinite(root.generation) && strings(root.tags) && (root.resourceKeys === undefined || strings(root.resourceKeys)))
}
export const SHARED_UNAVAILABLE_MESSAGE = '共享位置离线或尚未确认可用，本次操作未执行；原有记录已保留。'

// Lexical only: no filesystem access, drive discovery or renderer authority.
export function availabilityPath(value: string): string {
  const prefix = /^[\\/]{2}/.test(value) ? '//' : value.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part.toLowerCase())
  }
  return prefix + parts.join('/')
}
export function pathRoots(snapshot: SharedAvailability, value: string) {
  const path = availabilityPath(value)
  return snapshot.roots.filter(root => [root.path, root.rootId].some(raw => {
    const key = availabilityPath(raw)
    return path === key || path.startsWith(key + '/')
  }))
}
export function sharedPathBlocked(snapshot: SharedAvailability | null, value: string): boolean {
  if (!snapshot) return true
  const roots = pathRoots(snapshot, value)
  return roots.length ? roots.some(root => root.state !== 'online') : availabilityPath(value).startsWith('//')
}
export function sharedTagBlocked(snapshot: SharedAvailability | null, tag?: string): boolean {
  if (!snapshot) return true
  const owned = tag && !snapshot.unattributedTags.includes(tag) ? snapshot.roots.filter(root => root.tags.includes(tag)) : []
  return (owned.length ? owned : snapshot.roots).some(root => root.state !== 'online')
}
export function fontSharedActionBlocked(snapshot: SharedAvailability | null, action: string, fonts: FontItem[]): boolean {
  if (!['install', 'activate', 'deleteFile', 'sharedTags'].includes(action)) return false
  return fonts.some(font => sharedPathBlocked(snapshot, font.path)) || (action === 'sharedTags' && sharedTagBlocked(snapshot))
}
