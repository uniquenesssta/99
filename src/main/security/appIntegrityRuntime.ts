import { app } from 'electron'
import { createHash, verify as verifySignature } from 'node:crypto'
import fs from 'node:fs'
import { join, normalize } from 'node:path'
import { canonicalJson } from './securityCanonicalJson'
import { HFM_INTEGRITY_PUBLIC_KEY_ID, HFM_INTEGRITY_PUBLIC_KEY_PEM } from './securityPublicKeys'

type IntegrityManifestEntry = {
  id: string
  path: string
  kind?: 'asar' | 'native-helper' | 'resource' | string
  sha256: string
  size: number
  signatureAlgorithm?: 'rsa-sha256' | 'ed25519' | string
  signature?: string
}

type IntegrityManifest = {
  version: number
  schema?: string
  generatedAt: string
  publicKeyId?: string
  targets: IntegrityManifestEntry[]
}

type IntegrityManifestSignature = {
  version: number
  schema?: string
  algorithm: 'rsa-sha256' | 'ed25519' | string
  publicKeyId: string
  manifest: string
  signature: string
}

export type AppIntegrityResult = {
  ok: boolean
  skipped: boolean
  errors: string[]
  checked: number
}

type ElectronProcessWithAsar = NodeJS.Process & { noAsar?: boolean }

function withNoAsar<T>(callback: () => T): T {
  const electronProcess = process as ElectronProcessWithAsar
  const previousNoAsar = electronProcess.noAsar
  electronProcess.noAsar = true
  try {
    return callback()
  } finally {
    if (previousNoAsar === undefined) {
      Reflect.deleteProperty(electronProcess, 'noAsar')
    } else {
      electronProcess.noAsar = previousNoAsar
    }
  }
}

function realPathExists(filePath: string): boolean {
  return withNoAsar(() => fs.existsSync(filePath))
}

function realPathStat(filePath: string) {
  return withNoAsar(() => fs.statSync(filePath))
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256')
  const data = withNoAsar(() => fs.readFileSync(filePath))
  hash.update(data)
  return hash.digest('hex')
}

function isSafeManifestPath(relativePath: string): boolean {
  const normalized = normalize(relativePath).replace(/\\/g, '/')
  return Boolean(normalized) && !normalized.startsWith('../') && !normalized.startsWith('/') && !normalized.includes('/../')
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
}

function verifySignedPayload(payload: unknown, signatureBase64: string, algorithm: string): boolean {
  try {
    const data = Buffer.from(canonicalJson(payload), 'utf-8')
    const signature = Buffer.from(signatureBase64, 'base64')
    if (algorithm === 'rsa-sha256') {
      return verifySignature('sha256', data, { key: HFM_INTEGRITY_PUBLIC_KEY_PEM }, signature)
    }
    // Backward compatibility for older manifests that were incorrectly labelled as ed25519
    // even though the key material is RSA.
    if (algorithm === 'ed25519') {
      return verifySignature(null, data, HFM_INTEGRITY_PUBLIC_KEY_PEM, signature)
    }
    return false
  } catch {
    return false
  }
}

function signedTargetPayload(target: IntegrityManifestEntry): Record<string, unknown> {
  return {
    version: 1,
    id: target.id,
    path: target.path,
    kind: target.kind,
    size: target.size,
    sha256: target.sha256
  }
}

function verifyManifestSignature(
  manifest: IntegrityManifest,
  signature: IntegrityManifestSignature,
  errors: string[]
): void {
  if (manifest.publicKeyId && manifest.publicKeyId !== HFM_INTEGRITY_PUBLIC_KEY_ID) {
    errors.push(`完整性清单公钥不匹配：${manifest.publicKeyId}`)
  }
  if (signature.publicKeyId !== HFM_INTEGRITY_PUBLIC_KEY_ID) {
    errors.push(`完整性签名公钥不匹配：${signature.publicKeyId}`)
  }
  if (signature.algorithm !== 'rsa-sha256' && signature.algorithm !== 'ed25519') {
    errors.push(`完整性签名算法不支持：${signature.algorithm}`)
  }
  if (signature.manifest !== 'security-integrity.json') {
    errors.push(`完整性签名指向了未知清单：${signature.manifest}`)
  }
  if (!signature.signature || !verifySignedPayload(manifest, signature.signature, signature.algorithm)) {
    errors.push('完整性清单签名无效')
  }
}

function verifyTargetDetachedSignature(target: IntegrityManifestEntry, errors: string[]): void {
  const requiresTargetSignature = target.kind === 'native-helper' || target.kind === 'asar'
  if (!requiresTargetSignature) return

  if (!target.signatureAlgorithm || !target.signature) {
    errors.push(`缺少目标文件签名：${target.id}`)
    return
  }

  if (!verifySignedPayload(signedTargetPayload(target), target.signature, target.signatureAlgorithm)) {
    errors.push(`目标文件签名无效：${target.id}`)
  }
}

export function verifyPackagedAppIntegrity(appendLog: (message: string) => void): AppIntegrityResult {
  if (!app.isPackaged) {
    return { ok: true, skipped: true, errors: [], checked: 0 }
  }

  const manifestPath = join(process.resourcesPath, 'security-integrity.json')
  const signaturePath = join(process.resourcesPath, 'security-integrity.sig')
  const errors: string[] = []

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      skipped: false,
      errors: [`缺少完整性清单：${manifestPath}`],
      checked: 0
    }
  }

  if (!fs.existsSync(signaturePath)) {
    return {
      ok: false,
      skipped: false,
      errors: [`缺少完整性清单签名：${signaturePath}`],
      checked: 0
    }
  }

  let manifest: IntegrityManifest
  let manifestSignature: IntegrityManifestSignature
  try {
    manifest = readJsonFile<IntegrityManifest>(manifestPath)
    manifestSignature = readJsonFile<IntegrityManifestSignature>(signaturePath)
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      errors: [`完整性清单或签名无法读取：${error instanceof Error ? error.message : String(error)}`],
      checked: 0
    }
  }

  verifyManifestSignature(manifest, manifestSignature, errors)

  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    errors.push('完整性清单没有可校验目标')
  }

  for (const target of manifest.targets || []) {
    if (!isSafeManifestPath(target.path)) {
      errors.push(`完整性清单路径不安全：${target.id || target.path}`)
      continue
    }

    verifyTargetDetachedSignature(target, errors)

    const targetPath = join(process.resourcesPath, target.path)
    if (!realPathExists(targetPath)) {
      errors.push(`文件缺失：${target.id} -> ${target.path}`)
      continue
    }

    const stat = realPathStat(targetPath)
    if (!stat.isFile()) {
      errors.push(`校验目标不是文件：${target.id} -> ${target.path}`)
      continue
    }

    if (stat.size !== target.size) {
      errors.push(`文件大小不匹配：${target.id}`)
      continue
    }

    const actualHash = sha256File(targetPath)
    if (actualHash !== target.sha256) {
      errors.push(`SHA256 不匹配：${target.id}`)
    }
  }

  if (errors.length > 0) {
    appendLog(`packaged integrity check failed: ${errors.join(' | ')}`)
  } else {
    appendLog(`packaged integrity check ok: ${(manifest.targets || []).length} files, signedBy=${manifest.publicKeyId || 'unknown'}, generatedAt=${manifest.generatedAt || 'unknown'}`)
  }

  return {
    ok: errors.length === 0,
    skipped: false,
    errors,
    checked: (manifest.targets || []).length
  }
}
