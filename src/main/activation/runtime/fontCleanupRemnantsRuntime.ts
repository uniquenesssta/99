import { app, shell } from 'electron'
import { createHash } from 'node:crypto'
import type { FontCleanupAction, FontCleanupReport, FontCleanupRecord } from '../../../shared/fontCleanup'
import type { TemporaryActiveFontRecord } from '../../windows/runtime/fontRuntimeTypes'
import type { FontActivationRuntimeDeps } from './fontActivationTypes'
import type { FontActivationCleanupRuntime } from './fontActivationCleanupRuntime'
import { createFontActivationCompensationQueue } from './fontActivationCompensationQueue'
import { createManagedActivationIdentityRuntime, validManagedIdentity } from './managedActivationIdentityRuntime'

const token = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex')
export function createFontCleanupRemnantsRuntime(deps: FontActivationRuntimeDeps, cleanup: FontActivationCleanupRuntime, retry: () => Promise<unknown>) {
  const compensation = createFontActivationCompensationQueue(deps)
  const identity = createManagedActivationIdentityRuntime(deps)
  type Entry = { record: TemporaryActiveFontRecord; source: 'session' | 'compensation' | 'delete'; partial?: boolean; stage: string; error: string }
  const key = (entry: Entry) => token([entry.source, entry.record.installPath, entry.record.sessionId || '', entry.record.activatedAt, entry.partial === true])
  async function entries(): Promise<{ values: Entry[]; errors: string[] }> {
    const values: Entry[] = [], errors: string[] = []
    try { for (const record of (await deps.loadTemporaryActiveFonts()).records) if (record.stage !== 'active' || record.lastError || !record.identity) values.push({ record, source: 'session', stage: record.stage || 'legacy', error: record.lastError || '' }) } catch (error) { errors.push(`会话记录：${String(error)}`) }
    try { for (const entry of await compensation.load()) values.push({ record: entry.record, source: 'compensation', stage: Object.entries(entry.pending).filter(([,pending]) => pending).map(([stage]) => stage).join(',') || 'journal', error: entry.lastError }) } catch (error) { errors.push(`恢复记录：${String(error)}`) }
    try { for (const record of await cleanup.loadPendingTemporaryFontDeletes()) values.push({ record, source: 'delete', stage: 'file-pending', error: record.lastError || '' }) } catch (error) { errors.push(`删除记录：${String(error)}`) }
    for (const entry of [...values]) {
      if (entry.source !== 'compensation' || entry.record.identity) continue;
      try {
        const partialPath = `${entry.record.installPath}.partial`;
        if (await identity.inspect(partialPath)) values.push({ ...entry, partial: true, stage: 'copy-partial', record: { ...entry.record, installPath: partialPath, fileName: `${entry.record.fileName}.partial` } });
      } catch (error) { errors.push(`半文件核验：${String(error)}`) }
    }
    return { values, errors }
  }
  async function readFontCleanupRemnants(): Promise<FontCleanupReport> {
    const { values, errors } = await entries()
    const records: FontCleanupRecord[] = []
    for (const entry of values) {
      const record: FontCleanupRecord = { key: key(entry), fileName: entry.record.fileName, path: entry.record.installPath, stage: entry.stage, error: entry.error, canAdopt: false }
      if (!validManagedIdentity(entry.record.identity)) {
        try {
          const observed = await identity.inspect(entry.record.installPath)
          if (observed) { record.canAdopt = true; record.observedToken = token(observed) }
        } catch (error) { record.error ||= String(error) }
      }
      if (!entry.partial) {
        try { record.canDismissMissing = !(await identity.inspect(entry.record.installPath)); } catch { /* Unknown is not missing. */ }
      }
      records.push(record)
    }
    return { records, errors }
  }
  async function runFontCleanupAction(input: FontCleanupAction): Promise<FontCleanupReport> {
    if (!input || Array.isArray(input) || typeof input !== 'object' || !['retry','restart','adopt','dismiss-missing','open-records','open-fonts'].includes(input.action)) throw new Error('无效的残留处理动作。')
    if (Object.keys(input).some(key => !(input.action === 'adopt' ? ['action','key','observedToken'] : input.action === 'dismiss-missing' ? ['action','key','windowsRestarted'] : ['action']).includes(key))) throw new Error('残留处理参数包含未知字段。')
    if (input.action === 'dismiss-missing') {
      if (input.windowsRestarted !== true || !/^[a-f0-9]{40}$/.test(input.key || '')) throw new Error('需要确认已重启 Windows。')
      const entry = (await entries()).values.find(entry => key(entry) === input.key)
      if (!entry || entry.partial || !entry.record.registryName) throw new Error('失效记录已变化。')
      if (await identity.inspect(entry.record.installPath)) throw new Error('该路径仍有文件，不能清除记录。')
      await cleanup.confirmManagedRecordMissing(entry.record)
      const same = (record: TemporaryActiveFontRecord) => record.installPath === entry.record.installPath && record.activatedAt === entry.record.activatedAt && record.sessionId === entry.record.sessionId
      if (entry.source === 'session') {
        const state = await deps.loadTemporaryActiveFonts()
        await deps.saveTemporaryActiveFonts({version:1,records:state.records.filter(record => !same(record))})
      } else if (entry.source === 'compensation') await compensation.remove(entry.record)
      else await cleanup.updatePendingTemporaryFontDeletes(records => records.filter(record => !same(record)))
    } else if (input.action === 'retry') await retry()
    else if (input.action === 'open-records' || input.action === 'open-fonts') {
      const error = await shell.openPath(input.action === 'open-records' ? deps.dataRoot() : deps.currentUserFontsDir())
      if (error) throw new Error(error)
    } else if (input.action === 'restart') {
      const existing = await entries()
      if (!existing.values.length && !existing.errors.length) throw new Error('没有需要恢复的本地记录。')
      const quote = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
      const command = [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()])].map(quote).join(' ')
      const result = await deps.runRustFontActivationFiles?.({ restartCommand: command })
      if (!result?.ok) throw new Error('未能登记重启后清理。请重启后手动打开软件重试。')
    } else if (input.action === 'adopt') {
      if (!/^[a-f0-9]{40}$/.test(input.key || '') || !/^[a-f0-9]{40}$/.test(input.observedToken || '')) throw new Error('无效的残留身份令牌。')
      const entry = (await entries()).values.find(entry => key(entry) === input.key)
      if (!entry || entry.record.identity) throw new Error('记录已变化或已有身份，不能接管。')
      const observed = await identity.inspect(entry.record.installPath)
      if (!observed || token(observed) !== input.observedToken) throw new Error('显示之后文件已经变化，请刷新后核验。')
      const next = { ...entry.record, identity: observed }
      if (entry.partial) {
        // Register a separate file-only task first. Keep the original intent until
        // a retry confirms both original destination and partial are absent.
        const queued = await cleanup.queueTemporaryFontFileDeletes([next], 'manual-partial-adoption');
        if (!queued[next.installPath]?.ok) throw new Error(queued[next.installPath]?.message || '半文件登记失败。');
      } else if (entry.source === 'session') {
        const state = await deps.loadTemporaryActiveFonts()
        await deps.saveTemporaryActiveFonts({ version: 1, records: state.records.map(record => record.installPath === next.installPath && record.activatedAt === next.activatedAt ? next : record) })
      } else if (entry.source === 'compensation') {
        const current = (await compensation.load()).find(value => value.record.installPath === next.installPath && value.record.activatedAt === next.activatedAt)
        if (!current) throw new Error('恢复记录已变化。')
        await compensation.upsert({ ...current, record: next })
      } else await cleanup.updatePendingTemporaryFontDeletes(records => records.map(record => record.installPath === next.installPath && record.activatedAt === next.activatedAt ? { ...record, identity: observed } : record))
    }
    return readFontCleanupRemnants()
  }
  return { readFontCleanupRemnants, runFontCleanupAction }
}
