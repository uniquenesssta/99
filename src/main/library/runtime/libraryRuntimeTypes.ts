import type { FontItem } from "../../../shared/types";

export type SqliteDb = any;


export type LocalTagsMutationStateSignal = {
  mutationKind?: string;
  dbPath?: string;
  changedIds?: string[];
  updatedAt?: string;
  localTagsChanged?: boolean;
  cacheInvalidated?: boolean;
  pageQueryDirty?: boolean;
  metricsDirty?: boolean;
  knownTags?: string[];
  source?: 'rust-worker' | 'node-fallback' | 'rust-daemon';
};

export type LibraryRuntimeOptions = {
  librarySqlitePath: () => string;
  openRecoverableApplicationSqliteDb: (
    path: string,
    label: "library",
  ) => Promise<SqliteDb>;
  closeSqliteDb: (db: SqliteDb | null) => void;
  ensureSqliteColumn: (
    db: SqliteDb,
    table: string,
    column: string,
    declaration: string,
  ) => void;
  loadSharedFontsForFolders: (folders: string[]) => Promise<FontItem[]>;
  countSharedFontsForFolders: (folders: string[]) => Promise<number>;
  invalidateSharedFontRuntimeCaches: () => void;
  appendStartupLog: (message: string) => void;
  runRustLocalTagsRead?: (input: {
    dbPath: string;
    rows: Array<{ itemId: string; aliases: string[]; fontPath: string }>;
  }) => Promise<{ tagMap: Record<string, string[]>; knownTags?: string[]; signature?: string } | null>;
  runRustLocalTagsSet?: (input: {
    dbPath: string;
    updatedAt: string;
    rows: Array<{ itemId: string; aliases: string[]; fontPath: string; tagNames: string[] }>;
  }) => Promise<{ updatedIds: string[]; written: number; previousKnownTags?: string[]; knownTags?: string[]; addedKnownTags?: string[]; removedKnownTags?: string[]; retainedEmptyTags?: string[]; stateSignal?: LocalTagsMutationStateSignal; mutationProtocol?: import("../../../shared/types").FontTagUpdateResult['mutationProtocol'] } | null>;
  runRustLocalTagsDeleteTag?: (input: {
    dbPath: string;
    tagName: string;
    updatedAt: string;
  }) => Promise<{ updatedIds: string[]; updated: number; previousKnownTags?: string[]; knownTags?: string[]; addedKnownTags?: string[]; removedKnownTags?: string[]; stateSignal?: LocalTagsMutationStateSignal; mutationProtocol?: import("../../../shared/types").FontTagUpdateResult['mutationProtocol'] } | null>;
  onLocalTagsMutationStateSignal?: (signal: LocalTagsMutationStateSignal) => void;
};
