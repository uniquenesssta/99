import type { SystemInstalledFont } from '../../shared/types'
import { app } from 'electron'
import { join } from 'node:path'
import { verifyPackagedAppIntegrity } from '../security/appIntegrityRuntime'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolveRustCoreWorkerPath } from '../rust-core/rustCoreWorkerPathRuntime'
import { readFontFileUsage, type FontFileUsage } from './fontFileUsageRuntime'

export type FontMutationPlan = {
  path: string
  sha256: string
  delete_file: boolean
  preflight_file?: boolean
  allow_readonly_copy?: boolean
  records: Array<{ scope: 'HKCU' | 'HKLM'; name: string; value: string }>
  identity?: undefined
}
export type FontMutationReceipt = { ok: boolean; message: string; completedSteps: number; fileRemoved: boolean; code?: number; ntstatus?: number; stage?: string; usage?: FontFileUsage }
export type FontMutationSession = {
  execute: (plan: FontMutationPlan, check: (references?: SystemInstalledFont[]) => Promise<void>) => Promise<FontMutationReceipt>
  readRegistry: () => Promise<SystemInstalledFont[]>
  close: () => void
}

export async function createFontMutationSession(log: (message: string) => void): Promise<FontMutationSession> {
  const worker = app.isPackaged ? join(process.resourcesPath, 'native', 'hfm-core-worker.exe') : resolveRustCoreWorkerPath()
  if (app.isPackaged && !verifyPackagedAppIntegrity(log).ok) throw new Error('打包程序签名或原生模块完整性核验失败。')
  if (!worker) throw new Error('字体操作原生模块不可用，请重新运行开发启动命令构建。')
  // Built alongside the worker and shipped in the same native resources. Do not
  // silently fall back to the old unrestricted registry helper on failure.
  const expected = (await fs.readFile(worker + '.sha256', 'utf8')).trim()
  const actual = createHash('sha256').update(await fs.readFile(worker)).digest('hex')
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual) throw new Error('字体操作辅助程序完整性核验失败。')
  const operationId = randomUUID()
  const child: ChildProcessWithoutNullStreams = spawn(worker, ['--font-mutation-broker'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HFM_PARENT_PID: String(process.pid) }
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = []
  const queue: any[] = []
  let dead: Error | undefined
  let errorText = ''
  let busy = false
  const die = (error: Error) => { dead ||= error; for (const waiter of pending.splice(0)) waiter.reject(dead); child.kill() }
  child.stderr.on('data', data => {
    errorText = (errorText + String(data)).slice(-4096)
    log(`font mutation native: operation=${operationId}, stderr=${JSON.stringify(String(data).slice(-4096))}`)
  })
  child.on('error', die)
  child.on('exit', (code, signal) => die(new Error(`字体操作进程退出，结果可能部分完成：${code ?? signal} ${errorText}`)))
  lines.on('line', line => {
    try {
      if (line.length > 1024 * 1024) throw new Error('字体操作回执过大。')
      const value = JSON.parse(line)
      const waiter = pending.shift()
      if (waiter) waiter.resolve(value)
      else if (queue.length < 1024) queue.push(value)
      else die(new Error('字体操作回执溢出。'))
    } catch (error) { die(error instanceof Error ? error : new Error(String(error))) }
  })
  function next(): Promise<any> {
    if (queue.length) return Promise.resolve(queue.shift())
    if (dead) return Promise.reject(dead)
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }
  const timeout = setTimeout(() => die(new Error('字体操作超时；已停止辅助进程，须核对部分完成结果后重试。')), 180000)
  const close = () => { clearTimeout(timeout); lines.close(); die(new Error('字体操作会话已关闭。')) }
  try {
    if ((await next()).protocol !== 'font-mutation-v1') throw new Error('字体操作协议版本不匹配。')
    if (createHash('sha256').update(await fs.readFile(worker)).digest('hex') !== expected) throw new Error('启动期间辅助程序发生变化。')
  }
  catch (error) { close(); throw error }
  return {
    close,
    async readRegistry() {
      if (busy) throw new Error('执行期间不能插入注册表查询。')
      busy = true
      try {
        child.stdin.write('{"snapshot":true}\n')
        const reply = await next()
        if (!reply.snapshot || !reply.ok || !Array.isArray(reply.records)) throw new Error(reply.message || '安装注册表无法确认。')
        return reply.records
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`font mutation: operation=${operationId}, stage=registry-snapshot, ok=false, reason=${JSON.stringify(message)}`)
        throw new Error(`读取字体安装注册表失败：${message}`)
      } finally { busy = false }
    },
    async execute(plan, check) {
      if (busy) throw new Error('字体操作会话不接受并发计划。')
      busy = true
      let completedSteps = 0, fileRemoved = false
      let failure = '', code: number | undefined
      let ntstatus: number | undefined, stage: string | undefined
      try {
        await check()
        child.stdin.write(JSON.stringify(plan) + '\n')
        for (;;) {
          const value = await next()
          if (value.gate) {
            try {
              if (value.gate === 'file' && !Array.isArray(value.references)) throw new Error('文件删除前缺少原用户安装引用快照。')
              await check(value.references); child.stdin.write('{"allow":true}\n') }
            catch (error) { failure = error instanceof Error ? error.message : String(error); child.stdin.write('{"allow":false}\n') }
          }
          if (value.effect) {
            completedSteps++
            if (value.effect === 'file') fileRemoved = true
            log(`font mutation: operation=${operationId}, target=${plan.path}, stage=${value.effect}, completed=${completedSteps}`)
          }
          if (value.done && !value.ok) { failure ||= value.message || '提权操作失败。'; code = value.code; ntstatus = value.ntstatus ?? undefined; stage = value.stage }
          if (value.brokerDone) {
            if (!value.ok) { failure ||= value.message || '字体操作失败。'; code ??= value.code; ntstatus ??= value.ntstatus ?? undefined; stage ??= value.stage }
            break
          }
        }
        const usage = failure && (code === 32 || ntstatus === 0xc0000121) ? await readFontFileUsage(worker, plan.path) : undefined
        if (usage) log(`font file usage: operation=${operationId}, target=${plan.path}, stage=${stage || 'unknown'}, native=${code}, ntstatus=${ntstatus ?? 'none'}, result=${JSON.stringify(usage)}`)
        const nativeReason = code === 1223 ? '用户取消 UAC 授权。' : ntstatus === 0xc0000121 ? 'Windows 拒绝删除字体（C0000121：只读或文件映射限制）。' : code === 5 ? 'Windows 拒绝操作（可能涉及权限、文件属性或占用）。' : code === 32 ? '字体文件正在被占用。' : ''
        const message = failure ? `${nativeReason}${failure}${usage ? ` ${usage.message}` : ''}${!fileRemoved && completedSteps ? ' 安装记录已部分清理，字体文件尚未确认删除。' : ''}${completedSteps ? ` 已完成 ${completedSteps} 个步骤，未完成部分保留供重试。` : ''}` : plan.delete_file ? '安装文件已移除。' : '本项安装记录已移除，文件清理结果另行确认。'
        log(`font mutation: operation=${operationId}, target=${plan.path}, stage=verified, ok=${!failure}, native=${code ?? 0}, completed=${completedSteps}, reason=${JSON.stringify(message)}`)
        return { ok: !failure, message, completedSteps, fileRemoved, code, ntstatus, stage, usage }
      } catch (error) {
        const message = `${error instanceof Error ? error.message : String(error)} 已确认完成 ${completedSteps} 个步骤；其余状态未知。`
        log(`font mutation: operation=${operationId}, target=${plan.path}, stage=execute, ok=false, completed=${completedSteps}, reason=${JSON.stringify(message)}`)
        return { ok: false, message, completedSteps, fileRemoved }
      } finally { busy = false }
    }
  }
}
