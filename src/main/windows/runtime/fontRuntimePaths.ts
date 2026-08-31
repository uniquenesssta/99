import { join } from 'node:path'

export function ensureWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('当前安装/移除字体功能仅支持 Windows。')
  }
}

export function currentUserFontsDir(): string {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) throw new Error('无法读取 LOCALAPPDATA 环境变量。')
  return join(localAppData, 'Microsoft', 'Windows', 'Fonts')
}

export function windowsFontsDir(): string {
  const windir = process.env.WINDIR || 'C:\\Windows'
  return join(windir, 'Fonts')
}
