// Executed inside Electron's Chromium; no synthetic DOM or CSS evaluator.
module.exports = async function checkLayout() {
  const close = (actual, expected, label) => { if (Math.abs(actual - expected) > 1) throw Error(`${label}: actual=${actual}, expected=${expected}`) }
  // Geometry reads force real layout; yielding a task also works on CI desktops
  // that do not deliver animation frames to hidden/minimized windows.
  const frame = () => new Promise(resolve => setTimeout(resolve, 0))
  const host = document.getElementById('fixture')
  let count = 0, mutationCaught = false
  for (const entry of cases) {
    host.innerHTML = entry.html
    const panel = host.querySelector('.font-list-panel'), node = host.querySelector('[data-virtual-layout="cards"]')
    panel.style.width = entry.width + 'px'; panel.style.height = '620px'
    // The input contract is clientWidth, excluding the platform scrollbar.
    panel.style.width = entry.width + (entry.width - node.clientWidth) + 'px'
    close(node.clientWidth, entry.width, entry.label + ': client width')
    node.style.height = '520px'
    node.scrollTop = entry.scrollTop
    await frame(); await frame()
    const cards = [...node.querySelectorAll('.font-card')], layout = entry.layout, virtual = entry.virtual
    const label = entry.label + '/window=' + innerWidth
    if (!cards.length) { close(node.querySelector('.font-virtual-inner').getBoundingClientRect().height, Math.max(520, virtual.totalHeight), label + ': empty height'); count++; continue }
    const boxes = cards.map(card => card.getBoundingClientRect()), scroller = node.getBoundingClientRect()
    close(boxes[0].top - scroller.top + node.scrollTop, virtual.top, label + ': page offset')
    const pageWidth = node.clientWidth - layout.panelPadding * 2
    const cardWidth = (pageWidth - (layout.columns - 1) * layout.rowGap) / layout.columns
    const firstColumn = virtual.startIndex % layout.columns
    close(boxes[0].left - scroller.left, layout.panelPadding + firstColumn * (cardWidth + layout.rowGap), label + ': first column')
    for (let i = 0; i < cards.length; i++) {
      close(boxes[i].height, layout.cardHeight, label + ': card height')
      const row = Math.floor((virtual.startIndex + i) / layout.columns) - Math.floor(virtual.startIndex / layout.columns)
      close(boxes[i].top - boxes[0].top, row * layout.rowHeight, label + ': DOM row stride')
    }
    const index = boxes.findIndex(box => box.top >= scroller.top && box.bottom <= scroller.bottom)
    if (index >= 0) {
      const card = cards[index], box = boxes[index]
      const hits = select(new DOMRect(box.left + box.width / 2, box.top + box.height / 2, 1, 1), node)
      if (hits.length !== 1 || hits[0] !== card.dataset.fontId) throw Error(label + ': actual DOM marquee hit mismatch')
      if (layout.listLayout !== 'none') {
        const preview = card.querySelector('.font-row-preview-box').getBoundingClientRect()
        close(preview.height, layout.previewHeight, label + ': preview height')
        if (preview.top < box.top || preview.bottom > box.bottom) throw Error(label + ': preview outside card')
        if (layout.listLayout === 'stacked') {
          const info = card.querySelector('.font-row-name-simple').getBoundingClientRect()
          if (info.bottom > preview.top) throw Error(label + ': info/preview overlap')
        }
      }
    }
    if (entry.scrollTop === 1e9) {
      close(boxes.at(-1).bottom + node.scrollTop - scroller.top + layout.panelPadding, virtual.totalHeight, label + ': last card/bottom padding')
      close(node.scrollTop, node.scrollHeight - node.clientHeight, label + ': bottom reachable')
    }
    if (!mutationCaught && layout.listLayout === 'wide' && cards.length > 1) {
      // Reintroduce the old bug: CSS card height equals the virtual row stride,
      // while the external gap remains. The same measured invariant must fail.
      cards.forEach(card => { card.style.setProperty('height', layout.rowHeight + 'px', 'important'); card.style.setProperty('min-height', layout.rowHeight + 'px', 'important') })
      try { close(cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().top, layout.rowHeight, 'legacy gap mutant') }
      catch { mutationCaught = true }
      if (!mutationCaught) throw Error('Legacy gap mutant escaped real DOM gate')
    }
    count++
  }
  if (!mutationCaught) throw Error('No legacy gap mutation scenario executed')
  host.innerHTML = family.html
  const panel = host.querySelector('.font-list-panel')
  panel.style.width = '900px'; panel.style.height = '620px'
  await frame(); await frame()
  const measureFamily = () => [...host.querySelectorAll('.font-card, .font-row-preview-box')].map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })
  const current = measureFamily(), style = document.querySelector('style'), currentCss = style.textContent
  style.textContent = familyBaselineCss
  await frame(); await frame()
  const baseline = measureFamily()
  if (current.length !== 4 || baseline.length !== current.length) throw Error('Family regression fixture missing cards')
  current.forEach((rect, i) => rect.forEach((value, j) => close(value, baseline[i][j], `family baseline rect ${i}/${j}`)))
  style.textContent = currentCss
  const blankLineHeights = []
  for (const entry of samples) {
    host.innerHTML = entry.html
    const panel = host.querySelector('.font-list-panel')
    panel.style.width = '900px'; panel.style.height = '620px'
    await frame()
    const lines = [...host.querySelectorAll('.font-card .font-sample-line')]
    if (JSON.stringify(lines.map(line => line.textContent)) !== JSON.stringify(entry.lines)) throw Error('Sample DOM text changed: ' + entry.label)
    for (const line of lines) {
      if (getComputedStyle(line).whiteSpace !== 'pre') throw Error('Sample whitespace collapsed: ' + entry.label)
      if (!line.textContent) {
        const actual = line.getBoundingClientRect().height, expected = parseFloat(getComputedStyle(line).lineHeight)
        blankLineHeights.push({actual, expected})
        // DOM geometry is quantized; computed CSS can retain more decimals.
        // This still rejects a collapsed line and any material height loss.
        if (actual + 1 / 64 < expected) throw Error(`Explicit blank line lost its height: ${entry.label}; actual=${actual}, expected=${expected}`)
      }
    }
    if (lines.length === 2 && lines[1].getBoundingClientRect().top <= lines[0].getBoundingClientRect().top) throw Error('Explicit lines overlap: ' + entry.label)
  }
  return { count, sampleCases: samples.length, blankLineHeights, familyBaselineMatched: true, viewport: innerWidth, legacyGapMutantCaught: mutationCaught }
}
