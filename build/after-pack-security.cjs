const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const INTEGRITY_PRIVATE_KEY_FILE = path.join(__dirname, 'security', 'hfm-integrity-private.pem')
const MANIFEST_FILE = 'security-integrity.json'
const SIGNATURE_FILE = 'security-integrity.sig'
const SIGNATURE_ALGORITHM = 'rsa-sha256'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key])
      return result
    }, {})
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function loadPrivateKeyPem() {
  if (process.env.HFM_INTEGRITY_PRIVATE_KEY_PEM) return process.env.HFM_INTEGRITY_PRIVATE_KEY_PEM
  const configuredFile = process.env.HFM_INTEGRITY_PRIVATE_KEY_FILE
  if (configuredFile && fs.existsSync(configuredFile)) return fs.readFileSync(configuredFile, 'utf-8')
  if (fs.existsSync(INTEGRITY_PRIVATE_KEY_FILE)) return fs.readFileSync(INTEGRITY_PRIVATE_KEY_FILE, 'utf-8')
  throw new Error(
    'Missing integrity private key. Set HFM_INTEGRITY_PRIVATE_KEY_PEM / HFM_INTEGRITY_PRIVATE_KEY_FILE, or create build/security/hfm-integrity-private.pem.'
  )
}

function publicKeyIdForPrivateKey(privateKeyPem) {
  const publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' })
  return sha256(String(publicKeyPem)).slice(0, 16)
}

function signCanonical(privateKeyPem, value) {
  return crypto.sign('sha256', Buffer.from(canonicalJson(value), 'utf-8'), { key: privateKeyPem }).toString('base64')
}

function signedTargetPayload(target) {
  return {
    version: 1,
    id: target.id,
    path: target.path,
    kind: target.kind,
    size: target.size,
    sha256: target.sha256
  }
}

function addTarget(targets, resourcesDir, relativePath, id = relativePath, kind = 'resource', privateKeyPem = '') {
  const filePath = path.join(resourcesDir, relativePath)
  if (!fs.existsSync(filePath)) return
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) return
  const target = {
    id,
    path: relativePath.replace(/\\/g, '/'),
    kind,
    sha256: sha256File(filePath),
    size: stat.size
  }

  if (privateKeyPem && (kind === 'native-helper' || kind === 'asar')) {
    target.signatureAlgorithm = SIGNATURE_ALGORITHM
    target.signature = signCanonical(privateKeyPem, signedTargetPayload(target))
  }

  targets.push(target)
}

exports.default = async function afterPackSecurity(context) {
  const resourcesDir = path.join(context.appOutDir, 'resources')
  const privateKeyPem = loadPrivateKeyPem()
  const publicKeyId = publicKeyIdForPrivateKey(privateKeyPem)
  const targets = []

  addTarget(targets, resourcesDir, 'app.asar', 'app.asar', 'asar', privateKeyPem)
  addTarget(targets, resourcesDir, path.join('native', 'hfm-font-helper.exe'), 'native:hfm-font-helper.exe', 'native-helper', privateKeyPem)
  addTarget(targets, resourcesDir, path.join('native', 'hfm-preview-renderer.exe'), 'native:hfm-preview-renderer.exe', 'native-helper', privateKeyPem)
  addTarget(targets, resourcesDir, path.join('native', 'hfm-core-worker.exe'), 'native:hfm-core-worker.exe', 'native-helper', privateKeyPem)
  addTarget(targets, resourcesDir, 'app.ico', 'resource:app.ico', 'resource', privateKeyPem)

  const manifest = {
    version: 2,
    schema: 'hfm-integrity-manifest-v2',
    generatedAt: new Date().toISOString(),
    productName: context.packager.appInfo.productName,
    publicKeyId,
    targets
  }

  const manifestSignature = {
    version: 1,
    schema: 'hfm-integrity-signature-v1',
    algorithm: SIGNATURE_ALGORITHM,
    publicKeyId,
    manifest: MANIFEST_FILE,
    signature: signCanonical(privateKeyPem, manifest)
  }

  fs.writeFileSync(path.join(resourcesDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8')
  fs.writeFileSync(path.join(resourcesDir, SIGNATURE_FILE), JSON.stringify(manifestSignature, null, 2), 'utf-8')
}

module.exports = exports.default
