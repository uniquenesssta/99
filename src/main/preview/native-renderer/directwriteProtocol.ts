// DW-01's fixed rendering semantics: 96 DPI, transparent BGRA, no variable axes.
export const DW_PROTOCOL = 2;
export const DW_RENDER_VERSION = 1;
export const DW_FRAME_LIMIT = 65536;
export interface DirectwriteInput {
  fontPath: string;
  fontIdentity: string; // Expected SHA-256 of the local font bytes; staging authorization belongs to DW-04.
  sourceGeneration: number;
  faceIndex: number;
  text: string;
  fontSize: number;
  width: number;
  height: number;
}
export interface DirectwriteRequest extends DirectwriteInput {
  requestId: number;
  serviceGeneration: number;
  outputIdentity: string;
  outputPath: string;
}
export interface DirectwriteReceipt {
  type: 'result'; protocolVersion: number; renderVersion: number; engine: 'directwrite';
  serviceGeneration: number; requestId: number; sourceGeneration: number;
  fontIdentity: string; outputIdentity: string; faceIndex: number;
  ok: boolean; reason: string; glyphRuns: number; missingGlyphs: number; elapsedMs: number;
  cacheHit: boolean; fontObjectId: number; contentHash: string;
  cache: DirectwriteCacheStats;
}
export interface DirectwriteCacheStats {
  hits: number; misses: number; loads: number; evictions: number; entries: number; bytes: number;
  liveEntries: number; liveBytes: number; sourceReads: number; sourceBytes: number; privateBytes: number; peakPrivateBytes: number;
}
const uint = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
function validText(text: string, max: number): boolean {
  if (typeof text !== 'string' || text.length > max || text.includes('\0')) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function localPath(value: string): boolean {
  return validText(value, 8192) && /^[a-z]:\\/i.test(value) && !value.slice(2).includes(':');
}
export function validateDirectwriteInput(input: DirectwriteInput): void {
  if (!localPath(input.fontPath) || !/^[0-9a-f]{64}$/.test(input.fontIdentity)
    || !uint(input.sourceGeneration) || !uint(input.faceIndex) || !validText(input.text, 4096)
    || !Number.isFinite(input.fontSize) || input.fontSize < 8 || input.fontSize > 320
    || !uint(input.width) || input.width < 64 || input.width > 4096
    || !uint(input.height) || input.height < 32 || input.height > 2048) throw new Error('DW_INPUT_INVALID');
}
export function encodeDirectwriteRequest(request: DirectwriteRequest): Buffer {
  validateDirectwriteInput(request);
  if (!uint(request.requestId) || !request.requestId || !uint(request.serviceGeneration) || !request.serviceGeneration
    || !/^[0-9a-f]{32}$/.test(request.outputIdentity) || !localPath(request.outputPath)) throw new Error('DW_INPUT_INVALID');
  const strings = [request.fontPath, request.text, request.outputPath].map(value => Buffer.from(value, 'utf16le'));
  const size = 40 + 96 + strings.reduce((sum, value) => sum + 4 + value.length, 0);
  if (size > DW_FRAME_LIMIT) throw new Error('DW_INPUT_INVALID');
  const frame = Buffer.alloc(4 + size); frame.writeUInt32LE(size);
  [DW_PROTOCOL, request.serviceGeneration, request.requestId, request.sourceGeneration, DW_RENDER_VERSION,
    request.faceIndex, request.width, request.height].forEach((n, i) => frame.writeUInt32LE(n, 4 + i * 4));
  frame.writeDoubleLE(request.fontSize, 36);
  frame.write(request.fontIdentity, 44, 64, 'ascii'); frame.write(request.outputIdentity, 108, 32, 'ascii');
  let offset = 140;
  for (const value of strings) {
    frame.writeUInt32LE(value.length / 2, offset); offset += 4;
    value.copy(frame, offset); offset += value.length;
  }
  return frame;
}
export function parseDirectwriteMessage(line: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('DW_PROTOCOL_INVALID'); }
  // Canonical wire JSON also rejects duplicate fields, lossy numbers and padding.
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value) !== line) throw new Error('DW_PROTOCOL_INVALID');
  return value as Record<string, unknown>;
}
export function validateDirectwriteReady(value: Record<string, unknown>, generation: number): void {
  if (Object.keys(value).length !== 9 || value.type !== 'ready' || value.protocolVersion !== DW_PROTOCOL
    || value.renderVersion !== DW_RENDER_VERSION || value.engine !== 'directwrite' || value.resident !== true
    || value.variableFonts !== false || value.cacheVersion !== 1 || value.serviceGeneration !== generation || value.parentPid !== process.pid) throw new Error('DW_HANDSHAKE_INVALID');
}
function validCache(value: unknown): value is DirectwriteCacheStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cache = value as Record<string, unknown>;
  const keys = ['hits', 'misses', 'loads', 'evictions', 'entries', 'bytes', 'liveEntries', 'liveBytes', 'sourceReads', 'sourceBytes', 'privateBytes', 'peakPrivateBytes'];
  if (Object.keys(cache).length !== keys.length || keys.some(key => typeof cache[key] !== 'number'
      || !Number.isSafeInteger(cache[key]) || (cache[key] as number) < 0)) return false;
  const stats = value as DirectwriteCacheStats;
  return stats.entries <= 128 && stats.bytes <= 256 * 1024 * 1024 && stats.liveEntries === stats.entries
    && stats.liveBytes <= stats.bytes && stats.privateBytes > 0 && stats.privateBytes <= stats.peakPrivateBytes
    && stats.peakPrivateBytes <= 512 * 1024 * 1024;
}
export function validateDirectwriteReceipt(value: Record<string, unknown>, request: DirectwriteRequest): DirectwriteReceipt {
  if (Object.keys(value).length !== 19 || value.type !== 'result' || value.protocolVersion !== DW_PROTOCOL
    || value.renderVersion !== DW_RENDER_VERSION || value.engine !== 'directwrite'
    || value.serviceGeneration !== request.serviceGeneration || value.requestId !== request.requestId
    || value.sourceGeneration !== request.sourceGeneration || value.fontIdentity !== request.fontIdentity
    || value.outputIdentity !== request.outputIdentity || value.faceIndex !== request.faceIndex
    || typeof value.ok !== 'boolean' || typeof value.reason !== 'string'
    || (value.ok ? value.reason !== '' : !/^[A-Z_0-9]{1,80}$/.test(value.reason))
    || !uint(value.glyphRuns) || !uint(value.missingGlyphs) || !uint(value.elapsedMs)
    || typeof value.cacheHit !== 'boolean' || !Number.isSafeInteger(value.fontObjectId) || (value.fontObjectId as number) < 0
    || !validCache(value.cache) || (value.ok ? value.contentHash !== request.fontIdentity || !value.fontObjectId : value.contentHash !== '')
    || (value.cacheHit && (!value.ok || value.cache.hits < 1))
    || (value.ok && (value.fontObjectId as number) > value.cache.loads)) throw new Error('DW_RECEIPT_INVALID');
  return value as unknown as DirectwriteReceipt;
}
