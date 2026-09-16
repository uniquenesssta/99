import type { useFontOperationsController } from './useFontOperationsController'
import type { useDeveloperController } from './useDeveloperController'

type OperationsCommands = Pick<ReturnType<typeof useFontOperationsController>, 'reportUserActivity' | 'rendererUserActive' | 'updateFont'>
type DeveloperCommands = Pick<ReturnType<typeof useDeveloperController>, 'appendDeveloperStatus'>

// One render's forward command bindings; no domain state or cross-render storage.
export function createAppControllerPorts() {
  let operations: OperationsCommands | undefined
  let developer: DeveloperCommands | undefined
  return {
    bindOperations(commands: OperationsCommands): void { operations = commands },
    bindDeveloper(commands: DeveloperCommands): void { developer = commands },
    operations(): OperationsCommands {
      if (!operations) throw new Error('App Operations commands used before initialization')
      return operations
    },
    developer(): DeveloperCommands {
      if (!developer) throw new Error('App Developer commands used before initialization')
      return developer
    }
  }
}
