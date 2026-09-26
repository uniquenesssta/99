// DW-01's fixed rendering semantics: 96 DPI, transparent BGRA, no variable axes.
export const DW_PROTOCOL = 1;
export const DW_RENDER_VERSION = 1;
export const DW_FRAME_LIMIT = 65536;
export interface DirectwriteInput {
  fontPath: string;
  fontIdentity: string; // Authorized staged content identity is supplied by DW-04.
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
  if (Object.keys(value).length !== 8 || value.type !== 'ready' || value.protocolVersion !== DW_PROTOCOL
    || value.renderVersion !== DW_RENDER_VERSION || value.engine !== 'directwrite' || value.resident !== true
    || value.variableFonts !== false || value.serviceGeneration !== generation || value.parentPid !== process.pid) throw new Error('DW_HANDSHAKE_INVALID');
}
export function validateDirectwriteReceipt(value: Record<string, unknown>, request: DirectwriteRequest): DirectwriteReceipt {
  if (Object.keys(value).length !== 15 || value.type !== 'result' || value.protocolVersion !== DW_PROTOCOL
    || value.renderVersion !== DW_RENDER_VERSION || value.engine !== 'directwrite'
    || value.serviceGeneration !== request.serviceGeneration || value.requestId !== request.requestId
    || value.sourceGeneration !== request.sourceGeneration || value.fontIdentity !== request.fontIdentity
    || value.outputIdentity !== request.outputIdentity || value.faceIndex !== request.faceIndex
    || typeof value.ok !== 'boolean' || typeof value.reason !== 'string'
    || (value.ok ? value.reason !== '' : !/^[A-Z_0-9]{1,80}$/.test(value.reason))
    || !uint(value.glyphRuns) || !uint(value.missingGlyphs) || !uint(value.elapsedMs)) throw new Error('DW_RECEIPT_INVALID');
  return value as unknown as DirectwriteReceipt;
}
