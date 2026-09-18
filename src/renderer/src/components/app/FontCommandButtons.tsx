import { FONT_COMMANDS } from '../../fontCommandRuntime'
import type { FontCommand } from '../../fontCommandRuntime'

export function FontCommandButtons({ count, onCommand, showTagActions = true }: {
  count: number
  onCommand: (action: FontCommand) => void
  showTagActions?: boolean
}): JSX.Element {
  return <>{FONT_COMMANDS.filter(command => showTagActions || !['localTags', 'sharedTags'].includes(command.action)).map(command => {
    const unavailable = count > 1 && (command.action === 'favorite' || command.action === 'unfavorite')
    return <button key={command.action} disabled={!count || unavailable} title={unavailable ? '多选收藏尚未开放，请先选择一个字体' : `${command.label} · ${count} 个字体`} onMouseDown={event => event.preventDefault()} onClick={() => onCommand(command.action)}>{command.label}</button>
  })}</>
}
