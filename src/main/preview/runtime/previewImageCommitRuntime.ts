import { randomUUID } from 'node:crypto'
import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { applicationWorkEpoch, isApplicationClosing } from '../../app/shutdownCoordinatorRuntime'

export interface PreviewImageLease {
  temporaryPath: string
  signal: AbortSignal
  current: () => boolean
  commit: () => Promise<boolean>
  release: () => Promise<void>
}

type Entry = { hydrates: Set<AbortController>; version: number; refs: number; renders: number; commit: Promise<unknown> }
const outputs = new Map<string, Entry>()

/** Only the short local commit is serialized. Remote reads never own the final PNG. */
export function claimPreviewImage(outputPath: string, kind: 'render' | 'hydrate' | 'display', valid: () => boolean = () => true): PreviewImageLease {
  // A visible byte result never owns the persistent output. Claim its publication
  // lease only if a legacy/local renderer actually produced a file to commit.
  if (kind === 'display') {
    const controller = new AbortController(), epoch = applicationWorkEpoch()
    const temporaryPath = `${outputPath}.display.${randomUUID()}.png`
    let released = false
    let publication: PreviewImageLease | undefined
    let publicationTask: Promise<boolean> | undefined
    const current = () => !released && !controller.signal.aborted && !isApplicationClosing() && applicationWorkEpoch() === epoch && valid()
    return {
      temporaryPath,
      signal: controller.signal,
      current,
      commit: () => {
        if (!publicationTask) publicationTask = (async () => {
          if (!current()) return false
          publication = claimPreviewImage(outputPath, 'render', current)
          await fsp.rename(temporaryPath, publication.temporaryPath)
          return publication.commit()
        })()
        return publicationTask
      },
      release: async () => {
        if (released) return
        released = true
        controller.abort()
        if (publicationTask) await publicationTask.catch(() => undefined)
        if (publication) await publication.release()
        await fsp.unlink(temporaryPath).catch(() => undefined)
      },
    }
  }

  let entry = outputs.get(outputPath)
  if (!entry) { entry = { hydrates: new Set(), version: 0, refs: 0, renders: 0, commit: Promise.resolve() }; outputs.set(outputPath, entry) }
  const owner = entry
  const controller = new AbortController()
  if (kind === 'render') { owner.version += 1; owner.renders += 1; for (const pending of owner.hydrates) pending.abort() }
  else owner.hydrates.add(controller)
  const version = owner.version, epoch = applicationWorkEpoch()
  owner.refs += 1
  const temporaryPath = `${outputPath}.${kind}.${randomUUID()}.png`
  let released = false
  const current = () => !controller.signal.aborted && !released && !isApplicationClosing() && applicationWorkEpoch() === epoch && valid() && owner.version === version && (kind === 'render' || owner.renders === 0)
  return {
    temporaryPath,
    signal: controller.signal,
    current,
    commit: async () => {
      const task = owner.commit.catch(() => undefined).then(async () => {
        if (!current()) return false
        await fsp.rename(temporaryPath, outputPath)
        return current()
      })
      owner.commit = task
      return task
    },
    release: async () => {
      if (released) return
      released = true
      controller.abort()
      owner.hydrates.delete(controller)
      await owner.commit.catch(() => undefined)
      await fsp.unlink(temporaryPath).catch(() => undefined)
      if (kind === 'render') owner.renders -= 1
      owner.refs -= 1
      if (!owner.refs && outputs.get(outputPath) === owner) outputs.delete(outputPath)
    },
  }
}
