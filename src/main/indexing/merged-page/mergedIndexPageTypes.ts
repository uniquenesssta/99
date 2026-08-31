import type {
  FontIndexChangePayload,
  FontItem,
  FontTagRevisionMetadata,
  FontQueryPageResult,
  FontQueryRequest,
} from "../../../shared/types";
import type { MergedIndexSourceInfo } from "../mergedIndexRuntime";
import type { MergedIndexPageRow } from "../rootIndexQuerySql";
import type { MergedIndexMutationContext } from "./mergedIndexMutationCoordinatorRuntime";

export type SqliteDb = any;

export type RustMergedIndexPageQueryRuntimeLike = {
  runRustMergedIndexPageQuery: (request: {
    queryKey: string;
    request: FontQueryRequest;
    limit: number;
    offset: number;
    roots: string[];
    mergedIndexDbPath: string;
    libraryDbPath: string;
    schemaVersion: number;
    tagRevision?: FontTagRevisionMetadata | Record<string, unknown>;
    sql: {
      sql: string;
      countSql: string;
      params: unknown[];
      countParams: unknown[];
      usedLike: boolean;
    };
  }) => Promise<
    | (FontQueryPageResult & {
        timings?: Record<string, number>;
        elapsedMs?: number;
      })
    | null
  >;
  runRustMergedIndexRebuild: (request: {
    mergedIndexDbPath: string;
    schemaVersion: number;
    sourcesKey: string;
    syncedAt: string;
    sources: Array<{
      root: string;
      indexDbPath: string;
      installDbPath?: string;
      indexSignature: string;
      installSignature: string;
      sharedMetadataSignature?: string;
    }>;
  }) => Promise<{
    rebuilt: boolean;
    rows: number;
    elapsedMs?: number;
    timings?: Record<string, number>;
    indexProtocol?: unknown;
  } | null>;
  runRustMergedIndexSync: (request: {
    mergedIndexDbPath: string;
    schemaVersion: number;
    sourcesKey: string;
    syncedAt: string;
    source: {
      root: string;
      indexDbPath: string;
      installDbPath?: string;
      indexSignature: string;
      installSignature: string;
      sharedMetadataSignature?: string;
    };
    relativePaths?: string[];
    fullSnapshot?: boolean;
    reason?: string;
  }) => Promise<{
    synced: boolean;
    changed: number;
    rows: number;
    fullSnapshot: boolean;
    elapsedMs?: number;
    timings?: Record<string, number>;
    indexProtocol?: unknown;
  } | null>;
};

export type DbQueryWorkerRuntimeLike = {
  queryMergedIndexPage: (request: {
    queryKey: string;
    request: FontQueryRequest;
    limit: number;
    offset: number;
    roots: string[];
    mergedIndexDbPath: string;
    libraryDbPath: string;
    schemaVersion: number;
    sql: {
      sql: string;
      countSql: string;
      params: unknown[];
      countParams: unknown[];
      usedLike: boolean;
    };
  }) => Promise<
    FontQueryPageResult & {
      timings?: Record<string, number>;
      elapsedMs?: number;
    }
  >;
};

