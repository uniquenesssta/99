import type { FontItem,LibraryState } from '../../shared/types';
import { createLegacyCollectionStateFields,normalizeLegacyCollectionIds } from '../../shared/legacy/legacyCollectionCompatibility';
import { normalizeNativePathText } from '../path/pathCanonicalizer';


function normalizeStoredFolderNodePath(value: unknown): string {
  const text = String(value || '')
  if (!text || text.startsWith('vf_')) return text
  return normalizeNativePathText(text)
}

function normalizeStoredFontFolderIds(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([fontId, ids]) => [
        fontId,
        Array.from(new Set(
          (Array.isArray(ids) ? ids : [])
            .map(normalizeStoredFolderNodePath)
            .filter(Boolean),
        )),
      ])
      .filter(([, ids]) => (ids as string[]).length > 0),
  )
}

export function defaultLibrary(): LibraryState {
  return {
    folders: [],
    fonts: {},
    ...createLegacyCollectionStateFields(),
    tags: [],
    localTags: [],
    previewText: '中文字体预览 字体管理器\nAaBbCc 0123456789\n春眠不觉晓，处处闻啼鸟。',
    previewMode: 'waterfall'
  }
}

export function normalizeLoadedLibrary(parsed: Partial<LibraryState> & { autoActivationRules?: unknown; projects?: unknown }): LibraryState {
  return {
    ...defaultLibrary(),
    ...parsed,
    ...createLegacyCollectionStateFields(parsed),
    fonts: Object.fromEntries(
      Object.entries(parsed.fonts || {}).map(([id, font]) => [
        id,
        {
          ...(font as FontItem),
          tagNames: Array.isArray((font as FontItem).tagNames) ? (font as FontItem).tagNames : [],
          localTagNames: Array.isArray((font as FontItem).localTagNames) ? (font as FontItem).localTagNames : [],
          collectionIds: normalizeLegacyCollectionIds((font as FontItem).collectionIds),
          systemInstalled: !!(font as FontItem).systemInstalled,
          systemInstallMatches: Array.isArray((font as FontItem).systemInstallMatches) ? (font as FontItem).systemInstallMatches : [],
          active: false,
          systemImported: !!(font as FontItem).systemImported,
          deleteProtected: !!(font as FontItem).deleteProtected,
          scripts: Array.isArray((font as FontItem).scripts) ? (font as FontItem).scripts : [],
          previewDisabled: !!(font as FontItem).previewDisabled,
          previewError: (font as FontItem).previewError,
          activeSince: undefined
        }
      ])
    ),
    folderAliases: parsed.folderAliases && typeof parsed.folderAliases === 'object' ? parsed.folderAliases : {},
    folderNodes: Array.isArray(parsed.folderNodes)
      ? parsed.folderNodes.map((node) => ({
        ...node,
        id: normalizeStoredFolderNodePath(node?.id),
        parentId: normalizeStoredFolderNodePath(node?.parentId),
        rootPath: normalizeStoredFolderNodePath(node?.rootPath),
      })).filter((node) => !!node.id)
      : [],
    fontFolderIds: normalizeStoredFontFolderIds(parsed.fontFolderIds),
    folders: Array.isArray(parsed.folders)
      ? Array.from(new Set(parsed.folders.map(normalizeStoredFolderNodePath).filter(Boolean)))
      : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    localTags: Array.isArray(parsed.localTags) ? parsed.localTags : [],
    previewText: typeof parsed.previewText === 'string' ? parsed.previewText : defaultLibrary().previewText,
    previewMode: parsed.previewMode || 'waterfall'
  }
}
