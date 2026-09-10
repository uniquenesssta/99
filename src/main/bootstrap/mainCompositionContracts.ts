import type { MainProcessRuntimeRegistrationOptions } from '../app/mainProcessRuntimeRegistration'
import type { ApplicationCacheDbLabel } from '../cache/architecture/cacheArchitectureTypes'

// The application provides every existing registration capability. The legacy IPC
// consumer keeps its optional hooks; appendLog is supplied by the registrar itself.
type RegistrationSurface = Required<Omit<MainProcessRuntimeRegistrationOptions, 'appendLog'>>

export type MainCoreLifecycle = Pick<RegistrationSurface,
  | 'beginStartupSessionSync' | 'ensureDataRootSync' | 'migrateLegacyUserDataIfNeeded'
  | 'diagnoseRustCoreWorker' | 'requestRendererWindowsCloseForQuit'
  | 'startPerformanceLogSampler' | 'stopPerformanceLogSampler' | 'flushPerformanceLogs'
  | 'stopRustCoreDaemon' | 'markCleanShutdownSync' | 'flushStartupLogAsync' | 'flushStartupLogSync'
>

export interface MainCoreCompositionRuntime {
  readonly capabilities: Pick<RegistrationSurface,
    | 'appName' | 'appId' | 'buildMarker' | 'logSchemaVersion' | 'cacheArchitectureVersion'
    | 'watcherStartupGraceMs' | 'editionLogLine' | 'scanTuningLogLine'
    | 'dataRoot' | 'dataRootErrorMessage' | 'logPath' | 'ioLaneSummary' | 'appendStartupLog'
    | 'showExistingWindow' | 'registerFontProtocol' | 'createWindow'
    | 'assertFeatureForChannel' | 'getLicenseStatus' | 'reportPerformanceEvent'
    | 'markRendererUserActivity' | 'reportRendererLongTask'
    | 'getMigrationDiagnostics' | 'clearMigrationDiagnostics'
  >
  readonly lifecycle: MainCoreLifecycle
}

export type MainDataLifecycle = Pick<RegistrationSurface,
  | 'initializeCacheArchitecture' | 'runStartupCriticalSchemaAudit' | 'dbQueryWorkerShutdown'
>

// Close/checkpoint remain owned by the runtime that created the handle. Watcher
// and maintenance receive these operations, never a duplicate handle owner.
export interface MainDataResourceLifecycle {
  readonly closeLibraryDb: () => void
  readonly closePreviewDb: () => void
  readonly clearLocalPreviewDbHandle: () => void
  readonly checkpointOpenCacheDbs: () => void
  readonly closeCacheDb: (label: ApplicationCacheDbLabel) => void
}

export interface MainDataCompositionRuntime {
  readonly capabilities: Pick<RegistrationSurface,
    | 'loadLibrary' | 'loadLibraryShell' | 'loadFolderCache'
    | 'searchFontsInLibrary' | 'queryFontsInLibrary' | 'queryFontPageInLibrary'
    | 'checkSharedMetadataUpdates' | 'getFontMetricsFromLibrary'
    | 'getCacheStats' | 'cacheArchitectureInfo' | 'clearScanCache' | 'clearPreviewCache' | 'setCacheKvs'
    | 'getSystemInstalledFonts' | 'scanSystemInstalledFonts' | 'getInstallStatusIndexSnapshot'
    | 'readPreviewFontData' | 'renderFontPreviewImage' | 'readCachedFontPreviewImage'
    | 'readCachedFontPreviewImages' | 'ensureFontPreviewCache' | 'getPreviewCacheStatus'
    | 'listPhysicalFolderTree'
  >
  readonly lifecycle: MainDataLifecycle
  readonly resources: MainDataResourceLifecycle
}

export type MainMutationLifecycle = Pick<RegistrationSurface,
  | 'cleanupTemporaryActiveFontsUntilEmpty' | 'flushPendingTemporaryFontDeletes'
  | 'flushActivationInstallStatusSave' | 'hasPendingActivationInstallStatusSave'
  | 'hasInFlightActivationInstallStatusSave'
>

