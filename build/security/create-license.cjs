const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const DEFAULT_PRIVATE_KEY_FILE = path.join(process.cwd(), 'build', 'security', 'hfm-license-private.pem')
const DEFAULT_FEATURES = [
  'basic_library',
  'local_tags',
  'font_activation',
  'batch_activation',
  'shared_tags',
  'nas_shared_library',
  'advanced_index',
  'advanced_preview_cache',
  'maintenance_tools'
]

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

function machineId() {
  let username = ''
  try { username = os.userInfo().username || '' } catch { username = '' }
  const parts = [
    'hfm-license-machine-v1',
    process.platform,
    process.arch,
    String(os.hostname() || '').trim().toLowerCase(),
    String(username || '').trim().toLowerCase(),
    String(process.env.COMPUTERNAME || '').trim().toLowerCase(),
    String(process.env.USERDOMAIN || '').trim().toLowerCase(),
    String(process.env.PROCESSOR_IDENTIFIER || '').trim().toLowerCase()
  ]
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex')
}

function readPrivateKey() {
  if (process.env.HFM_LICENSE_PRIVATE_KEY_PEM) return process.env.HFM_LICENSE_PRIVATE_KEY_PEM
  const file = process.env.HFM_LICENSE_PRIVATE_KEY_FILE || DEFAULT_PRIVATE_KEY_FILE
  if (!fs.existsSync(file)) throw new Error(`Missing license private key: ${file}`)
  return fs.readFileSync(file, 'utf-8')
}

function parseArgs(argv) {
  const args = {}
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) args[key] = 'true'
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function addYears(date, years) {
  const copy = new Date(date.getTime())
  copy.setUTCFullYear(copy.getUTCFullYear() + years)
  return copy
}

function main() {
  const args = parseArgs(process.argv)
  const issuedAt = new Date().toISOString()
  const features = String(args.features || DEFAULT_FEATURES.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const deviceId = args.device === 'current' ? machineId() : args.device || undefined
  const expiresAt = args.expires || (args.years ? addYears(new Date(), Number(args.years)).toISOString() : undefined)
  const payload = {
    version: 1,
    product: 'HanFontManager',
    edition: args.edition || 'pro',
    issuedAt,
    expiresAt,
    deviceId,
    seats: args.seats ? Number(args.seats) : undefined,
    features,
    note: args.note
  }
  const privateKey = readPrivateKey()
  const signature = crypto.sign('sha256', Buffer.from(canonicalJson(payload), 'utf-8'), { key: privateKey }).toString('base64')
  const license = { ...payload, signature }
  const output = args.out || 'hfm-license.json'
  fs.writeFileSync(output, JSON.stringify(license, null, 2), 'utf-8')
  console.log(`license written: ${output}`)
  console.log(`deviceId: ${deviceId || '<not-bound>'}`)
}

main()
