export function buildDbQueryWorkerBootstrapSource(): string {
  return String.raw`
parentPort.on('message', (message) => {
  try {
    let result
    if (message && message.type === 'queryMergedIndexPage') result = queryMergedIndexPage(message.payload)
    else if (message && message.type === 'queryMergedIndexMetrics') result = queryMergedIndexMetrics(message.payload)
    else if (message && message.type === 'readInstallStatusIndex') result = readInstallStatusIndex(message.payload)
    else if (message && message.type === 'saveInstallStatusIndex') result = saveInstallStatusIndex(message.payload)
    else throw new Error('unknown db worker message')
    parentPort.postMessage({ id: message.id, ok: true, result })
  } catch (error) {
    parentPort.postMessage({ id: message && message.id, ok: false, error: error && error.message ? error.message : String(error), code: error && error.code })
  }
})
`;
}
