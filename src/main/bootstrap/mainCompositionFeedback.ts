import type { FontIndexChangePayload } from '../../shared/types';
import type { createManualFolderRefreshRuntime } from '../watcher/manualFolderRefreshRuntime';
import type { MainCoreCompositionOptions } from './mainCoreCompositionRuntime';
import type { createMainDataCompositionRuntime, MainDataCompositionOptions } from './mainDataCompositionRuntime';
import type { MainDataTaskPorts } from './mainDataTaskPorts';

type Data = ReturnType<typeof createMainDataCompositionRuntime>;
type DataFeedback = Pick<Data['storage'], 'appWatchedFolders'> &
  Pick<Data['query'], 'mainProcessFontIndexContains' | 'clearFontQueryCaches'>;
type MutationFeedback = Pick<MainDataCompositionOptions, 'listPhysicalFolderTree'>;
export type MainOperationsFeedback = MainDataTaskPorts & Pick<MainCoreCompositionOptions,
  'isIndexingActive' | 'activeScanJobId' | 'isInstallStatusRefreshActive' | 'activeBackgroundTaskCount'
> & {
  refreshWatchedFolder: ReturnType<typeof createManualFolderRefreshRuntime>['refreshWatchedFolder'];
  sendFontIndexChanged: (payload: FontIndexChangePayload) => void;
};
type TagFeedback = Pick<MainCoreCompositionOptions, 'onDaemonDomainEvent'>;

function bound<T>(value: T | undefined, owner: string): T {
  if (!value) throw new Error(`main composition feedback is not bound: ${owner}`);
  return value;
}

// Only the application binds these four feedback directions. This object owns
// no domain state or resources; task execution requires all owners to be ready.
export function createMainCompositionFeedback() {
  let data: DataFeedback | undefined;
  let mutation: MutationFeedback | undefined;
  let operations: MainOperationsFeedback | undefined;
  let tags: TagFeedback | undefined;
  function assertReady(): void {
    bound(data, 'Data'); bound(mutation, 'Mutation');
    bound(operations, 'Operations'); bound(tags, 'Tags');
  }
  const requireOperations = () => { assertReady(); return bound(operations, 'Operations'); };
  return {
    bindData(value: DataFeedback) {
      if (data) throw new Error('Data feedback already bound');
      data = value;
    },
    bindMutation(value: MutationFeedback) {
      if (mutation) throw new Error('Mutation feedback already bound');
      mutation = value;
    },
    bindOperations(value: MainOperationsFeedback) {
      if (operations) throw new Error('Operations feedback already bound');
      operations = value;
    },
    bindTags(value: TagFeedback) {
      if (tags) throw new Error('Tag feedback already bound');
      tags = value;
    },
    assertReady,
    core: {
      isIndexingActive: () => operations?.isIndexingActive() ?? false,
      activeScanJobId: () => operations?.activeScanJobId() ?? '',
      isInstallStatusRefreshActive: () => operations?.isInstallStatusRefreshActive() ?? false,
      activeBackgroundTaskCount: () => operations?.activeBackgroundTaskCount() ?? 0,
      onDaemonDomainEvent: (...args: Parameters<TagFeedback['onDaemonDomainEvent']>) => bound(tags, 'Tags').onDaemonDomainEvent(...args),
      loadWatchedFontRoots: () => bound(data, 'Data').appWatchedFolders(),
      isMainProcessIndexedFont: (...args: Parameters<DataFeedback['mainProcessFontIndexContains']>) => bound(data, 'Data').mainProcessFontIndexContains(...args),
    },
    clearFontQueryCaches: () => bound(data, 'Data').clearFontQueryCaches(),
    listPhysicalFolderTree: (...args: Parameters<MutationFeedback['listPhysicalFolderTree']>) => bound(mutation, 'Mutation').listPhysicalFolderTree(...args),
    refreshWatchedFolder: (...args: Parameters<MainOperationsFeedback['refreshWatchedFolder']>) => requireOperations().refreshWatchedFolder(...args),
    sendFontIndexChanged: (payload: FontIndexChangePayload) => requireOperations().sendFontIndexChanged(payload),
    tasks: {
      previewTaskKey: (...args: Parameters<MainDataTaskPorts['previewTaskKey']>) => requireOperations().previewTaskKey(...args),
      completeBackgroundTask: (...args: Parameters<MainDataTaskPorts['completeBackgroundTask']>) => requireOperations().completeBackgroundTask(...args),
      skipBackgroundTask: (...args: Parameters<MainDataTaskPorts['skipBackgroundTask']>) => requireOperations().skipBackgroundTask(...args),
      upsertBackgroundTask: (...args: Parameters<MainDataTaskPorts['upsertBackgroundTask']>) => requireOperations().upsertBackgroundTask(...args),
      startBackgroundTask: (...args: Parameters<MainDataTaskPorts['startBackgroundTask']>) => requireOperations().startBackgroundTask(...args),
      heartbeatBackgroundTask: (...args: Parameters<MainDataTaskPorts['heartbeatBackgroundTask']>) => requireOperations().heartbeatBackgroundTask(...args),
      failBackgroundTask: (...args: Parameters<MainDataTaskPorts['failBackgroundTask']>) => requireOperations().failBackgroundTask(...args),
    },
  };
}
