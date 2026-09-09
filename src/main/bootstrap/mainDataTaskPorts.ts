import type { BackgroundTaskRuntimeApi } from '../tasks/background-runtime/backgroundTaskTypes';

// Preview and install-index persistence share the existing Operations task owner.
export type MainDataTaskPorts = Pick<BackgroundTaskRuntimeApi,
  'completeBackgroundTask' | 'skipBackgroundTask' | 'upsertBackgroundTask' |
  'startBackgroundTask' | 'heartbeatBackgroundTask' | 'failBackgroundTask'
> & { previewTaskKey: (key: string) => string };
