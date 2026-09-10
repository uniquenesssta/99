import { createRequire } from 'node:module';
import { registerMainProcessRuntime } from './app/mainProcessRuntimeRegistration';
import { createMainCompositionFeedback } from './bootstrap/mainCompositionFeedback';
import { createMainCoreCompositionRuntime } from './bootstrap/mainCoreCompositionRuntime';
import { createMainTagCompositionRuntime } from './bootstrap/mainTagCompositionRuntime';
import { createMainDataCompositionRuntime } from './bootstrap/mainDataCompositionRuntime';
import { createMainMutationCompositionRuntime } from './bootstrap/mainMutationCompositionRuntime';
import { createMainOperationsCompositionRuntime } from './bootstrap/mainOperationsCompositionRuntime';
import { createMainApplicationRuntime } from './bootstrap/mainApplicationRuntime';

const nodeRequire = createRequire(import.meta.url);
const feedback = createMainCompositionFeedback();
const coreComposition = createMainCoreCompositionRuntime(feedback.core);
const tags = createMainTagCompositionRuntime({
  appendStartupLog: coreComposition.logging.appendStartupLog,
  clearFontQueryCaches: feedback.clearFontQueryCaches,
});
feedback.bindTags(tags);

const dataComposition = createMainDataCompositionRuntime({
  host: { execFileAsync: coreComposition.execFileAsync, delayToEventLoop: coreComposition.delayToEventLoop, nodeRequire },
  windows: coreComposition.windows,
  comparison: coreComposition.comparison,
  performance: coreComposition.performance,
  logging: coreComposition.logging,
  paths: coreComposition.paths,
  tags,
  tasks: feedback.tasks,
  rustCoreWorkerRuntime: coreComposition.rustCoreWorkerRuntime,
  migrationDiagnosticsRuntime: coreComposition.migrationDiagnosticsRuntime,
  listPhysicalFolderTree: feedback.listPhysicalFolderTree,
});
feedback.bindData({
  appWatchedFolders: dataComposition.storage.appWatchedFolders,
  mainProcessFontIndexContains: dataComposition.query.mainProcessFontIndexContains,
  clearFontQueryCaches: dataComposition.query.clearFontQueryCaches,
});

const mutationComposition = createMainMutationCompositionRuntime({
  tags,
  storage: dataComposition.storage,
  query: dataComposition.query,
  logging: coreComposition.logging,
  paths: coreComposition.paths,
  windows: coreComposition.windows,
  comparison: coreComposition.comparison,
  performance: coreComposition.performance,
  host: { delayToEventLoop: coreComposition.delayToEventLoop },
  feedback,
  rustCoreWorkerRuntime: coreComposition.rustCoreWorkerRuntime,
});
feedback.bindMutation(mutationComposition);

const operationsComposition = createMainOperationsCompositionRuntime({
  storage: dataComposition.storage,
  logging: coreComposition.logging,
  query: dataComposition.query,
  comparison: coreComposition.comparison,
  preview: dataComposition.preview,
  performance: coreComposition.performance,
  host: { delayToEventLoop: coreComposition.delayToEventLoop, execFileAsync: coreComposition.execFileAsync, nodeRequire },
  windows: coreComposition.windows,
  paths: coreComposition.paths,
  storagePolicy: coreComposition.storage,
  rustCoreWorkerRuntime: coreComposition.rustCoreWorkerRuntime,
  assertFeedbackReady: feedback.assertReady,
  refreshKnownSharedTagsFromMetadata: mutationComposition.refreshKnownSharedTagsFromMetadata,
});
feedback.bindOperations(operationsComposition.feedback);
feedback.assertReady();
operationsComposition.startStartupTasks();

const application = createMainApplicationRuntime({
  core: coreComposition, data: dataComposition,
  mutation: mutationComposition, operations: operationsComposition,
});
registerMainProcessRuntime(application.registration);
