import { useSharedAvailability } from '../../sharedAvailabilityRuntime'
import { fontSharedActionBlocked, SHARED_UNAVAILABLE_MESSAGE } from '../../../../shared/sharedAvailability'
import type { FontItem } from '@shared/types'
import { visibleFontCommands } from '../../fontCommandRuntime'
import type { FontCommand } from '../../fontCommandRuntime'

export function FontCommandButtons({ count, fonts, onCommand, showTagActions = true }: {
  count: number
  fonts: FontItem[]
  onCommand: (action: FontCommand) => void
  showTagActions?: boolean
}): JSX.Element {
  const availability = useSharedAvailability()
  return <>{visibleFontCommands(fonts, count).filter(command => showTagActions || !['localTags', 'sharedTags'].includes(command.action)).map(command => {
    const blocked = fontSharedActionBlocked(availability, command.action, fonts)
    return <button key={command.action} disabled={!count || blocked} aria-disabled={!count || blocked} title={blocked ? SHARED_UNAVAILABLE_MESSAGE : `${command.label} · ${count} 个字体`} onMouseDown={event => event.preventDefault()} onClick={() => { if (!blocked && count) onCommand(command.action) }}>{command.label}</button>
  })}</>
}