export type CreateMergedIndexPageRuntimeOptions = {
  dataPath: (...parts: string[]) => string;
  exists: (filePath: string) => Promise<boolean>;
  openStableSqliteDb: (filePath: string, label: string) => SqliteDb;
  openRootIndexDb: (
    dbPath: string,
    rootPath: string,
    storage: any,
    touchMeta?: boolean,
  ) => Promise<SqliteDb>;
  closeSqliteDb: (db: SqliteDb) => void;
  getSqliteMeta: (db: SqliteDb, key: string, fallback?: string) => string;
  setSqliteMeta: (db: SqliteDb, key: string, value: string) => void;
  sqliteTableExists: (db: SqliteDb, tableName: string) => boolean;
  appendStartupLog: (message: string) => void;
  schemaVersion: number;
  staleFirstPageEnabled: boolean;
  backgroundValidateIntervalMs: number;
  appWatchedFolders: () => Promise<string[]>;
  activeRootIndexDbPathForRoot: (rootPath: string) => Promise<string>;
  installStatusDbPathForRoot: (rootPath: string) => Promise<string>;
  attachInstallStatusDbIfAvailable: (
    db: SqliteDb,
    rootPath: string,
  ) => Promise<boolean>;
  cacheKeyForRootFile: (rootPath: string, filePath: string) => string;
  pathInsideFolder: (folderPath: string, filePath: string) => boolean;
  normalizePathForCacheCompare: (value: string) => string;
  dbQueryWorkerRuntime: DbQueryWorkerRuntimeLike;
  rustCoreWorkerRuntime: RustMergedIndexPageQueryRuntimeLike;
  librarySqlitePath: () => string;
  openLibraryDb: () => Promise<SqliteDb>;
  rootIndexSqliteJsonAvailable: (db: SqliteDb) => boolean;
  fontFromRootIndexPageRow: (
    rootPath: string,
    row: MergedIndexPageRow,
  ) => FontItem | null;
  hydrateLocalTagsForFonts: (items: FontItem[]) => Promise<FontItem[]>;
  applySharedMetadataToMergedRows: (
    rootPath: string,
    rows: MergedIndexPageRow[],
  ) => Promise<MergedIndexPageRow[]>;
  sharedMetadataSignatureForRoot: (rootPath: string) => Promise<string>;
  delayToEventLoop: () => Promise<void>;
  tagRevisionSnapshotForRequest?: (
    request: FontQueryRequest,
  ) => FontTagRevisionMetadata | Record<string, unknown>;
  onMergedIndexCommitted?: (event: {
    reason: string;
    sequence: number;
    revision: number;
  }) => void;
};

export type MergedIndexPageContext = CreateMergedIndexPageRuntimeOptions & {
  mergedIndexDbPath: () => string;
  rootIndexContentSignature: (
    indexDbPath: string,
    rootPath: string,
  ) => Promise<string>;
  installStatusContentSignature: (installDbPath?: string) => Promise<string>;
  openMergedIndexDb: () => Promise<SqliteDb>;
  mergedIndexSourcesKey: (sources: MergedIndexSourceInfo[]) => string;
  mergedIndexRootsKey: (roots: string[]) => string;
  mergedIndexLocalSnapshotUsable: (db: SqliteDb, roots: string[]) => boolean;
  mergedIndexInsertStatement: (db: SqliteDb) => any;
  writeMergedIndexSourceRow: (
    db: SqliteDb,
    source: MergedIndexSourceInfo,
    syncedAt: string,
  ) => void;
  bindMergedIndexRow: (
    row: MergedIndexPageRow,
    rootPath: string,
    cachedAt: string,
  ) => Record<string, unknown>;
  mergedIndexSourcesMatchRoots: (db: SqliteDb, roots: string[]) => boolean;
  ensureMergedIndexPendingSnapshotForRoots: (
    db: SqliteDb,
    roots: string[],
  ) => void;
  relativePathsFromFontIndexPayloadRuntime: (
    rootPath: string,
    payload: FontIndexChangePayload,
    cacheKeyForRootFile: (rootPath: string, filePath: string) => string,
    pathInsideFolder: (folderPath: string, filePath: string) => boolean,
  ) => string[];
  mergedIndexRebuildInFlight: Map<string, Promise<void>>;
  mergedIndexReadyProcessKeys: Set<string>;
  mergedIndexValidateInFlight: Map<string, Promise<void>>;
  mergedIndexLastValidateAt: Map<string, number>;
  runMergedIndexMutation: <T>(
    label: string,
    action: (context: MergedIndexMutationContext) => Promise<T>,
  ) => Promise<T>;
  waitForMergedIndexMutations: () => Promise<void>;
};

export type MergedIndexSourceRuntime = {
  mergedIndexSourcesForRoots: (
    roots: string[],
  ) => Promise<MergedIndexSourceInfo[]>;
  readMergedRowsForSource: (
    source: MergedIndexSourceInfo,
    relativePaths?: string[],
  ) => Promise<MergedIndexPageRow[]>;
  relativePathsFromFontIndexPayload: (
    rootPath: string,
    payload: FontIndexChangePayload,
  ) => string[];
};

export type MergedIndexBuildRuntime = {
  rebuildMergedIndexDb: (
    db: SqliteDb,
    sources: MergedIndexSourceInfo[],
    sourcesKey: string,
  ) => Promise<void>;
  ensureMergedIndexBuilt: (
    db: SqliteDb,
    sources: MergedIndexSourceInfo[],
    sourcesKey: string,
  ) => Promise<void>;
};
