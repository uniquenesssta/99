import { execFile } from 'node:child_process'

type FontFileUser = { pid: number; name: string; service: string; started: string }
export type FontFileUsage = {
  status: 'identified' | 'unidentified' | 'unavailable'
  processes: FontFileUser[]
  message: string
}

export function parseFontFileUsage(raw: string, target: string): FontFileUsage {
  const value = JSON.parse(raw)
  if (!value || value.target !== target) throw new Error('占用查询目标不一致')
  if (value.ok !== true) throw new Error(String(value.message || '系统占用查询失败'))
  if (!Array.isArray(value.processes) || value.processes.length > 128) throw new Error('占用查询结果无效')
  const clean = (text: unknown) => typeof text === 'string' ? text.replace(/[\u0000-\u001f]/g, ' ').slice(0, 1024) : ''
  const processes: FontFileUser[] = value.processes.map((entry: any) => {
    if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0 || entry.pid > 0xffffffff) throw new Error('占用进程编号无效')
    return { pid: entry.pid, name: clean(entry.name), service: clean(entry.service), started: clean(entry.started) }
  })
  if (!processes.length) return { status: 'unidentified', processes, message: '未识别到占用进程；不能排除系统字体映射或占用已释放。' }
  const description = processes.slice(0, 8).map(entry => {
    const name = entry.name || '未知程序'
    return `${name}（PID ${entry.pid}${entry.service ? `，服务 ${entry.service}` : ''}）`
  }).join('；')
  return { status: 'identified', processes, message: `正在使用该文件的进程：${description}${processes.length > 8 ? `；另有 ${processes.length - 8} 个，详见日志` : ''}。` }
}

export async function readFontFileUsage(worker: string, target: string): Promise<FontFileUsage> {
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      // A stuck system query must not prolong uninstall or terminate applications.
      execFile(worker, ['--font-file-usage', target], {
        windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 512 * 1024,
        env: { ...process.env, HFM_PARENT_PID: String(process.pid) }
      }, (error, stdout) => error ? reject(error) : resolve(stdout))
    })
    return parseFontFileUsage(raw, target)
  } catch (error) {
    return { status: 'unavailable', processes: [], message: `占用进程查询未完成：${error instanceof Error ? error.message : String(error)}。` }
  }
}
