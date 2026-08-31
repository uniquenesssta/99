import type { FontItem,LibraryState } from '@shared/types'
import { ensureLibraryTagNamesContainFontTags,markFontTagsOptimistic } from './fontTagStateAuthorityRuntime'

export type FontTagScope = 'local' | 'shared'

const TAG_LOCALE = 'zh-Hans-CN'

export function sortedUniqueTagNames(tags: string[]): string[] {
  return Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b, TAG_LOCALE))
}

export function tagNameListWithValue(current: string[] | undefined, tag: string): string[] {
  return sortedUniqueTagNames([...(current || []), tag])
}

export function renamedTagNameList(current: string[] | undefined, from: string, to: string): string[] {
  return Array.from(new Set((current || []).map((item) => item === from ? to : item)))
}

export function removedTagNameList(current: string[] | undefined, tag: string): string[] {
  return (current || []).filter((item) => item !== tag)
}

export function addTagNameToLibrary(library: LibraryState, scope: FontTagScope, tag: string): LibraryState {
  return {
    ...library,
    ...(scope === 'shared'
      ? { tags: tagNameListWithValue(library.tags, tag) }
      : { localTags: tagNameListWithValue(library.localTags, tag) })
  }
}

export function addTagToFontInLibrary(
  library: LibraryState,
  font: FontItem,
  scope: FontTagScope,
  tag: string
): { library: LibraryState; font: FontItem; tags: string[] } {
  const tags = tagNameListWithValue(scope === 'shared' ? font.tagNames : font.localTagNames, tag)
  const nextFont = markFontTagsOptimistic(font, scope, tags)

  return {
    library: ensureLibraryTagNamesContainFontTags({
      ...addTagNameToLibrary(library, scope, tag),
      fonts: {
        ...library.fonts,
        [font.id]: nextFont
      }
    }),
    font: nextFont,
    tags
  }
}

export function renameTagInLibrary(
  library: LibraryState,
  scope: FontTagScope,
  from: string,
  to: string
): LibraryState {
  const shared = scope === 'shared'
  return ensureLibraryTagNamesContainFontTags({
    ...library,
    ...(shared
      ? { tags: sortedUniqueTagNames((library.tags || []).map((item) => item === from ? to : item)) }
      : { localTags: sortedUniqueTagNames((library.localTags || []).map((item) => item === from ? to : item)) }),
    fonts: Object.fromEntries(
      Object.entries(library.fonts).map(([id, font]) => [
        id,
        shared
          ? markFontTagsOptimistic(font, 'shared', renamedTagNameList(font.tagNames, from, to))
          : markFontTagsOptimistic(font, 'local', renamedTagNameList(font.localTagNames, from, to))
      ])
    )
  })
}

export function deleteTagFromLibrary(
  library: LibraryState,
  scope: FontTagScope,
  tag: string
): LibraryState {
  const shared = scope === 'shared'
  return ensureLibraryTagNamesContainFontTags({
    ...library,
    ...(shared
      ? { tags: (library.tags || []).filter((item) => item !== tag) }
      : { localTags: (library.localTags || []).filter((item) => item !== tag) }),
    fonts: Object.fromEntries(
      Object.entries(library.fonts).map(([id, font]) => [
        id,
        shared
          ? markFontTagsOptimistic(font, 'shared', removedTagNameList(font.tagNames, tag))
          : markFontTagsOptimistic(font, 'local', removedTagNameList(font.localTagNames, tag))
      ])
    )
  })
}