export interface MainMutationCompositionRuntime {
  readonly capabilities: Pick<RegistrationSurface,
    | 'saveLibrary' | 'installFontSystemWide' | 'uninstallFontSystemWide' | 'deleteFontFilesToTrash'
    | 'setFontDeleteProtectionInIndex' | 'setSharedFontFavoriteInIndex'
    | 'setLocalFontTags' | 'setLocalFontTagsBatch' | 'deleteLocalFontTag'
    | 'setSharedFontTagsInIndex' | 'setSharedFontTagsBatchInIndex'
    | 'renameSharedFontTagInIndex' | 'deleteSharedFontTagInIndex'
    | 'activateFontSession' | 'activateFontSessionsBatch' | 'deactivateFontSession' | 'deactivateFontSessionsBatch'
    | 'installFontForCurrentUser' | 'uninstallManagedFont'
    | 'createPhysicalFolder' | 'renamePhysicalFolder' | 'moveFontFileToFolder' | 'moveFontFilesToFolder'
  >
  readonly lifecycle: MainMutationLifecycle
}

export type MainOperationsLifecycle = Pick<RegistrationSurface,
  | 'runStartupDatabaseMaintenance' | 'startBackgroundTaskScheduler'
  | 'stopBackgroundTaskScheduler' | 'stopFolderWatchers'
>

export interface MainOperationsResourceLifecycle {
  readonly closeTasksDb: () => void
  readonly checkpointTasksDb: () => void
}

export interface MainOperationsCompositionRuntime {
  readonly capabilities: Pick<RegistrationSurface,
    | 'scanFoldersManaged' | 'cancelActiveFontScan' | 'activeFontScanStatus'
    | 'startWatchingFolders' | 'refreshWatchedFolder'
    | 'readSharedMetadataFrontendDiagnostics' | 'repairSharedMetadataFromFrontend'
    | 'readSharedIndexSnapshotFrontendDiagnostics' | 'repairSharedIndexSnapshotFromFrontend'
    | 'runDatabaseHealthCheck' | 'createDatabaseBackup' | 'runDatabaseMaintenance' | 'restoreLatestApplicationDatabase'
    | 'listBackgroundTaskSummaries' | 'runBackgroundTaskSchedulerOnce' | 'backgroundTaskSchedulerStatus'
    | 'compareFontInstalled' | 'compareFontsInstalled' | 'refreshInstallStatusIndex' | 'startInstallStatusRefreshIndex'
    | 'startupDbMaintenanceIdleDelayMs' | 'startupBackgroundTasksEnabled'
  >
  readonly lifecycle: MainOperationsLifecycle
  readonly resources: MainOperationsResourceLifecycle
}

// The composition owners retain their existing flat capability contracts.
// Application partitions registration by consumer responsibility below.
export type MainApplicationRegistration =
  MainCoreCompositionRuntime['capabilities'] & MainCoreLifecycle &
  MainDataCompositionRuntime['capabilities'] & MainDataLifecycle &
  MainMutationCompositionRuntime['capabilities'] & MainMutationLifecycle &
  MainOperationsCompositionRuntime['capabilities'] & MainOperationsLifecycle

export interface MainApplicationRuntime {
  readonly registration: MainApplicationRegistration
}

type AssertNever<T extends never> = T
type MissingRegistrationCapabilities = AssertNever<Exclude<keyof RegistrationSurface, keyof MainApplicationRegistration>>
type UnexpectedRegistrationCapabilities = AssertNever<Exclude<keyof MainApplicationRegistration, keyof RegistrationSurface>>

