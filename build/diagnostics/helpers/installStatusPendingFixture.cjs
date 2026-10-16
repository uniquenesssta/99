const assert = require('node:assert/strict')

const pendingSuffix = "  const installStatusSyncSuffix = installStatusReady ? '' : ' · 待确认'\n"
const legacySuffix = "  const installStatusSyncSuffix = installStatusReady ? '' : ' · 同步中'\n"

// Reverse only the reviewed display-copy change, retaining every frozen hash.
// Reverting to the old wording must fail before normalization, not be accepted
// as an alternative baseline.
function restoreInstallStatusPendingCopy(source) {
  const normalized = source.replace(/\r\n/g, '\n')
  assert.equal(normalized.split(pendingSuffix).length, 2, 'install-status pending suffix must occur exactly once')
  return normalized.replace(pendingSuffix, legacySuffix)
}

module.exports = { restoreInstallStatusPendingCopy, pendingSuffix, legacySuffix }
