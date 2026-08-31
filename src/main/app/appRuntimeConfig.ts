import os from "node:os";

export const APP_NAME = "字体管理器";
export const APP_ID = "cn.local.hanfontmanager";
export const DATA_DIR_NAME = "data";
export const DATA_LAYOUT_VERSION = 2;
export const BUILD_MARKER = "ui_logfix_round3aa";
export const LOG_SCHEMA_VERSION = 3;

export const RUST_CORE_WORKER_ENABLED = process.env.HFM_RUST_CORE !== "0";
export const RUST_CORE_WORKER_REQUIRED = process.env.HFM_RUST_CORE_REQUIRED === "1";

export const VERBOSE_RENDERER_LOGS = process.env.HFM_VERBOSE_LOGS === "1";
export const VERBOSE_SQLITE_LOGS = process.env.HFM_VERBOSE_SQLITE_LOGS === "1";
export const SQLITE_QUICK_CHECK_INTERVAL_MS = Math.max(
  30000,
  Math.min(
    10 * 60 * 1000,
    Number(process.env.HFM_SQLITE_QUICK_CHECK_INTERVAL_MS || 5 * 60 * 1000) ||
      5 * 60 * 1000,
  ),
);
export const FAST_OPEN_SHARED_CACHE_DBS =
  process.env.HFM_FAST_OPEN_SHARED_CACHE_DBS !== "0";

export const FONT_QUERY_PAGE_CACHE_TTL_MS = Math.max(
  200,
  Math.min(
    5000,
    Number(process.env.HFM_FONT_QUERY_PAGE_CACHE_TTL_MS || 1200) || 1200,
  ),
);
export const FONT_QUERY_PAGE_CACHE_MAX = Math.max(
  4,
  Math.min(64, Number(process.env.HFM_FONT_QUERY_PAGE_CACHE_MAX || 24) || 24),
);
export const MERGED_INDEX_STALE_FIRST_PAGE_ENABLED =
  process.env.HFM_MERGED_INDEX_STALE_FIRST_PAGE !== "0";
export const MERGED_INDEX_BACKGROUND_VALIDATE_INTERVAL_MS = Math.max(
  5000,
  Math.min(
    5 * 60 * 1000,
    Number(process.env.HFM_MERGED_INDEX_VALIDATE_INTERVAL_MS || 30000) || 30000,
  ),
);
export const STARTUP_DB_MAINTENANCE_IDLE_DELAY_MS = Math.max(
  1000,
  Math.min(
    10 * 60 * 1000,
    Number(process.env.HFM_STARTUP_MAINTENANCE_IDLE_DELAY_MS || 2000) || 2000,
  ),
);
export const SYSTEM_FONT_RESOLVE_BATCH_SIZE = Math.max(
  1,
  Math.min(
    16,
    Number(process.env.HFM_SYSTEM_FONT_RESOLVE_BATCH_SIZE || 4) || 4,
  ),
);

export const CPU_COUNT =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
export const ENV_SCAN_WORKERS = Number(process.env.HFM_SCAN_WORKERS || 0);
export const ENV_SCAN_NETWORK_WORKERS = Number(
  process.env.HFM_SCAN_NETWORK_WORKERS || 0,
);
export const ENV_SCAN_LOCAL_WORKERS = Number(process.env.HFM_SCAN_LOCAL_WORKERS || 0);
export const ENV_SCAN_WORKER_BATCH_SIZE = Number(
  process.env.HFM_SCAN_WORKER_BATCH_SIZE || 0,
);
export const ENV_SCAN_HASH_FLUSH_BATCH_SIZE = Number(
  process.env.HFM_SCAN_HASH_FLUSH_BATCH_SIZE || 0,
);
export const WINDOWS_STORAGE_MEDIA_DETECT_ENABLED =
  process.env.HFM_STORAGE_MEDIA_DETECT !== "0";
export const WINDOWS_STORAGE_MEDIA_DETECT_TIMEOUT_MS = Math.max(
  300,
  Math.min(
    5000,
    Number(process.env.HFM_STORAGE_MEDIA_DETECT_TIMEOUT_MS || 1200) || 1200,
  ),
);

