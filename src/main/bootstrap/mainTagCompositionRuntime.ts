import { createTagMetadataRevisionBarrierRuntime } from '../library/tagMetadataRevisionBarrierRuntime';
import { createTagMutationStateSignalRuntime } from '../library/tagMutationStateSignalRuntime';
import { createTagMutationWriteProtocolRuntime } from '../library/tagMutationWriteProtocolRuntime';

type TagOptions = Pick<Parameters<typeof createTagMutationStateSignalRuntime>[0],
  'appendStartupLog' | 'clearFontQueryCaches'>;

// Shared tag coordination has one barrier and one signal/protocol owner.
// Construction does not dispatch a mutation or start background work.
export function createMainTagCompositionRuntime(options: TagOptions) {
  const tagMetadataRevisionBarrier = createTagMetadataRevisionBarrierRuntime({
    appendStartupLog: options.appendStartupLog,
  });
  const tagMutationStateSignalRuntime = createTagMutationStateSignalRuntime({
    tagMetadataRevisionBarrier, ...options,
  });
  const tagMutationWriteProtocolRuntime = createTagMutationWriteProtocolRuntime({
    tagMetadataRevisionBarrier, ...options,
  });
  return {
    tagMetadataRevisionBarrier, tagMutationStateSignalRuntime, tagMutationWriteProtocolRuntime,
    onDaemonDomainEvent: (...args: Parameters<typeof tagMutationStateSignalRuntime.handleRustCoreDaemonDomainEvent>) =>
      tagMutationStateSignalRuntime.handleRustCoreDaemonDomainEvent(...args),
  };
}
