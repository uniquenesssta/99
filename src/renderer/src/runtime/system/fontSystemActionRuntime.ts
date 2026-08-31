import { createFontActivationActionRuntime } from './actions/fontActivationActionRuntime'
import { createFontDeleteActionRuntime } from './actions/fontDeleteActionRuntime'
import { createFontFavoriteActionRuntime } from './actions/fontFavoriteActionRuntime'
import { createFontInstallActionRuntime } from './actions/fontInstallActionRuntime'
import type { FontSystemActionRuntime,FontSystemActionRuntimeOptions } from './actions/fontSystemActionTypes'
import { createFontSystemStateRuntime } from './actions/fontSystemStateRuntime'

export type { FontSystemActionRuntime,FontSystemActionRuntimeOptions } from './actions/fontSystemActionTypes'

export function createFontSystemActionRuntime(options: FontSystemActionRuntimeOptions): FontSystemActionRuntime {
  const stateRuntime = createFontSystemStateRuntime(options)
  const favoriteActionRuntime = createFontFavoriteActionRuntime(options, stateRuntime)
  const activationActionRuntime = createFontActivationActionRuntime(options, stateRuntime)
  const installActionRuntime = createFontInstallActionRuntime(options, stateRuntime, activationActionRuntime)
  const deleteActionRuntime = createFontDeleteActionRuntime(options)

  return {
    ...stateRuntime,
    ...favoriteActionRuntime,
    ...installActionRuntime,
    ...deleteActionRuntime,
    ...activationActionRuntime
  }
}
