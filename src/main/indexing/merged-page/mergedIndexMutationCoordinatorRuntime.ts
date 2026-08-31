export type MergedIndexMutationContext = {
  sequence: number;
  commit: (reason?: string) => void;
};

type MergedIndexMutationCoordinatorOptions = {
  appendStartupLog: (message: string) => void;
  onCommitted?: (event: {
    reason: string;
    sequence: number;
    revision: number;
  }) => void;
};

export function createMergedIndexMutationCoordinatorRuntime(
  options: MergedIndexMutationCoordinatorOptions,
) {
  let tail: Promise<void> = Promise.resolve();
  let sequence = 0;
  let revision = 0;
  let pending = 0;

  async function runMergedIndexMutation<T>(
    label: string,
    action: (context: MergedIndexMutationContext) => Promise<T>,
  ): Promise<T> {
    const currentSequence = ++sequence;
    const queuedAt = Date.now();
    pending += 1;

    const task = tail.catch(() => undefined).then(async () => {
      const waitedMs = Date.now() - queuedAt;
      if (waitedMs >= 250) {
        options.appendStartupLog(
          `local merged index mutation waited: sequence=${currentSequence}, label=${label}, waited=${waitedMs}ms, pending=${pending}`,
        );
      }

      let committed = false;
      const commit = (reason = label): void => {
        if (committed) return;
        committed = true;
        revision += 1;
        try {
          options.onCommitted?.({
            reason,
            sequence: currentSequence,
            revision,
          });
        } catch (error) {
          options.appendStartupLog(
            `local merged index commit notification failed: sequence=${currentSequence}, reason=${reason}, ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      return action({ sequence: currentSequence, commit });
    });

    tail = task.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await task;
    } finally {
      pending = Math.max(0, pending - 1);
    }
  }

  async function waitForMergedIndexMutations(): Promise<void> {
    await tail;
  }

  return {
    runMergedIndexMutation,
    waitForMergedIndexMutations,
  };
}
