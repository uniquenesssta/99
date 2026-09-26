import { useEffect, useState } from 'react'
import type { AppSidebarProps } from './AppSidebarTypes'

type AppSidebarDeveloperPageProps = Pick<
  AppSidebarProps,
  | 'refreshDeveloperStatusDetails'
  | 'setDeveloperStatusLog'
>

export function AppSidebarDeveloperPage({ refreshDeveloperStatusDetails, setDeveloperStatusLog }: AppSidebarDeveloperPageProps): JSX.Element {
  const [backend, setBackend] = useState('读取中')
  useEffect(() => { let active = true; void window.hfm.getPreviewBackend().then(value => { if (active) setBackend(value === 'directwrite-resident' ? 'DirectWrite 常驻试用' : '当前默认') }); return () => { active = false } }, [])
  return (
    <div className="sidebar-page">
      <div className="section-title">开发者状态</div>
      <div className="filter-note">预览后端：{backend}。未安装字体的列表与详情参与试用；已安装字体保持原路径。</div>
      <div className="filter-note">关闭程序后运行 npm run dev:dw 开始试用；运行 npm run dev 恢复默认。</div>
      <button className="clear-filter-button" onClick={() => void refreshDeveloperStatusDetails()}>刷新详细信息</button>
      <button className="clear-filter-button" onClick={() => setDeveloperStatusLog([])}>清空本页日志</button>
      <div className="filter-note">仅开发环境显示。封包生产版会自动隐藏这个页面和底部状态栏。</div>
    </div>
  )
}
