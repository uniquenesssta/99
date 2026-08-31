function escapeSvgText(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function missingFontPreviewDataUri(filePath: string, width: number, height: number): string {
  const safePath = escapeSvgText(filePath)
  const safeWidth = Math.max(240, width)
  const safeHeight = Math.max(140, height)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">
  <rect width="100%" height="100%" fill="#10131a"/>
  <rect x="12" y="12" width="${Math.max(0, safeWidth - 24)}" height="${Math.max(0, safeHeight - 24)}" rx="18" fill="#151a24" stroke="#2a3140"/>
  <text x="28" y="52" fill="#f0b4b4" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="22" font-weight="600">字体文件不存在</text>
  <text x="28" y="86" fill="#aeb6c8" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="14">这是失效注册表或旧缓存记录，清理缓存后会移除。</text>
  <text x="28" y="${Math.min(safeHeight - 28, 122)}" fill="#7f8798" font-family="Consolas, Microsoft YaHei, monospace" font-size="12">${safePath}</text>
</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
