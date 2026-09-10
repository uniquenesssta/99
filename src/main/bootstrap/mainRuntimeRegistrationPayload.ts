import type { MainApplicationRegistration, MainApplicationRegistrationGroups } from './mainCompositionContracts'

// Adapt the grouped application boundary to the unchanged lifecycle/IPC consumer.
export function createMainRuntimeRegistrationPayload(
  groups: MainApplicationRegistrationGroups
): MainApplicationRegistration {
  return {
    ...groups.lifecycle,
    ...groups.query,
    ...groups.mutation,
    ...groups.maintenance,
    ...groups.preview,
  }
}
