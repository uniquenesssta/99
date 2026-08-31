import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function powershellJsonLiteral(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

export async function runEncodedPowershell(script: string, timeout = 8000): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded
  ], {
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout
}

function psEscapeSingleQuoted(input: string): string {
  return input.replaceAll("'", "''")
}

export function createElevatedPowerShellRuntime(options: { dataPath: (...parts: string[]) => string }) {
  const { dataPath } = options

  async function runElevatedPowerShellScript(script: string, scriptName: string): Promise<void> {
    const scriptPath = dataPath('runtime', scriptName)
    await fsp.mkdir(dirname(scriptPath), { recursive: true })
    await fsp.writeFile(scriptPath, script, 'utf-8')

    const command = `Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${psEscapeSingleQuoted(scriptPath)}') -Verb RunAs -Wait`
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4
    })
  }

  return { runElevatedPowerShellScript }
}
