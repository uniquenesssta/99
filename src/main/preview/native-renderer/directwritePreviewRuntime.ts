import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { FontItem } from '../../../shared/types'
import type { FontAdmission } from './directwriteFontStore'
import { DirectwriteFontStore } from './directwriteFontStore'
import { DirectwriteService } from './directwriteService'
import { createDirectwriteFontStaging } from './directwriteFontStaging'
import { DW_RENDER_VERSION } from './directwriteProtocol'
import type { PreviewRuntimeOptions } from '../runtime/previewRuntimeTypes'
import type { PreviewInput } from '../runtime/previewInputPolicy'
import { applicationWorkEpoch, isApplicationClosing } from '../../app/shutdownCoordinatorRuntime'

const recoverable = /^(DW_HELPER_UNAVAILABLE|DW_START_TIMEOUT|DW_PROCESS_CLOSED|DW_HANDSHAKE_INVALID|DW_PROTOCOL_INVALID|DW_RECEIPT_INVALID|DW_NATIVE_(VARIABLE_FONT_UNSUPPORTED|FONT_UNSUPPORTED|FACE_UNSUPPORTED)|DW_FONT_UNAUTHORIZED_file-too-large)$/
export function directwriteImageKey(digest: string, input: PreviewInput): string {
  // The index currently models one record per file, matching its existing face 0 policy.
  return createHash('sha256').update(JSON.stringify(['directwrite-resident', DW_RENDER_VERSION,
    digest, 0, [], input.text, input.fontSize, input.width, input.height, 96, 'transparent', 'rgba-242-244-248'])).digest('hex')
}
export function createDirectwritePreviewRuntime(options: Pick<PreviewRuntimeOptions,
  'localDataRoot' | 'localPreviewImageDir' | 'getFontReadPolicy' | 'authorizeFontRead' | 'appendStartupLog'>,
  publish: (key: string, item: FontItem, input: PreviewInput, outputPath: string, digest: string) => Promise<void>) {
  let resources: { store: DirectwriteFontStore; service: DirectwriteService; prepareImages: (signal?: AbortSignal) => Promise<void> } | undefined
  function acquireResources() {
    if (resources) return resources
    const command = [process.env.HFM_DIRECTWRITE_RESIDENT_PATH,
      join(process.cwd(), 'build/native/directwrite/hfm-directwrite-preview.exe')].find(p => p && existsSync(p))
    if (!command) throw new Error('DW_HELPER_UNAVAILABLE')
    const parent = options.localDataRoot()
    const staging = createDirectwriteFontStaging(command, options.getFontReadPolicy())
    const service = new DirectwriteService({ command, temporaryRoot: parent })
    const store = new DirectwriteFontStore(parent, staging)
    resources = { store, service, prepareImages: async signal => {
      // Store acquisition has validated the parent; validate the image destination too.
      await fs.mkdir(options.localPreviewImageDir(), { recursive: true })
      await staging.prepare(options.localPreviewImageDir(), signal)
    } }
    return resources
  }
  async function render(item: FontItem, input: PreviewInput, admission: FontAdmission,
    fallback: () => Promise<string>): Promise<string> {
    const epoch = applicationWorkEpoch()
    const current = () => !isApplicationClosing() && applicationWorkEpoch() === epoch
      && !admission.signal?.aborted && admission.isCurrent()
    const check = () => { if (!current()) throw new Error('DW_STALE') }
    check()
    try {
      const { store, service, prepareImages } = acquireResources()
      const lease = await store.acquire(item.path, { ...admission, isCurrent: current })
      try {
        const checkLease = () => { check(); if (!lease.current()) throw new Error('DW_STALE') }
        checkLease()
        await prepareImages(admission.signal); checkLease()
        const key = directwriteImageKey(lease.fontIdentity, input)
        const outputPath = join(options.localPreviewImageDir(), `${key}.png`)
        try {
          const stat = await fs.lstat(outputPath)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 24 || stat.size > 40 * 1024 * 1024) throw new Error('DW_CACHE_INVALID')
          const png = await fs.readFile(outputPath)
          if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
            || png.readUInt32BE(16) !== input.width || png.readUInt32BE(20) !== input.height) throw new Error('DW_CACHE_INVALID')
          checkLease()
          options.appendStartupLog('preview backend=directwrite-resident source=local-image-cache')
          return `data:image/png;base64,${png.toString('base64')}`
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as Error).message !== 'DW_CACHE_INVALID') throw error
        }
        const result = await service.render({ ...input, faceIndex: 0, fontPath: lease.fontPath,
          fontIdentity: lease.fontIdentity, sourceGeneration: lease.sourceGeneration }, { signal: admission.signal, isCurrent: () => current() && lease.current() })
        checkLease()
        const temporary = join(options.localPreviewImageDir(), `${key}.${randomBytes(8).toString('hex')}.part`)
        try {
          await fs.writeFile(temporary, result.png, { flag: 'wx' }); checkLease()
          await fs.rename(temporary, outputPath); checkLease()
          await publish(key, item, input, outputPath, lease.fontIdentity); checkLease()
        } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
        options.appendStartupLog(`preview backend=directwrite-resident source=render objectHit=${result.receipt.cacheHit} missingGlyphs=${result.receipt.missingGlyphs}`)
        return `data:image/png;base64,${result.png.toString('base64')}`
      } finally { await service.whenCurrentExecutionClosed(); await lease.release() }
    } catch (error) {
      check()
      const reason = (error as Error).message
      if (!recoverable.test(reason)) throw error
      // A single current-backend attempt owns its own old key/publication path.
      const authorized = await options.authorizeFontRead(item.path)
      check()
      if (!authorized.ok) throw new Error(`DW_FALLBACK_UNAUTHORIZED_${authorized.reason}`)
      options.appendStartupLog(`preview backend=directwrite-resident failed=${reason}; fallback=current`)
      try {
        const result = await fallback(); check()
        options.appendStartupLog('preview backend=current source=controlled-fallback result=ok')
        return result
      } catch (fallbackError) {
        options.appendStartupLog(`preview backend=current source=controlled-fallback result=failed: ${(fallbackError as Error).message}`)
        throw fallbackError
      }
    }
  }
  return { render, async dispose() { if (resources) { await resources.service.dispose(); await resources.store.dispose(); resources = undefined } } }
}
