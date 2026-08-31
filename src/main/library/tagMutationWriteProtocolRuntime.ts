import type { FontTagUpdateResult } from '../../shared/types'
import type { TagMetadataRevisionBarrierRuntime } from './tagMetadataRevisionBarrierRuntime'
import { createTagMutationSerialQueueRuntime } from '../tags/tagMutationSerialQueueRuntime'

export type TagMutationWriteScope = 'local' | 'shared'

export type TagMutationWriteProtocolOptions = {
  tagMetadataRevisionBarrier: TagMetadataRevisionBarrierRuntime
  clearFontQueryCaches: () => void
  appendStartupLog?: (message: string) => void
}

export type RunTagMutationWriteOptions<Result extends FontTagUpdateResult> = {
  scope: TagMutationWriteScope
  mutationKind: string
  inputIds?: unknown[]
  action: () => Promise<Result>
  afterCommit?: (result: Result) => void | Promise<void>
}

function cleanMutationIds(ids: unknown[] | undefined): string[] {
  return Array.from(new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean)))
}

export function tagMutationUpdatedIds(result: FontTagUpdateResult, fallbackIds?: unknown[]): string[] {
  const protocolIds = cleanMutationIds(result.mutationProtocol?.changedIds)
  if (protocolIds.length) return protocolIds
  const updatedIds = cleanMutationIds(result.updatedIds)
  return updatedIds.length ? updatedIds : cleanMutationIds(fallbackIds)
}

function noteTagMutation(
  runtime: TagMetadataRevisionBarrierRuntime,
  scope: TagMutationWriteScope,
  reason: string,
  ids: string[],
): void {
  if (!ids.length) return
  if (scope === 'local') runtime.noteLocalTagMutation(reason, ids)
  else runtime.noteSharedTagMutation(reason, ids)
}

export function createTagMutationWriteProtocolRuntime(options: TagMutationWriteProtocolOptions) {
  const serialQueue = createTagMutationSerialQueueRuntime()

  async function run<Result extends FontTagUpdateResult>(runOptions: RunTagMutationWriteOptions<Result>): Promise<Result> {
    return serialQueue.run(runOptions.scope, () => runNow(runOptions))
  }

  async function runNow<Result extends FontTagUpdateResult>(runOptions: RunTagMutationWriteOptions<Result>): Promise<Result> {
    const inputIds = cleanMutationIds(runOptions.inputIds)
    const prefix = runOptions.scope === 'local' ? 'local' : 'shared'
    noteTagMutation(options.tagMetadataRevisionBarrier, runOptions.scope, `${runOptions.mutationKind}:start`, inputIds)
    options.clearFontQueryCaches()
    try {
      const result = await runOptions.action()
      const updatedIds = tagMutationUpdatedIds(result, inputIds)
      const protocolKind = result.mutationProtocol?.mutationKind || runOptions.mutationKind
      noteTagMutation(options.tagMetadataRevisionBarrier, runOptions.scope, `${protocolKind}:commit`, updatedIds)
      await runOptions.afterCommit?.(result)
      options.clearFontQueryCaches()
      return result
    } catch (error) {
      noteTagMutation(options.tagMetadataRevisionBarrier, runOptions.scope, `${runOptions.mutationKind}:error`, inputIds)
      options.clearFontQueryCaches()
      options.appendStartupLog?.(`${prefix} tag mutation failed: kind=${runOptions.mutationKind}, input=${inputIds.length}, message=${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  return { run }
}
