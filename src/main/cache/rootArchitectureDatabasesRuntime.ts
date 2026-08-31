import { promises as fsp } from "node:fs";

export type RootArchitectureDatabasesRuntimeOptions = {
  rootIndexDbDir: (rootPath: string) => string;
  rootEventsDbPath: (rootPath: string) => string;
  rootHashDbPath: (rootPath: string) => string;
  rootMetricsDbPath: (rootPath: string) => string;
  openStableSqliteDb: (filePath: string, label: string) => any;
  closeSqliteDb: (db: any | null | undefined) => void;
  setSqliteMeta: (db: any, key: string, value: string) => void;
};

function initializeRootEventsDb(
  db: any,
  rootPath: string,
  setSqliteMeta: (db: any, key: string, value: string) => void,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  `);
  setSqliteMeta(db, "schemaVersion", "1");
  setSqliteMeta(db, "cacheArchitecture", "v1-clean-shared-root");
  setSqliteMeta(db, "rootPath", rootPath);
}

function initializeRootHashDb(
  db: any,
  rootPath: string,
  setSqliteMeta: (db: any, key: string, value: string) => void,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS file_hashes (
      relative_path TEXT PRIMARY KEY,
      quick_signature TEXT NOT NULL,
      content_hash TEXT,
      font_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_hashes_font_id ON file_hashes(font_id);
    CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(content_hash);
  `);
  setSqliteMeta(db, "schemaVersion", "1");
  setSqliteMeta(db, "cacheArchitecture", "v1-clean-shared-root");
  setSqliteMeta(db, "rootPath", rootPath);
}

function initializeRootMetricsDb(
  db: any,
  rootPath: string,
  setSqliteMeta: (db: any, key: string, value: string) => void,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  setSqliteMeta(db, "schemaVersion", "1");
  setSqliteMeta(db, "cacheArchitecture", "v1-clean-shared-root");
  setSqliteMeta(db, "rootPath", rootPath);
}

export function createRootArchitectureDatabasesRuntime(
  options: RootArchitectureDatabasesRuntimeOptions,
) {
  const {
    rootIndexDbDir,
    rootEventsDbPath,
    rootHashDbPath,
    rootMetricsDbPath,
    openStableSqliteDb,
    closeSqliteDb,
    setSqliteMeta,
  } = options;

  async function ensureRootArchitectureDatabases(
    rootPath: string,
  ): Promise<void> {
    await fsp.mkdir(rootIndexDbDir(rootPath), { recursive: true });
    const eventsDb = openStableSqliteDb(
      rootEventsDbPath(rootPath),
      "root-events",
    );
    try {
      initializeRootEventsDb(eventsDb, rootPath, setSqliteMeta);
    } finally {
      closeSqliteDb(eventsDb);
    }
    const hashDb = openStableSqliteDb(rootHashDbPath(rootPath), "root-hash");
    try {
      initializeRootHashDb(hashDb, rootPath, setSqliteMeta);
    } finally {
      closeSqliteDb(hashDb);
    }
    const metricsDb = openStableSqliteDb(
      rootMetricsDbPath(rootPath),
      "root-metrics",
    );
    try {
      initializeRootMetricsDb(metricsDb, rootPath, setSqliteMeta);
    } finally {
      closeSqliteDb(metricsDb);
    }
  }

  return {
    initializeRootEventsDb: (db: any, rootPath: string) =>
      initializeRootEventsDb(db, rootPath, setSqliteMeta),
    initializeRootHashDb: (db: any, rootPath: string) =>
      initializeRootHashDb(db, rootPath, setSqliteMeta),
    initializeRootMetricsDb: (db: any, rootPath: string) =>
      initializeRootMetricsDb(db, rootPath, setSqliteMeta),
    ensureRootArchitectureDatabases,
  };
}
