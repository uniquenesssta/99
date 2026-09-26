const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
// Cache files must be complete PNGs, not error text or partially published output.
export function isCompletePreviewPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 45 || !signature.every((value, index) => bytes[index] === value)) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8, hasData = false, first = true
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    if (length > bytes.length - offset - 12) return false
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (first && (type !== 'IHDR' || length !== 13 || !view.getUint32(offset + 8) || !view.getUint32(offset + 12))) return false
    first = false
    let crc = 0xffffffff
    for (let i = offset + 4; i < offset + 8 + length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255]
    }
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(offset + 8 + length)) return false
    if (type === 'IDAT') hasData = true
    offset += length + 12
    if (type === 'IEND') return length === 0 && hasData && offset === bytes.length
  }
  return false
}
