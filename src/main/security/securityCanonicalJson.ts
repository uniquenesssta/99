function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item))
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item !== undefined) normalized[key] = normalizeValue(item)
    }
    return normalized
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value))
}
