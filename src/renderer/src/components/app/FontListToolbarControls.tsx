import type { CardPoolViewMode, SortMode } from '../../appRuntime'
import { LIST_PREVIEW_FONT_SIZE_MAX, LIST_PREVIEW_FONT_SIZE_MIN, clampListPreviewFontSize } from '../../runtime/preview/listPreviewSizeRuntime'
import { nameSortCycleIcon, nameSortCycleTooltip, nextNameSortMode } from '../../runtime/toolbar/nameSortCycleRuntime'

export function NameSortCycleButton({ sortMode, onChange }: { sortMode: SortMode; onChange: (value: SortMode) => void }): JSX.Element {
  const tooltipText = nameSortCycleTooltip(sortMode)
  return (
    <button
      type="button"
      className={sortMode === 'nameAsc' || sortMode === 'nameDesc' ? 'toolbar-icon-button active name-sort-cycle' : 'toolbar-icon-button name-sort-cycle'}
      aria-label={tooltipText}
      title={tooltipText}
      data-tooltip={tooltipText}
      onClick={() => onChange(nextNameSortMode(sortMode))}
    >
      <span className="toolbar-icon name-sort-icon" aria-hidden="true">{nameSortCycleIcon(sortMode)}</span>
    </button>
  )
}

export function CardPoolViewToggle({ value, onChange, allowFamily = true }: { value: CardPoolViewMode; onChange: (mode: CardPoolViewMode) => void; allowFamily?: boolean }): JSX.Element {
  return (
    <div className="pool-view-toggle" role="group" aria-label="字卡池视图">
      <button
        type="button"
        className={value === 'grid' ? 'active' : ''}
        aria-label="网格视图"
        title="网格视图"
        data-tooltip="网格视图"
        aria-pressed={value === 'grid'}
        onClick={() => onChange('grid')}
      >
        ⊞
      </button>
      <button
        type="button"
        className={value === 'list' ? 'active' : ''}
        aria-label="列表视图"
        title="列表视图"
        data-tooltip="列表视图"
        aria-pressed={value === 'list'}
        onClick={() => onChange('list')}
      >
        ☰
      </button>
      {allowFamily && (
        <button
          type="button"
          className={value === 'family' ? 'active' : ''}
          aria-label="字体家族分组视图"
          title="字体家族分组视图"
          data-tooltip="字体家族分组视图"
          aria-pressed={value === 'family'}
          onClick={() => onChange('family')}
        >
          族
        </button>
      )}
    </div>
  )
}

export function ListPreviewSizeControl({ value, onChange }: { value: number; onChange: (value: number) => void }): JSX.Element {
  const safeValue = clampListPreviewFontSize(value)
  return (
    <label className="list-preview-size-control" title={`列表字号：${safeValue}px`}>
      <span>字号</span>
      <input
        type="range"
        min={LIST_PREVIEW_FONT_SIZE_MIN}
        max={LIST_PREVIEW_FONT_SIZE_MAX}
        step={1}
        value={safeValue}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <em>{safeValue}px</em>
    </label>
  )
}
