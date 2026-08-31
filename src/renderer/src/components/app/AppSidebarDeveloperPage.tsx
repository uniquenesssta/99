import type { AppSidebarProps } from './AppSidebarTypes'

type AppSidebarDeveloperPageProps = Pick<
  AppSidebarProps,
  | 'refreshDeveloperStatusDetails'
  | 'setDeveloperStatusLog'
>

export function AppSidebarDeveloperPage({ refreshDeveloperStatusDetails, setDeveloperStatusLog }: AppSidebarDeveloperPageProps): JSX.Element {
  return (
    <div className="sidebar-page">
      <div className="section-title">开发者状态</div>
      <button className="clear-filter-button" onClick={() => void refreshDeveloperStatusDetails()}>刷新详细信息</button>
      <button className="clear-filter-button" onClick={() => setDeveloperStatusLog([])}>清空本页日志</button>
      <div className="filter-note">仅开发环境显示。封包生产版会自动隐藏这个页面和底部状态栏。</div>
    </div>
  )
}
