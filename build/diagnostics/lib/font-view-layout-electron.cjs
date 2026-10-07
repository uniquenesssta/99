const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const file = process.argv[2]
const feedbackOnly = process.argv.includes('--dom-feedback')
const watchdog = setTimeout(() => { console.error('DOM layout gate timed out'); app.exit(1) }, 180000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1600, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  console.log('[font-view-layout:electron] window ready')
  await win.loadFile(file)
  win.focus()
  console.log('[font-view-layout:electron] fixture loaded')
  for (const width of [720, 1600]) {
    win.setContentSize(width, 900)
    console.log('[font-view-layout:electron] checking viewport', width)
    if (!feedbackOnly) {
    const result = await win.webContents.executeJavaScript('window.checkLayout()')
    console.log('[font-view-layout:electron]', JSON.stringify(result))
    const detail = await win.webContents.executeJavaScript('window.checkDetailTransitions()')
    console.log('[font-detail-transition:electron]', JSON.stringify(detail))
    const grid = await win.webContents.executeJavaScript('window.checkGridPreviews()')
    console.log('[grid-preview:electron]', JSON.stringify(grid))
    const postprocess = await win.webContents.executeJavaScript('window.checkGridPostprocess()')
    console.log('[grid-postprocess:electron]', JSON.stringify(postprocess))
    }
    console.log('[view-feedback:electron]', JSON.stringify(await win.webContents.executeJavaScript('window.checkViewFeedback()')))
    const drag = await win.webContents.executeJavaScript('window.prepareScrollbarDrag()')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', modifiers: ['leftbuttondown'], x: drag.x, y: drag.y, clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], x: drag.x, y: drag.endY, movementY: drag.endY - drag.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: drag.x, y: drag.endY, clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
    console.log('[floating-scrollbar:electron]', JSON.stringify(await win.webContents.executeJavaScript('window.finishScrollbarDrag()')))
    const evidence = path.resolve('artifacts/font-identity-f04')
    fs.mkdirSync(evidence, { recursive: true })
    const overlayCases = [
      ['list-preview-scroll','hover','context-menu'], ['font-virtual-scroller','drag','context-menu'],
      ['sidebar','scroll','context-menu'], ['detail-panel','hover','toolbar-popover'],
      ['toolbar-left','scroll','cache-menu'], ['font-list','hover','tag-suggestion-list'],
      ['font-waterfall','scroll','context-menu'], ['list-preview-scroll','drag','context-menu'],
      ['font-virtual-scroller','drag','modal-backdrop'],
    ]
    for (let index = 0; index < overlayCases.length; index++) {
      const [host, activity, kind] = overlayCases[index]
      const start = await win.webContents.executeJavaScript(`window.prepareScrollbarOverlay(${JSON.stringify(host)},${JSON.stringify(activity)})`)
      win.webContents.sendInputEvent({ type:'mouseMove', ...start })
      if (activity === 'drag') win.webContents.sendInputEvent({ type:'mouseDown', button:'left', modifiers:['leftbuttondown'], ...start, clickCount:1 })
      // Let native pointer capture take effect before the overlay appears.
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const target = await win.webContents.executeJavaScript(`window.openScrollbarOverlay(${JSON.stringify(kind)})`)
      fs.writeFileSync(path.join(evidence, `${width}-${index}-${kind}.png`), (await win.webContents.capturePage()).toPNG())
      if (activity === 'drag') {
        win.webContents.sendInputEvent({ type:'mouseMove', button:'left', modifiers:['leftbuttondown'], x:start.x+20, y:start.y+20 })
        win.webContents.sendInputEvent({ type:'mouseUp', button:'left', x:start.x+20, y:start.y+20, clickCount:1 })
      }
      win.webContents.sendInputEvent({ type:'mouseMove', x:target.x, y:target.y })
      win.webContents.sendInputEvent({ type:'mouseDown', button:'left', modifiers:['leftbuttondown'], x:target.x, y:target.y, clickCount:1 })
      if (kind === 'modal-backdrop') win.webContents.sendInputEvent({ type:'mouseMove', button:'left', modifiers:['leftbuttondown'], x:target.x, y:target.endY })
      win.webContents.sendInputEvent({ type:'mouseUp', button:'left', x:target.x, y:target.endY || target.y, clickCount:1 })
      win.webContents.sendInputEvent({ type:'mouseMove', x:5, y:5 })
      console.log('[floating-scrollbar-overlay:electron]', JSON.stringify(await win.webContents.executeJavaScript(`window.finishScrollbarOverlay(${JSON.stringify(kind)})`)))
    }
  }
  clearTimeout(watchdog); app.exit(0)
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1) })
