const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const file = process.argv[2]
const feedbackOnly = process.argv.includes('--dom-feedback')
const watchdog = setTimeout(() => { console.error('DOM layout gate timed out'); app.exit(1) }, 180000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1600, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  // Electron may replace a rejected renderer exception with a generic error.
  // Return plain failure data across the boundary, then still fail the gate.
  const evaluate = async code => {
    const result = await win.webContents.executeJavaScript(`(async () => {
      try { return { ok: true, value: await (${code}) } }
      catch (error) {
        return { ok: false, message: String(error), stack: error?.stack,
          width: innerWidth, focused: document.hasFocus(), active: document.activeElement?.outerHTML?.slice(0, 300),
          inputs: ['local','shared'].map(scope => {
            const input = document.getElementById('font-' + scope + '-tag-input'), r = input?.getBoundingClientRect();
            return { scope, present: !!input, disabled: input?.matches(':disabled'), value: input?.value,
              rect: r?.toJSON(), containerDisplay: input?.closest('.inline-create') && getComputedStyle(input.closest('.inline-create')).display };
          }) };
      }
    })()`)
    if (!result.ok) {
      const evidence = path.resolve('artifacts/font-identity-f04'), prefix = `${feedbackOnly ? 'feedback' : 'full'}-${result.width}-dom-failure`
      fs.mkdirSync(evidence, { recursive: true })
      fs.writeFileSync(path.join(evidence, prefix + '.json'), JSON.stringify({ code, ...result }, null, 2))
      console.error('[font-view-layout:renderer-failure]', JSON.stringify({ code, ...result }))
      try { fs.writeFileSync(path.join(evidence, prefix + '.png'), (await win.webContents.capturePage()).toPNG()) }
      catch (error) { console.error('[font-view-layout:failure-screenshot]', String(error)) }
      throw Error(result.message)
    }
    return result.value
  }
  console.log('[font-view-layout:electron] window ready')
  await win.loadFile(file)
  win.focus()
  console.log('[font-view-layout:electron] fixture loaded')
  for (const width of [720, 1600]) {
    win.setContentSize(width, 900)
    console.log('[font-view-layout:electron] checking viewport', width)
    if (!feedbackOnly) {
    const result = await evaluate('window.checkLayout()')
    console.log('[font-view-layout:electron]', JSON.stringify(result))
    const detail = await evaluate('window.checkDetailTransitions()')
    console.log('[font-detail-transition:electron]', JSON.stringify(detail))
    const grid = await evaluate('window.checkGridPreviews()')
    console.log('[grid-preview:electron]', JSON.stringify(grid))
    const postprocess = await evaluate('window.checkGridPostprocess()')
    console.log('[grid-postprocess:electron]', JSON.stringify(postprocess))
    }
    console.log('[view-feedback:electron]', JSON.stringify(await evaluate('window.checkViewFeedback()')))
    const drag = await evaluate('window.prepareScrollbarDrag()')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', modifiers: ['leftbuttondown'], x: drag.x, y: drag.y, clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], x: drag.x, y: drag.endY, movementY: drag.endY - drag.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: drag.x, y: drag.endY, clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
    console.log('[floating-scrollbar:electron]', JSON.stringify(await evaluate('window.finishScrollbarDrag()')))
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
      const start = await evaluate(`window.prepareScrollbarOverlay(${JSON.stringify(host)},${JSON.stringify(activity)})`)
      win.webContents.sendInputEvent({ type:'mouseMove', ...start })
      if (activity === 'drag') win.webContents.sendInputEvent({ type:'mouseDown', button:'left', modifiers:['leftbuttondown'], ...start, clickCount:1 })
      // Let native pointer capture take effect before the overlay appears.
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const target = await evaluate(`window.openScrollbarOverlay(${JSON.stringify(kind)})`)
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
      console.log('[floating-scrollbar-overlay:electron]', JSON.stringify(await evaluate(`window.finishScrollbarOverlay(${JSON.stringify(kind)})`)))
    }
    // No window/webContents refocus between closing a dialog and real input:
    // doing so would hide the Windows focus regression this gate must detect.
    const click = p => {
      win.webContents.sendInputEvent({type:'mouseMove', ...p})
      win.webContents.sendInputEvent({type:'mouseDown', button:'left', modifiers:['leftbuttondown'], ...p, clickCount:1})
      win.webContents.sendInputEvent({type:'mouseUp', button:'left', ...p, clickCount:1})
    }
    const key = keyCode => {
      win.webContents.sendInputEvent({type:'keyDown', keyCode})
      win.webContents.sendInputEvent({type:'keyUp', keyCode})
    }
    await evaluate('window.prepareConfirmationFocus()')
    let accepted=0,tagWrites=0
    for (const [index,choice] of ['accept','cancel','Escape','Enter','accept','cancel'].entries()) {
      console.log('[confirmation-focus:electron]', JSON.stringify({ width, index, choice }))
      click(await evaluate('window.confirmationOpenPoint()'))
      const buttons=await evaluate('window.checkConfirmationOpen()')
      if(choice==='accept'||choice==='cancel')click(buttons[choice]);else key(choice)
      if(choice==='accept')accepted++
      await evaluate(`window.checkConfirmationClosed(${choice==='accept'},${accepted})`)
      for(const scope of ['local','shared']) {
        const value=`${scope}-${index}`
        click(await evaluate(`window.confirmationInputPoint(${JSON.stringify(scope)})`))
        for(const character of value)win.webContents.sendInputEvent({type:'char',keyCode:character})
        const add=await evaluate(`window.checkConfirmationTyping(${JSON.stringify(scope)},${JSON.stringify(value)})`)
        if(index%2===0)click(add);else key('Enter')
        await evaluate(`window.checkConfirmationTag(${JSON.stringify(scope)},${JSON.stringify(value)},${++tagWrites})`)
      }
    }
    fs.writeFileSync(path.join(evidence, `${width}-confirmation-tags.png`), (await win.webContents.capturePage()).toPNG())
    console.log('[confirmation-focus:electron]',JSON.stringify(await evaluate('window.checkConfirmationLifecycle()')))
  }
  clearTimeout(watchdog); app.exit(0)
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1) })
