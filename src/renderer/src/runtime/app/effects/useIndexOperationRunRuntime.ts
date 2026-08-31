import type { MutableRefObject } from 'react'

export function useIndexOperationRunRuntime(indexOperationRunIdRef: MutableRefObject<number>): {
  nextIndexOperationRunId: () => number
  isCurrentIndexOperation: (runId: number) => boolean
} {
  const nextIndexOperationRunId = (): number => {
    indexOperationRunIdRef.current += 1
    return indexOperationRunIdRef.current
  }

  const isCurrentIndexOperation = (runId: number): boolean => indexOperationRunIdRef.current === runId

  return { nextIndexOperationRunId, isCurrentIndexOperation }
}
