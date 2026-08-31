import { APP_VERSION } from '../../appRuntime'

type AppTopbarProps = {
  themeMode: 'dark' | 'light'
  setThemeMode: (updater: (mode: 'dark' | 'light') => 'dark' | 'light') => void
  indexingActive: boolean
  cacheMenuOpen: boolean
  setCacheMenuOpen: (updater: boolean | ((open: boolean) => boolean)) => void
  rescan: () => Promise<void>
  cancelIndexing: () => Promise<void>
  rebuildScanCache: () => Promise<void>
  clearAllCacheAction: () => Promise<void>
}

export function AppTopbar({
  themeMode,
  setThemeMode,
  indexingActive,
  cacheMenuOpen,
  setCacheMenuOpen,
  rescan,
  cancelIndexing,
  rebuildScanCache,
  clearAllCacheAction
}: AppTopbarProps): JSX.Element {
  const minimizeWindow = (): void => {
    void window.hfm.windowMinimize()
  }

  const toggleMaximizeWindow = (): void => {
    void window.hfm.windowToggleMaximize()
  }

  const closeWindow = (): void => {
    void window.hfm.windowClose()
  }

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">字</div>
        <div className="brand-copy">
          <div className="brand">汉字字体工作台 <span>v{APP_VERSION}</span></div>
          <div className="subtitle">本地字体资产管理 · 共享索引 · 文件夹监听 · 安装 / 临时激活 / 标签整理</div>
        </div>
      </div>

      <div className="topbar-right">
        <div className="actions">
          <div className={indexingActive ? 'index-status-chip busy' : 'index-status-chip'}>
            <span className="index-status-dot" aria-hidden="true" />
            {indexingActive ? '索引运行中' : '索引就绪'}
          </div>
          <button className="theme-toggle-button" onClick={() => setThemeMode((mode) => mode === 'dark' ? 'light' : 'dark')}>{themeMode === 'dark' ? '浅色界面' : '深色界面'}</button>
          <div className="cache-menu-wrap cache-split" data-no-marquee>
            <button className="cache-primary-button" onClick={() => void rescan()} disabled={indexingActive}>更新索引</button>
            {indexingActive && <button className="cache-primary-button" onClick={() => void cancelIndexing()}>取消索引</button>}
            <button className="cache-more-button" title="更多索引选项" onClick={() => setCacheMenuOpen((open) => !open)}>▾</button>
            {cacheMenuOpen && (
              <div className="cache-menu">
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => { setCacheMenuOpen(false); void rebuildScanCache() }}>重建索引</button>
                <button onMouseDown={(event) => event.preventDefault()} onClick={() => { setCacheMenuOpen(false); void clearAllCacheAction() }}>清理缓存</button>
              </div>
            )}
          </div>
        </div>
        <div className="window-controls" aria-label="窗口控制">
          <button className="window-control window-minimize" type="button" title="最小化" aria-label="最小化" onClick={minimizeWindow} />
          <button className="window-control window-maximize" type="button" title="最大化 / 还原" aria-label="最大化 / 还原" onClick={toggleMaximizeWindow} />
          <button className="window-control window-close" type="button" title="关闭" aria-label="关闭" onClick={closeWindow} />
        </div>
      </div>
    </header>
  )
}