// 扫描 Worker 不再固定 4 个：本地盘按 CPU 核心数放宽，NAS/UNC 继续保守，避免把网络盘打满。
export const LOCAL_SCAN_WORKERS = Math.max(
  1,
  ENV_SCAN_WORKERS > 0
    ? Math.min(16, ENV_SCAN_WORKERS)
    : ENV_SCAN_LOCAL_WORKERS > 0
      ? Math.min(16, ENV_SCAN_LOCAL_WORKERS)
      : Math.min(6, Math.max(1, CPU_COUNT - 1)),
);
export const NETWORK_SCAN_WORKERS = Math.max(
  1,
  ENV_SCAN_NETWORK_WORKERS > 0
    ? Math.min(4, ENV_SCAN_NETWORK_WORKERS)
    : Math.min(2, LOCAL_SCAN_WORKERS),
);
export const MAX_SCAN_WORKERS = Math.max(LOCAL_SCAN_WORKERS, NETWORK_SCAN_WORKERS);
export const SCAN_WORKER_BATCH_SIZE = Math.max(
  1,
  Math.min(
    64,
    ENV_SCAN_WORKER_BATCH_SIZE || 8,
  ),
);
export const SCAN_HASH_FLUSH_BATCH_SIZE = Math.max(
  50,
  Math.min(1000, ENV_SCAN_HASH_FLUSH_BATCH_SIZE || 250),
);
export const SCAN_STAT_CONCURRENCY = Math.max(4, Math.min(18, MAX_SCAN_WORKERS * 3));
export const LOAD_CACHE_EXISTENCE_CONCURRENCY = Math.max(
  4,
  Math.min(18, MAX_SCAN_WORKERS * 3),
);

export const SCAN_WORKER_VERSION = "v1.0.0";
export const FONT_SCAN_CACHE_VERSION = 2;
export const SCRIPT_DETECTION_VERSION = 2;
export const TASK_LOCK_STALE_MS = 5 * 60 * 1000;
export const INSTALL_STATUS_REFRESH_BATCH_SIZE = Math.max(
  50,
  Math.min(
    500,
    Number(process.env.HFM_INSTALL_STATUS_BATCH_SIZE || 500) || 500,
  ),
);
export const INSTALL_STATUS_LIGHTWEIGHT_MISSING_THRESHOLD = Math.max(
  0,
  Math.min(
    200,
    Number(
      process.env.HFM_INSTALL_STATUS_LIGHTWEIGHT_MISSING_THRESHOLD || 32,
    ) || 32,
  ),
);
export const DATABASE_BACKUP_RETENTION_COUNT = 10;
export const DATABASE_CORRUPT_RETENTION_COUNT = 10;
export const AUTO_DATABASE_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const COMPLETED_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const FAILED_TASK_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const TASK_ERROR_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const PREVIEW_OK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const BACKGROUND_TASK_SCHEDULER_INTERVAL_MS = 2000;
export const BACKGROUND_TASK_SCHEDULER_START_DELAY_MS = 1500;
export const BACKGROUND_TASK_SCHEDULER_BATCH_SIZE = 6;
export const BACKGROUND_TASK_SCHEDULER_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.HFM_TASK_WORKERS || 2) || 2),
);
export const WATCHER_STARTUP_GRACE_MS = Math.max(
  0,
  Math.min(60000, Number(process.env.HFM_WATCHER_GRACE_MS || 15000) || 15000),
);
export const WATCHER_FLUSH_DEBOUNCE_MS = Math.max(
  300,
  Math.min(5000, Number(process.env.HFM_WATCHER_FLUSH_MS || 900) || 900),
);

export const STARTUP_AUTO_SYSTEM_FONT_IMPORT_ENABLED =
  process.env.HFM_STARTUP_AUTO_SYSTEM_IMPORT === "1";
export const STARTUP_RECOVER_SCAN_TASKS_ENABLED =
  process.env.HFM_STARTUP_RECOVER_SCAN_TASKS === "1";
export const STARTUP_BACKGROUND_TASKS_ENABLED =
  process.env.HFM_STARTUP_BACKGROUND_TASKS === "1";
export const SAFE_STARTUP_TASK_TYPES = new Set(["generatePreview", "maintenance"]);
export const INDEX_PROGRESS_EVENT_MIN_INTERVAL_MS = 300;
export const SHARED_FONT_MEMORY_CACHE_TTL_MS = Math.max(
  3000,
  Math.min(
    120000,
    Number(process.env.HFM_SHARED_FONT_MEMORY_CACHE_TTL_MS || 30000) || 30000,
  ),
);
export const FONT_QUERY_RESULT_CACHE_TTL_MS = Math.max(
  300,
  Math.min(
    10000,
    Number(process.env.HFM_FONT_QUERY_CACHE_TTL_MS || 1800) || 1800,
  ),
);
export const FONT_QUERY_RESULT_CACHE_MAX = Math.max(
  8,
  Math.min(128, Number(process.env.HFM_FONT_QUERY_CACHE_MAX || 48) || 48),
);
export const MERGED_INDEX_SCHEMA_VERSION = 6;
