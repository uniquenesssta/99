// One owner for application confirmations. HTML dialogs stay in the renderer,
// avoiding the native JavaScript message-box focus handoff on Windows.
let activeDialog: HTMLDialogElement | null = null

export function confirmUserAction(message: string): Promise<boolean> {
  // Never queue a second destructive request behind the user's current choice.
  if (activeDialog) return Promise.resolve(false)
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const dialog = document.createElement('dialog')
  dialog.className = 'modal-backdrop hfm-confirmation-dialog'
  dialog.setAttribute('aria-labelledby', 'hfm-confirmation-title')
  dialog.setAttribute('aria-describedby', 'hfm-confirmation-message')
  const card = document.createElement('div')
  card.className = 'modal-card'
  const title = document.createElement('div')
  title.id = 'hfm-confirmation-title'
  title.className = 'modal-title'
  title.textContent = '确认操作'
  const description = document.createElement('div')
  description.id = 'hfm-confirmation-message'
  description.className = 'modal-subtitle'
  description.textContent = message
  const actions = document.createElement('div')
  actions.className = 'modal-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.dataset.confirmation = 'cancel'
  cancel.textContent = '取消'
  cancel.autofocus = true
  const accept = document.createElement('button')
  accept.type = 'button'
  accept.dataset.confirmation = 'accept'
  accept.textContent = '确定'
  actions.append(cancel, accept)
  card.append(title, description, actions)
  dialog.append(card)

  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (confirmed: boolean, restoreFocus = true): void => {
      if (settled) return
      settled = true
      window.removeEventListener('pagehide', onPageHide)
      if (dialog.open) dialog.close()
      dialog.remove()
      if (activeDialog === dialog) activeDialog = null
      if (restoreFocus && document.hasFocus() && previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true })
      }
      resolve(confirmed)
    }
    const onPageHide = (): void => finish(false, false)
    cancel.addEventListener('click', () => finish(false))
    accept.addEventListener('click', () => finish(true))
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false) })
    dialog.addEventListener('close', () => finish(false))
    dialog.addEventListener('click', event => event.stopPropagation())
    window.addEventListener('pagehide', onPageHide)
    activeDialog = dialog
    try {
      document.body.append(dialog)
      dialog.showModal()
      cancel.focus({ preventScroll: true })
    } catch (error) {
      finish(false)
      console.error('Unable to open confirmation dialog', error)
    }
  })
}
