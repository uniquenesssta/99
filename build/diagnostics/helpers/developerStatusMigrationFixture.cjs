const assert = require('node:assert/strict')

// Preserve historical business/ownership hashes without accepting new behavior
// implicitly. Every reviewed addition and route must match once before its
// inverse is applied; production behavior is exercised by the controller gates.
const changes = {
  "src/renderer/src/App.tsx": [
    [
      "    actionStatus,\n    reportActionStatus,\n    dismissActionStatus,\n    reportWriteError,\n    clearWriteError,\n    reportQueryError,\n    clearQueryError,\n",
      "",
      "operation status must preserve separate action/write/query owners"
    ],
    [
      "      reportActionStatus,\n      reportWriteError,\n      clearWriteError,\n",
      "",
      "library controller lost visible operation/write feedback"
    ],
    [
      "    getVisibleFonts: () => latestVisibleFontsRef.current,\n    setStatus: reportActionStatus,\n    library,",
      "    getVisibleFonts: () => latestVisibleFontsRef.current,\n    setStatus,\n    library,",
      "context operation feedback disconnected"
    ],
    [
      "    setDatabaseRefreshToken,\n    setStatus: reportActionStatus\n  })",
      "    setDatabaseRefreshToken,\n    setStatus\n  })",
      "folder operation feedback disconnected"
    ],
    [
      "    setSidebarPage,\n    setStatus: reportActionStatus,\n    refreshDatabaseDerivedState,",
      "    setSidebarPage,\n    setStatus,\n    refreshDatabaseDerivedState,",
      "dialog operation feedback disconnected"
    ],
    [
      "    setStatus: reportQueryError,\n    onReadRecovered: clearQueryError",
      "    setStatus",
      "database query failure/recovery feedback disconnected"
    ],
    [
      "      operationNotice={{ message: actionStatus, onDismiss: dismissActionStatus }}\n",
      "",
      "App must wire one dismissible operation notice"
    ]
  ],
  "src/renderer/src/runtime/app/useLibraryController.ts": [
    [
      "import { useCallback,useEffect,useMemo,useRef,useState } from 'react'",
      "import { useEffect,useMemo,useRef,useState } from 'react'",
      "stable callback import changed"
    ],
    [
      "  const [status, setStatusState] = useState('准备就绪')\n  const statusRef = useRef(status)\n  const [actionStatus, setActionStatus] = useState<string | null>(null)\n  const actionStatusSourceRef = useRef<'operation' | 'load' | 'save' | 'write' | 'query' | null>(null)",
      "  const [status, setStatus] = useState('准备就绪')",
      "independent operation status ownership changed"
    ],
    [
      "  const setStatus = useCallback((update: SetStateAction<string>): void => {\n    const message = typeof update === 'function' ? update(statusRef.current) : update\n    statusRef.current = message\n    setStatusState(message)\n  }, [])\n\n  // Diagnostic updates never replace a pending user-operation receipt.\n  const reportFeedback = useCallback((source: NonNullable<typeof actionStatusSourceRef.current>, update: SetStateAction<string>): void => {\n    if (options.closingLifecycle.isClosing()) return\n    setStatus(update)\n    actionStatusSourceRef.current = source\n    setActionStatus(statusRef.current)\n  }, [options.closingLifecycle, setStatus])\n\n  const clearFeedback = useCallback((source: typeof actionStatusSourceRef.current): void => {\n    if (actionStatusSourceRef.current !== source) return\n    actionStatusSourceRef.current = null\n    setActionStatus(null)\n  }, [])\n  const reportActionStatus = useCallback((message: SetStateAction<string>): void => reportFeedback('operation', message), [reportFeedback])\n  const reportLoadError = useCallback((message: string): void => reportFeedback('load', message), [reportFeedback])\n  const clearLoadError = useCallback((): void => clearFeedback('load'), [clearFeedback])\n  const reportSaveError = useCallback((message: SetStateAction<string>): void => reportFeedback('save', message), [reportFeedback])\n  const reportWriteError = useCallback((message: string): void => reportFeedback('write', message), [reportFeedback])\n  const clearWriteError = useCallback((): void => clearFeedback('write'), [clearFeedback])\n  const reportQueryError = useCallback((message: SetStateAction<string>): void => reportFeedback('query', message), [reportFeedback])\n  const clearQueryError = useCallback((): void => clearFeedback('query'), [clearFeedback])\n  const dismissActionStatus = useCallback((): void => {\n    actionStatusSourceRef.current = null\n    setActionStatus(null)\n  }, [])\n\n",
      "",
      "reviewed feedback callbacks, sources, closing guard or directional recovery changed"
    ],
    [
      "    setStatus: reportSaveError,\n    onPersistenceRecovered: () => { clearFeedback('save'); refreshDatabaseDerivedState() }",
      "    setStatus,\n    onPersistenceRecovered: refreshDatabaseDerivedState",
      "save failure/recovery routing changed"
    ],
    [
      "    reportError: reportLoadError,\n    onRecovered: clearLoadError,\n",
      "",
      "load failure/recovery routing changed"
    ],
    [
      "    actionStatus,\n    reportActionStatus,\n    dismissActionStatus,\n    reportWriteError,\n    clearWriteError,\n    reportQueryError,\n    clearQueryError,\n",
      "",
      "exported feedback ports changed"
    ]
  ],
  "src/renderer/src/runtime/app/useFontOperationsController.ts": [
    [
      "  reportActionStatus: Dispatch<SetStateAction<string>>\n  reportWriteError: (message: string) => void\n  clearWriteError: () => void\n",
      "",
      "operation/write feedback interface changed"
    ],
    [
      "    reportError: options.library.reportWriteError,\n    onRecovered: options.library.clearWriteError,\n",
      "",
      "write failure/recovery routing changed"
    ],
    [
      "    activeOperationFontIds,\n    setLibrary: options.library.setLibrary,\n    setStatus: options.library.reportActionStatus,",
      "    activeOperationFontIds,\n    setLibrary: options.library.setLibrary,\n    setStatus: options.library.setStatus,",
      "system action feedback route changed"
    ],
    [
      "    commitLibraryUpdate: options.library.commitLibraryUpdate,\n    setStatus: options.library.reportActionStatus,",
      "    commitLibraryUpdate: options.library.commitLibraryUpdate,\n    setStatus: options.library.setStatus,",
      "index action feedback route changed"
    ],
    [
      "      options.library.reportActionStatus(missingFontCommandTargetsMessage(resolved.missingIds))",
      "      options.library.setStatus(missingFontCommandTargetsMessage(resolved.missingIds))",
      "missing font command target feedback changed"
    ],
    [
      "    options.library.reportActionStatus(`${nextValue ? '加入保护' : '取消保护'}已在界面生效，后台队列写入 ${changedFonts.length} 个，跳过未变化 ${targetFonts.length - changedFonts.length} 个。`)",
      "    options.library.setStatus(`${nextValue ? '加入保护' : '取消保护'}已在界面生效，后台队列写入 ${changedFonts.length} 个，跳过未变化 ${targetFonts.length - changedFonts.length} 个。`)",
      "protection receipt feedback changed"
    ]
  ]
}

function restoreDeveloperStatusMigration(file, source) {
  source = source.replace(/\r\n/g, '\n')
  for (const [before, after, message] of changes[file] || []) {
    assert.equal(source.split(before).length - 1, 1, `${file}: ${message}`)
    source = source.replace(before, after)
  }
  return source
}
function normalizeOperationStatusWiring(app) {
  return restoreDeveloperStatusMigration('src/renderer/src/App.tsx', app)
}
module.exports = { restoreDeveloperStatusMigration, normalizeOperationStatusWiring }
