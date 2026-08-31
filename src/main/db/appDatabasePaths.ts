export function createApplicationDatabasePaths(dataPath: (...segments: string[]) => string): {
  libraryJsonPath: () => string
  appSqlitePath: () => string
  librarySqlitePath: () => string
  tasksSqlitePath: () => string
  previewSqlitePath: () => string
  kvsSqlitePath: () => string
  eventsSqlitePath: () => string
  hashSqlitePath: () => string
  metricsSqlitePath: () => string
  cacheIdentityPath: () => string
  backupsRootPath: () => string
  corruptDatabasesRootPath: () => string
  maintenanceStatePath: () => string
} {
  const appSqlitePath = (): string => dataPath('app.sqlite')

  return {
    libraryJsonPath: () => dataPath('library.json'),
    appSqlitePath,
    // v2.0 stable architecture: this is no longer a local font library.
    // It stores only application settings such as watched folders, tags and UI state.
    librarySqlitePath: () => appSqlitePath(),
    tasksSqlitePath: () => dataPath('db', 'tasks.sqlite'),
    // v1.0: shared previews live under each watched font root.
    // This file is kept only for unmonitored/system-font fallback previews.
    previewSqlitePath: () => dataPath('preview-fallback.sqlite'),
    kvsSqlitePath: () => dataPath('db', 'kvs.sqlite'),
    eventsSqlitePath: () => dataPath('db', 'events.sqlite'),
    hashSqlitePath: () => dataPath('db', 'hash.sqlite'),
    metricsSqlitePath: () => dataPath('db', 'metrics.sqlite'),
    cacheIdentityPath: () => dataPath('identity.json'),
    backupsRootPath: () => dataPath('backups'),
    corruptDatabasesRootPath: () => dataPath('db', 'corrupt'),
    maintenanceStatePath: () => dataPath('db', 'maintenance.json')
  }
}
