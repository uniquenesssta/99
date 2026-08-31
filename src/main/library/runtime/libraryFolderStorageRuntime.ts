import { normalizeWatchedFontFolders } from "../../path/fontPathPolicy";

export function sanitizeWatchedFoldersForStorage(folders: string[]): string[] {
  return normalizeWatchedFontFolders(folders);
}
