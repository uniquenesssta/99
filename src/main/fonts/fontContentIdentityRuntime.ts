import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { sharedFileSystem as fs } from '../path/sharedFileSystemRuntime'
import { canonicalizeAbsolutePath } from '../path/pathBoundaryPolicy'

// File IDs are 64-bit on Windows. Never use a rounded Number as ownership.
function exactId(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value).toString() : undefined
}
export function fontPhysicalKey(identity: { stamp: string }): string | undefined {
  try {
    const values = JSON.parse(identity.stamp)
    const dev = exactId(values[0]), ino = exactId(values[1])
    return dev !== undefined && ino !== undefined && ino !== '0' ? `${dev}:${ino}` : undefined
  } catch { return undefined }
}
export async function readFontIdentityMetadata(path: string) {
  const stat = await fs.stat(path)
  // Keep ordinary fractional timestamps; BigIntStats millisecond fields truncate.
  // The shared adapter already transports IDs as decimal strings.
  const raw = stat as unknown as { dev?: unknown; ino?: unknown }
  const exact = typeof raw.dev === 'string' && typeof raw.ino === 'string' ? raw : await fs.stat(path, { bigint: true })
  const dev = exactId(exact.dev), ino = exactId(exact.ino)
  const encoded = (value: string | undefined) => value === undefined ? null : Number.isSafeInteger(Number(value)) ? Number(value) : value
  // null means change-time is unavailable on the shared-file protocol; it is
  // never substituted with creation time. Content and exact file IDs remain required.
  const stamp = JSON.stringify([encoded(dev), encoded(ino), stat.size, stat.mtimeMs, Number.isFinite(stat.ctimeMs) ? stat.ctimeMs : null])
  return { stat, stamp }
}

// Read-only whole-file evidence, shared by recovery and exact mutation planning.
export async function readFontContentIdentity(path: string) {
  const canonical = canonicalizeAbsolutePath(path)
  if (!canonical || canonical.flavor !== 'windows' || !['.ttf', '.otf', '.ttc', '.otc'].includes(extname(path).toLowerCase())) throw new Error('字体操作路径无效。')
  const physical = await fs.realpath(canonical.ioPath)
  const before = await readFontIdentityMetadata(physical)
  const { stat } = before
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('字体文件类型或大小不符合操作要求。')
  const bytes = await fs.readFile(physical)
  const magic = bytes.subarray(0, 4).toString('hex')
  if (!["00010000", "4f54544f", "74746366", "74727565", "74797031"].includes(magic)) throw new Error('文件内容不是受支持的字体。')
  const after = await readFontIdentityMetadata(physical)
  const resolvedAfter = await fs.realpath(canonical.ioPath)
  if (bytes.length !== stat.size || before.stamp !== after.stamp || physical.toLowerCase() !== resolvedAfter.toLowerCase()) throw new Error('字体读取过程中发生变化，未执行。')
  return { path: physical, sha256: createHash('sha256').update(bytes).digest('hex'), size: stat.size, modified: stat.mtimeMs, ino: stat.ino, dev: stat.dev, stamp: before.stamp }
}
