import type { FontQueryRequest } from '@shared/types';

export function fontQueryOrderBy(request: FontQueryRequest): string {
  const sortMode = request.sortMode || "smart";
  const timeSortMode = request.timeSortMode || "created";
  if (sortMode === "smart") {
    if (timeSortMode === "created")
      return "fonts.favorite DESC, (fonts.active = 1 OR COALESCE(install_status.by_type, 'none') IN ('managed', 'both')) DESC, (COALESCE(install_status.installed, fonts.system_installed) = 1 AND COALESCE(install_status.by_type, '') <> 'managed') DESC, COALESCE(fonts.created_at, 0) DESC, fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
    return "fonts.favorite DESC, (fonts.active = 1 OR COALESCE(install_status.by_type, 'none') IN ('managed', 'both')) DESC, (COALESCE(install_status.installed, fonts.system_installed) = 1 AND COALESCE(install_status.by_type, '') <> 'managed') DESC, fonts.modified_at DESC, fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
  }
  if (sortMode === "nameAsc")
    return "fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
  if (sortMode === "nameDesc")
    return "fonts.file_name COLLATE NOCASE DESC, fonts.id ASC";
  if (sortMode === "createdDesc")
    return "COALESCE(fonts.created_at, 0) DESC, fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
  if (sortMode === "createdAsc")
    return "COALESCE(fonts.created_at, 0) ASC, fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
  if (sortMode === "modifiedDesc")
    return "fonts.modified_at DESC, fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
  if (sortMode === "modifiedAsc")
    return "fonts.modified_at ASC, fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
  if (sortMode === "sizeDesc")
    return "fonts.file_size DESC, fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
  if (sortMode === "sizeAsc")
    return "fonts.file_size ASC, fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
  return "fonts.file_name COLLATE NOCASE ASC, fonts.id ASC";
}
