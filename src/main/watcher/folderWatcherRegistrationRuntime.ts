// Process-local epoch: removal, re-addition and watcher replacement retire prior work.
let generation = 0
export function currentFolderWatcherRegistrationGeneration(): number { return generation }
export function retireFolderWatcherRegistration(): void { generation += 1 }
