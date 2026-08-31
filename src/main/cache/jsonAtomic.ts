import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'

async function writeTempFile(tempPath: string, json: string): Promise<void> {
  await fsp.mkdir(dirname(tempPath), { recursive: true })
  await fsp.writeFile(tempPath, json, 'utf-8')
}

async function renameWithOverwrite(tempPath: string, filePath: string): Promise<void> {
  try {
    await fsp.rename(tempPath, filePath)
  } catch (error: any) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      await fsp.rm(filePath, { force: true }).catch(() => undefined)
      await fsp.rename(tempPath, filePath)
      return
    }
    throw error
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value)
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeTempFile(tempPath, json)
  try {
    await renameWithOverwrite(tempPath, filePath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined)
      await writeTempFile(tempPath, json)
      await renameWithOverwrite(tempPath, filePath)
      return
    }
    await fsp.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}