export interface MainApplicationRegistrationGroups {
  readonly lifecycle: Pick<MainApplicationRegistration,
    | 'appendStartupLog'
    | 'appName'
    | 'appId'
    | 'buildMarker'
    | 'logSchemaVersion'
    | 'cacheArchitectureVersion'
    | 'watcherStartupGraceMs'
    | 'editionLogLine'
    | 'scanTuningLogLine'
    | 'dataRoot'
    | 'dataRootErrorMessage'
    | 'showExistingWindow'
    | 'logPath'
    | 'ioLaneSummary'
    | 'registerFontProtocol'
    | 'createWindow'
    | 'beginStartupSessionSync'
    | 'ensureDataRootSync'
    | 'migrateLegacyUserDataIfNeeded'
    | 'diagnoseRustCoreWorker'
    | 'requestRendererWindowsCloseForQuit'
    | 'startPerformanceLogSampler'
    | 'stopPerformanceLogSampler'
    | 'flushPerformanceLogs'
    | 'stopRustCoreDaemon'
    | 'markCleanShutdownSync'
    | 'flushStartupLogAsync'
    | 'flushStartupLogSync'
    | 'setCacheKvs'
    | 'initializeCacheArchitecture'
    | 'runStartupCriticalSchemaAudit'
    | 'dbQueryWorkerShutdown'
    | 'cleanupTemporaryActiveFontsUntilEmpty'
    | 'flushPendingTemporaryFontDeletes'
    | 'flushActivationInstallStatusSave'
    | 'hasPendingActivationInstallStatusSave'
    | 'hasInFlightActivationInstallStatusSave'
    | 'startupDbMaintenanceIdleDelayMs'
    | 'startupBackgroundTasksEnabled'
    | 'runStartupDatabaseMaintenance'
    | 'startBackgroundTaskScheduler'
    | 'stopBackgroundTaskScheduler'
    | 'stopFolderWatchers'
  >
  readonly query: Pick<MainApplicationRegistration,
    | 'reportPerformanceEvent'
    | 'assertFeatureForChannel'
    | 'getLicenseStatus'
    | 'markRendererUserActivity'
    | 'reportRendererLongTask'
    | 'loadLibrary'
    | 'loadLibraryShell'
    | 'loadFolderCache'
    | 'searchFontsInLibrary'
    | 'queryFontsInLibrary'
    | 'queryFontPageInLibrary'
    | 'checkSharedMetadataUpdates'
    | 'getFontMetricsFromLibrary'
    | 'getSystemInstalledFonts'
    | 'scanSystemInstalledFonts'
    | 'getInstallStatusIndexSnapshot'
    | 'listPhysicalFolderTree'
    | 'activeFontScanStatus'
    | 'compareFontInstalled'
    | 'compareFontsInstalled'
  >
  readonly mutation: Pick<MainApplicationRegistration,
    | 'saveLibrary'
    | 'installFontSystemWide'
    | 'uninstallFontSystemWide'
    | 'deleteFontFilesToTrash'
    | 'setFontDeleteProtectionInIndex'
    | 'setSharedFontFavoriteInIndex'
    | 'setLocalFontTags'
    | 'setLocalFontTagsBatch'
    | 'deleteLocalFontTag'
    | 'setSharedFontTagsInIndex'
    | 'setSharedFontTagsBatchInIndex'
    | 'renameSharedFontTagInIndex'
    | 'deleteSharedFontTagInIndex'
    | 'activateFontSession'
    | 'activateFontSessionsBatch'
    | 'deactivateFontSession'
    | 'deactivateFontSessionsBatch'
    | 'installFontForCurrentUser'
    | 'uninstallManagedFont'
    | 'createPhysicalFolder'
    | 'renamePhysicalFolder'
    | 'moveFontFileToFolder'
    | 'moveFontFilesToFolder'
    | 'scanFoldersManaged'
    | 'cancelActiveFontScan'
    | 'startWatchingFolders'
    | 'refreshWatchedFolder'
    | 'refreshInstallStatusIndex'
    | 'startInstallStatusRefreshIndex'
  >
  readonly maintenance: Pick<MainApplicationRegistration,
    | 'getMigrationDiagnostics'
    | 'clearMigrationDiagnostics'
    | 'getCacheStats'
    | 'cacheArchitectureInfo'
    | 'clearScanCache'
    | 'clearPreviewCache'
    | 'readSharedMetadataFrontendDiagnostics'
    | 'repairSharedMetadataFromFrontend'
    | 'readSharedIndexSnapshotFrontendDiagnostics'
    | 'repairSharedIndexSnapshotFromFrontend'
    | 'runDatabaseHealthCheck'
    | 'createDatabaseBackup'
    | 'runDatabaseMaintenance'
    | 'restoreLatestApplicationDatabase'
    | 'listBackgroundTaskSummaries'
    | 'runBackgroundTaskSchedulerOnce'
    | 'backgroundTaskSchedulerStatus'
  >
  readonly preview: Pick<MainApplicationRegistration,
    | 'readPreviewFontData'
    | 'renderFontPreviewImage'
    | 'readCachedFontPreviewImage'
    | 'readCachedFontPreviewImages'
    | 'ensureFontPreviewCache'
    | 'getPreviewCacheStatus'
  >
}

type GroupName = keyof MainApplicationRegistrationGroups
type GroupKeys = { [G in GroupName]: keyof MainApplicationRegistrationGroups[G] }
type MissingGroupedCapabilities = AssertNever<Exclude<keyof MainApplicationRegistration, GroupKeys[GroupName]>>
type DuplicateGroupedCapabilities = AssertNever<{
  [G in GroupName]: Extract<GroupKeys[G], GroupKeys[Exclude<GroupName, G>]>
}[GroupName]>
