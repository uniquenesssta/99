const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = process.cwd()
const INTEGRITY_PUBLIC_KEY_FILE = path.join(ROOT, 'build', 'security', 'hfm-integrity-public.pem')
const LICENSE_PUBLIC_KEY_FILE = path.join(ROOT, 'build', 'security', 'hfm-license-public.pem')
const OUTPUT_FILE = path.join(ROOT, 'src', 'main', 'security', 'securityPublicKeys.ts')

function normalizePublicKeyPem(pem, label) {
  const normalized = String(pem || '').trim().replace(/\r\n/g, '\n')
  if (!normalized.includes('-----BEGIN PUBLIC KEY-----') || !normalized.includes('-----END PUBLIC KEY-----')) {
    throw new Error(`${label} is not a PUBLIC KEY pem file.`)
  }
  if (normalized.includes('PRIVATE KEY')) {
    throw new Error(`${label} contains PRIVATE KEY. Private keys must never be embedded in src/main/security/securityPublicKeys.ts.`)
  }
  return `${normalized}\n`
}

function readPublicKey(file, label) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${label}: ${file}`)
  return normalizePublicKeyPem(fs.readFileSync(file, 'utf-8'), label)
}

function publicKeyId(pem) {
  return crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16)
}

function tsStringLiteral(value) {
  return `\`\n${value.trim()}\n\``
}

const integrityPem = readPublicKey(INTEGRITY_PUBLIC_KEY_FILE, 'integrity public key')
const licensePem = readPublicKey(LICENSE_PUBLIC_KEY_FILE, 'license public key')

const source = `import { createHash } from 'node:crypto'

function normalizePublicKeyPem(pem: string): string {
  const normalized = pem.trim().replace(/\\r\\n/g, '\\n')
  if (!normalized.includes('-----BEGIN PUBLIC KEY-----') || !normalized.includes('-----END PUBLIC KEY-----')) {
    throw new Error('Invalid HFM public key PEM. Expected BEGIN/END PUBLIC KEY block.')
  }
  if (normalized.includes('PRIVATE KEY')) {
    throw new Error('Invalid HFM public key PEM. PRIVATE KEY must never be embedded in the app.')
  }
  return \`${'${normalized}'}\\n\`
}

function publicKeyId(pem: string): string {
  return createHash('sha256').update(normalizePublicKeyPem(pem)).digest('hex').slice(0, 16)
}

const HFM_INTEGRITY_PUBLIC_KEY_SOURCE = ${tsStringLiteral(integrityPem)}

const HFM_LICENSE_PUBLIC_KEY_SOURCE = ${tsStringLiteral(licensePem)}

export const HFM_INTEGRITY_PUBLIC_KEY_PEM = normalizePublicKeyPem(HFM_INTEGRITY_PUBLIC_KEY_SOURCE)
export const HFM_INTEGRITY_PUBLIC_KEY_ID = publicKeyId(HFM_INTEGRITY_PUBLIC_KEY_PEM)

export const HFM_LICENSE_PUBLIC_KEY_PEM = normalizePublicKeyPem(HFM_LICENSE_PUBLIC_KEY_SOURCE)
export const HFM_LICENSE_PUBLIC_KEY_ID = publicKeyId(HFM_LICENSE_PUBLIC_KEY_PEM)
`

fs.writeFileSync(OUTPUT_FILE, source, 'utf-8')
console.log(`[hfm] synced public keys: integrity=${publicKeyId(integrityPem)}, license=${publicKeyId(licensePem)}`)
