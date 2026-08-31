import type { FontItem } from '@shared/types'
import type { FontFamilyGroupResult } from '../../runtime/family/fontFamilyGroupingRuntime'
import { fontDisplayName } from '../../appRuntime'

type FontFamilyGroupPanelProps = {
  result: FontFamilyGroupResult | null
  loading: boolean
  error: string
  expandedIds: Record<string, true>
  toggleExpanded: (groupId: string) => void
  renderFontCard: (font: FontItem, compact?: boolean) => JSX.Element
}

function groupStyleSummary(styles: string[]): string[] {
  return styles.filter(Boolean).slice(0, 8)
}

export function FontFamilyGroupPanel({
  result,
  loading,
  error,
  expandedIds,
  toggleExpanded,
  renderFontCard
}: FontFamilyGroupPanelProps): JSX.Element {
  if (error) {
    return (
      <div className="font-family-group-empty">
        <strong>家族分组读取失败</strong>
        <p>{error}</p>
      </div>
    )
  }

  if (loading && !result) {
    return (
      <div className="font-family-group-empty">
        <strong>正在整理字体家族…</strong>
        <p>只显示同一 family 下存在多个字重 / 样式的字体。</p>
      </div>
    )
  }

  const groups = result?.groups || []
  if (!groups.length) {
    return (
      <div className="font-family-group-empty">
        <strong>没有可分组的字体家族</strong>
        <p>当前筛选条件下没有找到多个字重 / 样式的同族字体。</p>
      </div>
    )
  }

  return (
    <div className="font-family-group-page">
      {groups.map((group) => {
        const expanded = !!expandedIds[group.id]
        const styles = groupStyleSummary(group.styles)
        return (
          <section key={group.id} className={expanded ? 'font-family-group-card expanded' : 'font-family-group-card'}>
            <div className="font-family-group-head">
              <button
                type="button"
                className="font-family-group-toggle"
                aria-label={expanded ? '收起字体家族' : '展开字体家族'}
                aria-expanded={expanded}
                onClick={() => toggleExpanded(group.id)}
              >
                {expanded ? '⌄' : '›'}
              </button>
              <div className="font-family-group-title">
                <strong>{group.name}</strong>
                <span>{group.fonts.length} 个款式 · 主款 {fontDisplayName(group.primaryFont)}</span>
                <div className="font-family-group-style-row">
                  {styles.map((style) => <span key={style} className="font-family-group-style-chip">{style}</span>)}
                </div>
              </div>
              <div className="font-family-group-preview" title={fontDisplayName(group.primaryFont)}>
                {fontDisplayName(group.primaryFont)}
              </div>
            </div>
            {expanded && (
              <div className="font-family-group-fonts">
                {group.fonts.map((font) => renderFontCard(font, true))}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
