export {
applyFolderCacheToLibrary,
applyFolderTreeToLibrary,
buildFolderTreeFromCachedFonts,
parentFolderPath,
replaceFolderPathInLibrary,
replacePathPrefixValue
} from './library-normalize/libraryFolderTreeRuntime'
export {
applyEarlyVisibleFontIndexChangeToLibrary,
isEarlyVisibleOnlyFontIndexChangePayload
} from './library-normalize/libraryEarlyVisibleIndexChangeRuntime'
export {
applyFontIndexChangeToLibrary,
mergeIncrementalIndexedFont
} from './library-normalize/libraryIndexChangeRuntime'
export {
createEmptyLibrary,
flattenFolderNodes,
folderBaseName,
folderDepth,
folderDisplayName,
folderHasChildren,
folderPhysicalPath,
fontAssignedToFolder,
fontBelongsToAnyFolder,
fontBelongsToFolder,
fontInsideRootFolder,
isDefinitelyBadFontRecord,
isPhysicalFolderId,
makeVirtualFolderId,
normalizeFolderPathForCompare,
normalizeFontPathForCompare,
updateMovedFontPath
} from './library-normalize/libraryNormalizeBase'
export {
libraryWithMergedFonts,
markPartialLibrary,
mergeAndPruneScannedFonts,
mergeScannedFonts,
normalizeLibrary,
pruneFontFolderIds,
pruneRecordByKeyLimit
} from './library-normalize/libraryNormalizeStateRuntime'
