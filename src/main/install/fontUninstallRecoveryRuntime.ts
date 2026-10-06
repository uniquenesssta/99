import { dirname, parse, resolve } from 'node:path'
import type { FontItem, InstallResult, SystemInstalledFont } from '../../shared/types'
import { sharedFileSystem as fs } from '../path/sharedFileSystemRuntime'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { applicationWorkEpoch, assertApplicationOpen, isApplicationClosing, noteRecoveryPersistenceFailure } from '../app/shutdownCoordinatorRuntime'
import { fontPhysicalKey } from '../fonts/fontContentIdentityRuntime'
import { readInstallSourceIdentity, independentInstallCopy, type InstallSourceIdentity } from './fontInstallEvidenceRuntime'
import { planFontUninstall, readFontMutationIdentity } from './fontUninstallPlanRuntime'
import { fontRegistryRecordKey, resolveFontRegistryPaths } from './fontUninstallReferenceRuntime'
import type { FontMutationSession } from './fontMutationProcessRuntime'
import type { FontUninstallReceipt, FontUninstallReceiptStore, FontUninstallStep } from './fontUninstallReceiptRuntime'
import type { SystemFontInstallRuntimeDeps } from './systemFontInstallRuntime'

type Session = { get: () => Promise<FontMutationSession> }
const sameTarget = (a: InstallSourceIdentity, b: InstallSourceIdentity) => key(a.path) === key(b.path) && a.sha256 === b.sha256
  && !!fontPhysicalKey(a) && fontPhysicalKey(a) === fontPhysicalKey(b) && a.size === b.size && a.modified === b.modified

