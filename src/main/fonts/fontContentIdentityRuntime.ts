import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { sharedFileSystem as fs } from '../path/sharedFileSystemRuntime'
import { canonicalizeAbsolutePath } from '../path/pathBoundaryPolicy'

// Read-only whole-file evidence, shared by recovery and exact mutation planning.
export async function readFontContentIdentity(path: string) {
  const canonical = canonicalizeAbsolutePath(path)
  if (!canonical || canonical.flavor !== 'windows' || !['.ttf', '.otf', '.ttc', '.otc'].includes(extname(path).toLowerCase())) throw new Error('字体操作路径无效。')
  const physical = await fs.realpath(canonical.ioPath)
  const stat = await fs.stat(physical)
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('字体文件类型或大小不符合操作要求。')
  const bytes = await fs.readFile(physical)
  const magic = bytes.subarray(0, 4).toString('hex')
  if (!["00010000", "4f54544f", "74746366", "74727565", "74797031"].includes(magic)) throw new Error('文件内容不是受支持的字体。')
  const after = await fs.stat(physical)
  const resolvedAfter = await fs.realpath(canonical.ioPath)
  if (bytes.length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino || stat.dev !== after.dev || stat.ctimeMs !== after.ctimeMs || physical.toLowerCase() !== resolvedAfter.toLowerCase()) throw new Error('字体读取过程中发生变化，未执行。')
  return { path: physical, sha256: createHash('sha256').update(bytes).digest('hex'), size: stat.size, modified: stat.mtimeMs, ino: stat.ino, dev: stat.dev, stamp: JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]) }
}
