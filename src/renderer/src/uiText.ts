export function toggleArrayValue<T>(items: T[], value: T): T[] {
  return items.includes(value)
    ? items.filter((item) => item !== value)
    : [...items, value]
}

export function arraysEqual<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export function selectionSummary(count: number, emptyLabel = '全部'): string {
  return count ? `已选 ${count}` : emptyLabel
}

export function scanWorkerStatsText(stats?: { workerCount?: number; queuedForWorkers?: number; reusedKnown?: number }): string {
  if (!stats) return ''
  const known = stats.reusedKnown ? `，复用现有 ${stats.reusedKnown} 个` : ''
  const worker = stats.workerCount ? `，Worker ${stats.workerCount} 个，队列 ${stats.queuedForWorkers || 0} 个` : ''
  return `${known}${worker}`
}

export function stringifyDeveloperValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
