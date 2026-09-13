# HanFontManager Stage 6：React 根组件拆分任务书

## 0. 状态与边界

- 版本：1.0；日期：2026-09-13；软件：HanFontManager 3.0.0。
- 分支：`stage/06-react-composition`；基线为 Stage 5 修复提交 `1e129e2d5360d9f5f9afbba0336d73ff1eb9555a`，树 `5c285b64c91f13c737a5bfcf3034c45c0bc08ef1`。
- 用户明确要求开始 6.1，因此按大阶段创建新分支。本项不修改 Stage 5 或 main。Stage 5 修复版 Windows 实际退出证据仍待补，不把进入本阶段视为补齐旧验收。
- AT-6.1 实现及自动验证完成：typecheck、85/85 诊断、三端构建与混淆通过。AT-6.2–6.5 未开始。上级顺序以[总任务书](HFM_REMEDIATION_MASTER_TASKBOOK.md)为准。

## 1. AT-6.1 二次审计

旧 `AppRootView(props: any)` 接收 169 个平铺属性。问题不仅是根参数：AppSidebarTypes、FontListPanelTypes 和 AppOverlays 的直接参数也含 any，侧栏筛选回调用 any[] 绕过数组元素类型。只替换根参数名无法满足强类型边界。

本项保留所有 state/ref/effect 的原有所有者与顺序，仅重组视图输入，补齐直接组件边界；不提取控制器、不移动业务函数、不改 CSS/布局/事件行为，也不升级依赖。

## 2. 六组输入与实际组件映射

`AppRootViewProps` 使用 React `ComponentProps` 复用子组件类型，配合 Pick/Omit 形成边界，不复制全套声明，不引入运行时类型模块。

| 分组 | 字段数 | 实际落点 |
| --- | --- | --- |
| topbar | 9 | AppTopbar |
| sidebar | 63 | AppSidebar；折叠值和 setter 仍由 AppLayout 的 renderSidebar 提供 |
| content | 35 | FontListPanel 的浏览、选择、布局和操作参数 |
| detail | 30 | FontDetailPanel；visible 同时控制原 AppLayout 详情布局 |
| overlays | 30 | AppOverlays 的菜单、重命名、删除、目录、框选和租约提示 |
| developer | 12 | FontListPanel 的开发诊断参数，以及原开发态 footer |

179 个分组字段包含原本在不同子组件复用的值和别名展开，不代表新增 10 份状态。共享回调和 library 引用仍来自原 App；子组件按原属性逐项接收自己的参数，没有把根 props 整包下传。开发页没有新增 eager import，原生产显示条件保留。

修正的类型复用既有 SidebarPage、ActiveFilter、FontFormat、FontScript、LibraryState、PageToolbarState、VirtualLayout、MenuTarget、EditableMenuTarget、SelectionRectState 等。诊断载荷原本是 unknown 的部分继续保持 unknown；不把未知结果伪装成已验证的具体结构。

SCRIPT_LANGUAGE_ORDER 补充 FontScript[] 类型，筛选回调恢复上下文推导。最初编译器指出过滤组为 Partial<Record<FilterGroupId,true>>、目录菜单只接收 folder target；按实际领域模型修正，没有扩大为 any 或增加断言绕过。删除 App 中六个失去用途的视图组件 import。

## 3. 验证方案与证据

新增 `diagnostics:app-root-view-contracts`：

- 以 Stage 5 基线实际 App 调用和 AppRootView 生成固定 UI 接线摘要，覆盖开发/生产与侧栏展开/收起四种组合。执行当前真实根视图和从 App 提取的真实 JSX 调用，比较全部子组件属性、布局、footer 条件及 renderSidebar 回调接线。
- 反例将 search 错接为 status，必须被冻结摘要检出；CRLF 源码重放同样通过。不重录基线来适配新实现。
- 真实 strict TypeScript 程序验证六组各三类错误：缺少必填字段、字段错名、错误值类型，共 18 个编译拒绝；若错误未被拒绝，@ts-expect-error 自身使门禁失败。
- 根视图及直接侧栏/列表/弹层契约不得重新出现 AnyKeyword；App 入口只能传六组命名属性。
- 原 orchestration 门禁不再要求维持 Stage 0 的 any 缺口，改为验收已计划的六组边界；原 fixture 的目标组件、必需属性、10 条 UI 流程及 Rust/主进程契约不变。

独立编译对比确认五个支持模块（AppOverlays、AppSidebarFilterPage、AppSidebarTypes、FontListPanelTypes、filterConstants）的 JavaScript 与基线相同；变更只影响类型或被擦除的标注。根视图与 App 的接线由冻结渲染摘要验证。

本项测试是组件组合/类型验证，不冒充 Windows GUI 点击、拖放、性能或真实字体渲染测试。分组对象仍每次 render 创建；不在 6.1 盲目增加 memo，返回对象稳定性留给 6.5 结合实际消费验证。

`npm --offline run verify` 退出码 0，typecheck 与 **85/85** 诊断通过。Electron/Vite main、preload、renderer **354/1/181** 个模块构建通过，renderer JS **389.88 kB**，CSS **106.02 kB**，混淆 **3/3**。required Rust 构建实际尝试后因缺 Cargo 阻塞；没有将本环境分步构建描述为完整 Windows build。

## 4. 后续 Atomic Task

- AT-6.2：先只读派生，再 Browse 最小状态；保持 deferred search、分页、家族视图、虚拟布局与滚动恢复。
- AT-6.3：Selection、Folder、Preview 各自拥有最小状态/ref；跨域只传窄命令，保留竞态序号。
- AT-6.4：Operations、Library、Developer；写队列、autosave、关闭 flush 与数据库刷新保持唯一所有者。
- AT-6.5：测量对象稳定性、重复渲染与虚拟滚动；按数据优化，不以文件行数或 memo 数量验收。

每个 AT 独立提交，整个 Stage 6 沿用新阶段分支。当前没有提前开始 6.2。

## 5. 拉取与实机验收

```bat
git status --short
git fetch origin
git switch stage/06-react-composition
git pull --ff-only origin stage/06-react-composition
npm run build
```

无需依赖升级或数据迁移。若本地修改阻止切换，保留修改并按实际冲突处理，不执行 hard reset/clean。构建后检查顶栏主题/缓存菜单、侧栏折叠与组合筛选、列表/网格/家族视图、详情标签、菜单/弹层，以及关闭软件后 worker 是否残留。构建回执与 GUI 回执分开记录。

Context7 查询 React 18 类型文档，并以本地 React 18.3.1、@types/react 18.3.18、TypeScript 5.9.3 实际编译验证。Mermaid Chart 已呈现真实六组边界；Create State 保存交接，Git/README/任务书仍为权威记录。
