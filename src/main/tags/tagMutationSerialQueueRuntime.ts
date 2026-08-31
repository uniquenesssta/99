export type TagMutationSerialQueueScope = 'local' | 'shared'

export function createTagMutationSerialQueueRuntime() {
  const tails: Record<TagMutationSerialQueueScope, Promise<void>> = {
    local: Promise.resolve(),
    shared: Promise.resolve(),
  }

  async function run<T>(scope: TagMutationSerialQueueScope, action: () => Promise<T>): Promise<T> {
    const previous = tails[scope]
    let release: () => void = () => undefined
    tails[scope] = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
    }
  }

  return { run }
}
