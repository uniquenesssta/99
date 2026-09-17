// Read-only controlled production-chain probes; no user DB, Windows GUI or NAS calls.
// Historical reproduced=true observations remain available at c352c81.
const probes = require('../../build/diagnostics/check-runtime-feedback.cjs')
;(async () => {
  const observations = []
  for (const [index, [name, probe]] of Object.entries(probes).entries()) {
    try {
      await probe()
      observations.push({ id: `W-0${index + 1}`, chain: name, reproduced: false, correctedAssertions: 'passed' })
    } catch (error) {
      observations.push({ id: `W-0${index + 1}`, chain: name, reproduced: null, correctedAssertions: 'failed', message: error.message })
      process.exitCode = 1
    }
  }
  console.log(JSON.stringify({ scope: 'current production chains with controlled I/O; a probe failure alone does not prove the original defect; no real Windows timing claim', observations }, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
