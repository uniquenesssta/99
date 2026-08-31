export type RustStateFallbackProtocolCommand =
  | '--root-index-apply-changes'
  | '--install-status-read'
  | '--install-status-save'
  | '--local-tags-read'
  | '--local-tags-set'
  | '--local-tags-delete-tag'
  | '--shared-metadata-apply'
  | '--shared-metadata-remove-tag'
  | '--shared-metadata-known-tags'
  | '--shared-metadata-overlay-read'

export type RustStateFallbackFailureProtocolSnapshot = {
  commands: RustStateFallbackProtocolCommand[]
  nodeFallbackPolicyGate: 'HFM_NODE_STATE_FALLBACK=1'
  failureLogSuffix: string
  daemonSubmittedWriteFallback: 'blocked'
}

const STATE_FALLBACK_PROTOCOL_COMMANDS: RustStateFallbackProtocolCommand[] = [
  '--root-index-apply-changes',
  '--install-status-read',
  '--install-status-save',
  '--local-tags-read',
  '--local-tags-set',
  '--local-tags-delete-tag',
  '--shared-metadata-apply',
  '--shared-metadata-remove-tag',
  '--shared-metadata-known-tags',
  '--shared-metadata-overlay-read',
]

const POLICY_GATE = 'HFM_NODE_STATE_FALLBACK=1' as const
const FAILURE_LOG_SUFFIX = `Node fallback is policy-gated by ${POLICY_GATE}`

export function rustStateFallbackFailureProtocolCommands(): RustStateFallbackProtocolCommand[] {
  return [...STATE_FALLBACK_PROTOCOL_COMMANDS]
}

export function isRustStateFallbackProtocolCommand(command: string): command is RustStateFallbackProtocolCommand {
  return STATE_FALLBACK_PROTOCOL_COMMANDS.includes(command as RustStateFallbackProtocolCommand)
}

export function rustStateFallbackFailureLogSuffix(command: RustStateFallbackProtocolCommand): string {
  return isRustStateFallbackProtocolCommand(command) ? FAILURE_LOG_SUFFIX : 'Node fallback remains active'
}

export function rustStateFallbackFailureProtocolSnapshot(): RustStateFallbackFailureProtocolSnapshot {
  return {
    commands: rustStateFallbackFailureProtocolCommands(),
    nodeFallbackPolicyGate: POLICY_GATE,
    failureLogSuffix: FAILURE_LOG_SUFFIX,
    daemonSubmittedWriteFallback: 'blocked',
  }
}