export function createFontUninstallRecoveryRuntime(deps: SystemFontInstallRuntimeDeps) {
  const tails = new Map<string, Promise<unknown>>()
  async function run(item: FontItem, session: Session, ticket: number): Promise<InstallResult> {
    let receipt: FontUninstallReceipt | undefined, store: FontUninstallReceiptStore | undefined
    let durable = false, stage = 'protection-preflight', cancelled = false
    const write = () => {
      if (!receipt || !store) throw new Error('卸载恢复存储尚未就绪。')
      try { receipt = store.save(receipt); durable = true }
      catch (error) { noteRecoveryPersistenceFailure(error); throw error }
    }
    const failed = (error: unknown): InstallResult => {
      let message = error instanceof Error ? error.message : String(error)
      cancelled ||= isApplicationClosing() || applicationWorkEpoch() !== ticket
      const remainingPaths = receipt?.steps.filter(step => step.plan.delete_file && step.state !== 'done').map(step => step.plan.path) || []
      if (remainingPaths.length) message += ` 安装文件尚未清理完成：${remainingPaths.join('；')}。请核对失败原因后重试卸载。`
      if (cancelled) message = `卸载已取消，未完成目标保留。${message}`
      if (durable && receipt) {
        receipt = { ...receipt, stage, message, cancelled }
        try { write() } catch (saveError) { message += ` 恢复进度保存失败，原恢复记录保留：${String(saveError)}` }
      }
      deps.appendStartupLog(`font uninstall failure: ${JSON.stringify({ id: item.id, path: item.path, stage, completedSteps: receipt?.completedSteps || 0, pending: durable, cancelled, message, remainingPaths })}`)
      return { ok: false, message, uninstall: { completedSteps: receipt?.completedSteps || 0, remainingPaths, stage, pending: durable, cancelled } }
    }
    const registry = () => deps.readUninstallRegistry?.() || session.get().then(native => native.readRegistry())
    const checkOpen = () => assertApplicationOpen(ticket)
    try {
      deps.ensureWindows(); checkOpen()
      stage = 'receipt-load'
      store = await deps.openUninstallReceipts()
      receipt = store.load(item.path); durable = !!receipt
      if (!receipt) {
        await deps.withFontProtection([item], async () => undefined)
        stage = 'source-identity'
        const source = await readInstallSourceIdentity(item, deps.readHistoricalFont)
        stage = 'registry-snapshot'
        const records = await registry()
        stage = 'installed-fonts'
        const installed = await deps.getSystemInstalledFonts()
        stage = 'uninstall-plan'
        const targets = new Map<string, InstallSourceIdentity>()
        let evidence: Record<string, unknown> = {}
        const plans = await planFontUninstall(item, [...records, ...installed], records, [deps.currentUserFontsDir(), deps.windowsFontsDir()], deps.isTemporaryActiveInstalledRecord, {
          source, appName: deps.appName, onTarget: target => targets.set(key(target.path), target),
          report: value => { evidence = value; deps.appendStartupLog(`font uninstall evidence: ${JSON.stringify({ id: item.id, ...value })}`) },
        })
        if (!plans.length) throw new Error(evidence.candidateCount === 0 ? '当前系统记录没有关联安装候选，旧卡片状态不能授予卸载目标。' : evidence.confirmedCount === 0 ? '名称候选的文件内容均不一致，未关联或删除安装文件。' : '已确认字体内容，但没有可解除的登记或独立安装副本；源文件保留。')
        // Individual registry steps make an acknowledgement unambiguous. They
        // still share one native broker/elevation session for the entire batch.
        const steps = plans.flatMap(plan => plan.delete_file ? [plan] : plan.records.map(record => ({ ...plan, records: [record] })))
          .map(plan => ({ plan, target: targets.get(key(plan.path))!, state: 'pending' as const }))
        receipt = { version: 1, revision: 0, sourcePath: item.path, sourceId: item.id, source, steps, completedSteps: 0,
          stage: 'planned', message: '卸载尚未完成；已保存原始目标，重试将重新核验。' }
      }
      const readSource = () => readInstallSourceIdentity({ ...item, id: receipt!.sourceId }, async path => {
        // A durable receipt is itself main-owned historical proof, even when
        // an untagged source disappears after partial success.
        if (key(path) === key(receipt!.sourcePath)) return { ...item, id: receipt!.sourceId, path: receipt!.sourcePath,
          fileSize: receipt!.source.size, modifiedAt: receipt!.source.modified, recoveryContentHash: receipt!.source.sha256, recoveryFileStamp: receipt!.source.stamp }
        return deps.readHistoricalFont?.(path)
      })
      const checkSource = async () => {
        const read = await readSource()
        const source = read.historical ? { ...read, path: receipt!.source.path } : read
        if (!sameTarget(receipt!.source, source) || source.stamp !== receipt!.source.stamp) throw new Error('源字体身份已变化，未完成卸载保留；请恢复原来源后重试。')
      }
      const checkRole = (step: FontUninstallStep) => {
        if (!step.plan.delete_file && !step.plan.preflight_file) return
        const roots = [deps.currentUserFontsDir(), deps.windowsFontsDir()]
        if (!independentInstallCopy(receipt!.source, step.target) || !roots.some(root => key(dirname(step.plan.path)) === key(resolve(root)))
          || !!step.plan.allow_readonly_copy && key(dirname(step.plan.path)) !== key(resolve(roots[0]))) throw new Error('安装副本角色或目录已变化，未允许文件或属性清理。')
      }
      const checkReferences = async (records: SystemInstalledFont[], current: FontUninstallStep) => {
        const byName = new Map<string, SystemInstalledFont[]>()
        for (const record of records) {
          const identity = fontRegistryRecordKey({ scope: record.source, name: record.registryName })
          byName.set(identity, [...(byName.get(identity) || []), record])
        }
        for (const step of receipt!.steps.filter(step => !step.plan.delete_file)) {
          const expected = step.plan.records[0]
          const actual = byName.get(fontRegistryRecordKey(expected)) || []
          if (actual.length > 1 || actual.some(record => record.value !== expected.value || deps.isTemporaryActiveInstalledRecord(record))) throw new Error('原登记值或临时引用已变化，原计划不会删除新的登记。')
          if (step.state === 'done' && actual.length) throw new Error('已完成的登记名称被重新使用，保留新登记和剩余文件；请核对后处理。')
        }
        if (!current.plan.delete_file && !current.plan.preflight_file) return
        const paths = await resolveFontRegistryPaths(records)
        const allowed = new Map(receipt!.steps.filter(step => !step.plan.delete_file && step.state !== 'done').map(step => {
          const record = step.plan.records[0]; return [fontRegistryRecordKey(record), record.value]
        }))
        for (const record of records) {
          if (paths.get(key(record.path!)) !== key(current.plan.path)) continue
          const identity = fontRegistryRecordKey({ scope: record.source, name: record.registryName })
          if (deps.isTemporaryActiveInstalledRecord(record) || current.plan.delete_file || allowed.get(identity) !== record.value) throw new Error('安装引用已变化或存在临时/未授权引用，文件及属性保留；原计划不会吸收新引用。')
        }
      }
      const settle = async (): Promise<InstallResult> => {
        stage = 'persist-result'
        deps.clearInstalledFontsMemoryCache()
        const installCompare = await deps.persistUninstallResult(item)
        stage = 'receipt-clear'
        try { store!.remove(receipt!) } catch (error) { noteRecoveryPersistenceFailure(error); throw error }
        durable = false
        let warning = ''
        try { await deps.advancedFontRefresh('uninstall-font') } catch (error) { warning = ` 字体通知失败：${String(error)}` }
        return { ok: true, installCompare: installCompare || undefined, message: '原计划关联登记与独立安装副本已核验处理；所选源文件及其属性保留。' + warning }
      }
      // A lost final acknowledgement must not require the old source to remain
      // readable merely to settle an already absent target. This pass is read-only.
      if (durable && receipt.steps.some(step => step.state !== 'done')) {
        stage = 'receipt-reconcile'
        const records = await registry()
        let changed = false
        for (const step of receipt.steps) {
          if (step.state === 'done') continue
          if (!step.plan.delete_file) {
            const expected = step.plan.records[0]
            if (!records.some(record => fontRegistryRecordKey({ scope: record.source, name: record.registryName }) === fontRegistryRecordKey(expected))) {
              step.state = 'done'; changed = true
            }
          } else {
            try { await fs.realpath(step.plan.path) }
            catch (error) {
              if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !(await fs.stat(parse(step.plan.path).root)).isDirectory()) throw error
              step.state = 'done'; changed = true
            }
          }
        }
        if (changed) write()
      }
      if (receipt.steps.every(step => step.state === 'done')) return await settle()
      const targets = [item, { ...item, path: receipt.source.path }, ...receipt.steps.filter(step => step.state !== 'done').map(step => ({ ...item, path: step.plan.path }))]
      stage = 'target-protection'
      return await deps.withFontProtection(targets, async checkProtection => {
        const check = async () => { checkOpen(); await checkProtection(); await checkSource(); checkOpen() }
        // All effects already acknowledged: only settle local projection/journal.
        if (receipt!.steps.some(step => step.state !== 'done')) await check()
        if (!durable) { stage = 'receipt-create'; write() }
        for (let index = 0; index < receipt!.steps.length; index++) {
          let step = receipt!.steps[index]
          if (step.state === 'done') continue
          checkOpen(); checkRole(step)
          stage = 'retry-registry-snapshot'
          const records = await registry()
          if (!step.plan.delete_file) {
            const expected = step.plan.records[0]
            const actual = records.filter(record => fontRegistryRecordKey({ scope: record.source, name: record.registryName }) === fontRegistryRecordKey(expected))
            if (!actual.length) {
              step.state = 'done'; stage = 'receipt-reconcile'; write(); continue
            }
            if (step.state === 'attempted') throw new Error('上次登记删除回执中断，原名称当前仍存在或已被复用；无法安全自动重放，请先核对该登记。')
          }
          stage = step.plan.delete_file ? 'file-delete' : 'registry-delete'
          await checkReferences(records, step)
          stage = 'target-identity'
          try {
            if (!sameTarget(step.target, await readFontMutationIdentity(step.plan.path))) throw new Error('安装目标身份已变化，后续同路径文件不会被当作残留删除。')
          } catch (error) {
            if (step.plan.delete_file && (error as NodeJS.ErrnoException)?.code === 'ENOENT' && (await fs.stat(parse(step.plan.path).root)).isDirectory()) {
              step.state = 'done'; stage = 'receipt-reconcile'; write(); continue
            }
            throw error
          }
          const native = await session.get()
          stage = step.plan.delete_file ? 'file-delete' : 'registry-delete'
          const result = await native.execute(step.plan, async (references, gate) => {
            await check()
            const current = receipt!.steps[index]
            checkRole(current)
            if (!sameTarget(current.target, await readFontMutationIdentity(current.plan.path))) throw new Error('安装目标身份已变化，文件和后续登记操作保留。')
            if (references) await checkReferences(references, current)
            // Write before allow:true at the actual side-effect gate. A failed
            // preflight/UAC wait has not attempted the registry deletion.
            if (gate === 'registry' || gate === 'file') {
              current.state = 'attempted'; receipt!.stage = stage; write()
            }
            checkOpen()
          })
          step = receipt!.steps[index]
          receipt!.completedSteps += result.completedSteps
          const acknowledged = step.plan.delete_file ? result.fileRemoved : result.completedSteps === 1
          if (acknowledged) step.state = 'done'
          else if (result.ok) step.state = 'attempted'
          else if (!result.uncertain) step.state = 'pending'
          cancelled ||= !!result.cancelled
          stage = 'receipt-progress'; write()
          if (!result.ok || !acknowledged) { stage = result.stage || (step.plan.delete_file ? 'file-delete' : 'registry-delete'); return failed(result.ok ? '辅助程序未提供目标完成回执；原计划保留，未报告全部成功。' : result.message) }
        }
        return settle()
      })
    } catch (error) { return failed(error) }
    finally { deps.clearInstalledFontsMemoryCache() }
  }
  function uninstall(item: FontItem, session: Session): Promise<InstallResult> {
    const source = key(item.path), ticket = applicationWorkEpoch()
    const task = (tails.get(source) || Promise.resolve()).catch(() => undefined).then(() => run(item, session, ticket))
    tails.set(source, task)
    void task.finally(() => { if (tails.get(source) === task) tails.delete(source) }).catch(() => undefined)
    return task
  }
  return { uninstall }
}
