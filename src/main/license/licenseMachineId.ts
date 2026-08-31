import { createHash } from 'node:crypto'
import os from 'node:os'

function normalizePart(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

export function createLicenseMachineId(): string {
  const userInfo = (() => {
    try {
      return os.userInfo()
    } catch {
      return { username: '' }
    }
  })()

  const parts = [
    'hfm-license-machine-v1',
    process.platform,
    process.arch,
    normalizePart(os.hostname()),
    normalizePart(userInfo.username),
    normalizePart(process.env.COMPUTERNAME),
    normalizePart(process.env.USERDOMAIN),
    normalizePart(process.env.PROCESSOR_IDENTIFIER)
  ]

  return createHash('sha256').update(parts.join('\n')).digest('hex')
}
