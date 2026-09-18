import { FONT_COMMANDS } from '../../fontCommandRuntime'
import type { FontCommand } from '../../fontCommandRuntime'

export function FontCommandButtons({ count, onCommand, showTagActions = true }: {
  count: number
  onCommand: (action: FontCommand) => void
  showTagActions?: boolean
}): JSX.Element {
  return <>{FONT_COMMANDS.filter(command => showTagActions || !['localTags', 'sharedTags'].includes(command.action)).map(command => {
    return <button key={command.action} disabled={!count} title={`${command.label} · ${count} 个字体`} onMouseDown={event => event.preventDefault()} onClick={() => onCommand(command.action)}>{command.label}</button>
  })}</>
}
