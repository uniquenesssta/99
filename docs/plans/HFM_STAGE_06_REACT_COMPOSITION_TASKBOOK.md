# HanFontManager Stage 6：React 根组件拆分任务书

## 0. 状态与边界

- 版本：1.4；日期：2026-09-15；软件：HanFontManager 3.0.0。
- 分支：`stage/06-react-composition`；基线为 Stage 5 修复提交 `1e129e2d5360d9f5f9afbba0336d73ff1eb9555a`，树 `5c285b64c91f13c737a5bfcf3034c45c0bc08ef1`。
- 用户明确要求开始 6.1，因此按大阶段创建新分支。本项不修改 Stage 5 或 main。Stage 5 修复版 Windows 实际退出证据仍待补，不把进入本阶段视为补齐旧验收。
- AT-6.1 已完成自动验证，并收到用户 Windows 完整构建回执：85/85 诊断、Cargo 1.97.1 release、Electron/Vite 354/1/181 模块及混淆 3/3 通过；GUI 与实际退出观察仍单列。
- AT-6.2 已在 `f3ed225bcb3981950f0df900e8c269d0229fa251`（树 `d9825b4d9af48985fc65c357d11d2e3106f4aed2`）上实现；用户在 Windows 拉取后完成 86/86 诊断、Cargo 1.97.1 release、Electron/Vite 354/1/183 模块及混淆 3/3 的完整构建。
- AT-6.3 已在 `2d43d14` 基线上实现并完成自动验证。Windows 首轮复验正确拦截的冻结哈希录入错误已修正；用户随后完成 87/87 诊断、Cargo 1.97.1 release、Electron/Vite 354/1/186 模块及混淆 3/3 的完整构建。GUI 回执仍单列。
- AT-6.4 已在 `8425146` 基线上实现并完成自动验证；Windows 完整构建与 GUI 复验待 pull 后补齐。AT-6.5 未开始。上级顺序以[总任务书](HFM_REMEDIATION_MASTER_TASKBOOK.md)为准。

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

## 4. AT-6.2 Browse 状态所有权与只读派生

### 4.1 审计结论与拆分边界

本项按所有权拆分，而不是把所有浏览相关代码机械塞入一个 God Hook。`useBrowseController` 独占用户直接修改、并且必须跨 render 保持的浏览状态与引用；`useBrowseDerivedRuntime` 只做无副作用派生。已有数据库分页运行时、family 分组运行时、虚拟布局/预览/选择组合继续留在其原所有者，避免形成第二套查询状态或改变 effect 时序。

| 所有者 | 本项拥有内容 | 明确保留在原处的边界 |
| --- | --- | --- |
| `useBrowseController` | 16 个 state 槽：侧栏、逐页 toolbar、组合筛选、标签/目录选择、分页结果/失败键/指标、viewport；7 个 ref：分页/指标请求序号、滚动容器/RAF/追踪时间、最新可见字体与布局 | 不发 IPC、不拥有 effect、不读取整个 library |
| `useBrowseDerivedRuntime` | 字体索引、指标回退、本地/共享标签计数与列表、目录扁平化、高级筛选计数、可见字体；共 9 个只读结果 | 不拥有 state/ref/effect，不触发预览或选择写入 |
| `useRendererDatabasePageRuntime` | 原数据库查询参数、分页请求和竞态序号消费 | 不复制进 Browse，继续是分页副作用唯一所有者 |
| `useFontFamilyGroupsRuntime` | 原 family 查询/结果时序 | 不并入 BrowseController，防止查询所有权重叠 |
| `useAppFontDerivedRuntime` | 最新可见列表/布局 ref 的 layout effect、虚拟布局、预览预取、详情和选择派生 | 本项不改变 preview/selection effect 顺序 |
| `App.tsx` | 以原顺序组合 deferred search、滚动恢复/重置、分页、family、Browse 派生与视图 | 不引入全局 store，不改变渲染结构 |

因此，本次得到的是可继续拆分的稳定边界，而不是声称一次就把 `App.tsx` “完美拆空”。`App.tsx` 由 1413 行降至 1406 行并非验收指标；真正结果是 16 个状态槽、7 个引用和 9 个只读派生有了单一所有者。Selection、Folder、Preview、Operations、Library、Developer 仍严格留给后续 AT。

### 4.2 行为保持与长期门禁

新增 `diagnostics:browse-controller` 并纳入 `diagnostics:all`：

- 从 AT-6.1 不可变基线冻结 16 个 state 和 7 个 ref 的初始化 token，拒绝重复所有者或默认值漂移。
- 冻结 `useDeferredValue`、数据库分页、family、滚动快照/重置/viewport 与 shell 派生调用及顺序；只读派生的函数体、memo 依赖，以及预览/选择/布局的剩余函数体也逐段冻结。
- 使用真实 Browse Controller、逐页 toolbar 和筛选运行时，验证页面间搜索/视图/排序隔离、组合筛选、展开状态、清空筛选不清空搜索、分页状态与滚动 ref 跨 render 保持。
- 明确拒绝 viewport 默认高度漂移和 deferred search 错接两种变异；LF/CRLF 均通过。
- wrapper 到只读派生只允许 19 项逐名显式端口，拒绝整包下传、计算型端口和同类型错接。

现有 `tag-consistency` 只把原断言定位更新到新的只读派生所有者，断言语义未放宽。没有升级依赖、修改数据库结构、原生协议、CSS 或视图 JSX。

### 4.3 自动验证结果

- `node build/diagnostics/check-browse-controller.cjs`：16 states/7 refs、逐页 toolbar/filters、查询/滚动/deferred 调用基线、派生/预览/选择函数体、两项变异与 CRLF 全部通过。
- `npm --offline run verify`：退出码 0；typecheck 与 **86/86** 长期诊断通过。
- Electron/Vite main、preload、renderer **354/1/183** 个模块构建通过；main **1148.87 kB**，renderer JS **392.89 kB**、CSS **106.02 kB**；混淆 **3/3** 通过。renderer 比 6.1 增加的两个模块就是本项新增的 Browse Controller 与只读派生模块。
- required Rust 构建已实际尝试，但当前审查环境没有 Cargo，明确保持为环境阻塞。本项未改 Rust 源码；不得把分步 Electron 构建描述为本项 Windows 完整 build。
- 6.1 的 Windows 构建回执不能替代 6.2 的 pull 后复验；6.2 GUI 搜索、筛选、排序、列表/网格/family 与滚动位置仍待用户实机确认。

## 5. AT-6.3 Selection、Folder 与 Preview 控制器

### 5.1 状态所有权与协作端口

本项把三组会跨 render 保持、且已经存在明确领域归属的状态/ref 从 `App.tsx` 移入控制器。没有把 effect、数据库分页或字体写操作一起吞进新的 God Hook；`App.tsx` 仍只按原顺序组合既有运行时，并在删除事件处协调两个窄清理命令。

| 所有者 | 独占状态/ref | 对外边界 |
| --- | --- | --- |
| `useSelectionController` | 14 个 state、3 个 ref：当前/批量选择、锚点、框选、详情显示与点击锁、待显示详情、标签/共享输入、菜单及重命名/删除目标 | 选择/详情只读模型、原交互运行时工厂、按字体 ID 清理命令 |
| `useFolderController` | 5 个 state、1 个 ref：展开、新建/子目录目标、拖放字体/悬停目录、自动刷新计时器 | 目录模型、原目录运行时工厂、清理刷新计时器命令 |
| `usePreviewController` | 4 个 state、13 个 ref：family/native/detail 结果、失败集合、详情竞态序号、可见/自动队列、任务集合、滚动暂停/恢复 | 预览只读模型、滚动开始/清理和按字体 ID 清理命令；可变队列不向 App 暴露 |
| `App.tsx` | 组合三个控制器与既有 effect/runtime | 删除字体时只协调 Selection/Preview 清理；目录删除额外协调原 lazy-install 队列 |

`selectedFolderId` 继续由 Browse Controller 独占，因为它同时是当前页面筛选输入；Folder Controller 只接收该只读值和既有 setter。数据库分页只得到 `fontListScrollingRef` 的只读类型；滚动运行时只能调用 `beginFontListScroll`，卸载 effect 只能调用计时器清理命令。目录和索引事件不再拿到 Preview 的 queue/set/ref。

选择运行时仍先执行字体 hydration，再分派单击、Ctrl/Shift、框选或详情动作；详情预览的 request sequence、token、scroll idle 延迟和队列调度算法均保持原函数体与顺序。目录拖放仍复用原 `parseFontDragData` 与 `createFontFolderTreeRuntime`。

### 5.2 行为锁与自动验证

新增 `diagnostics:react-composition-controllers` 并纳入 `diagnostics:all`：

- 从 AT-6.2 提交 `2d43d1451ef2c39fba6b1ecc339da43f0177c0f8` 冻结 40 个初始化槽，验证拆分后 App 为 0、Selection/Folder/Preview 分别为 17/6/17，且不存在重复所有者或默认值漂移。
- 运行真实选择交互，覆盖单击、Ctrl/Shift 多选、框选、双击详情和移除清理；验证 hydration 发生在交互分派前。
- 运行真实目录拖放数据解析和目录删除清理端口；验证 Preview 清理、滚动暂停/恢复、request token 与失败集合行为。
- 冻结 selection/detail race、preview queue/scheduler 及目录关键方法；拒绝可变 preview 队列泄漏、错误清理接线等两项变异，LF/CRLF 均通过。
- 既有 Browse 调用哈希、AppRootView 接线、预览调度、物理目录和关闭 flush 门禁保持原断言并继续通过。

验证结果：

- `npm --offline run verify`：退出码 0；typecheck 与 **87/87** 长期诊断通过。
- Electron/Vite main、preload、renderer **354/1/186** 个模块构建通过；main **1148.87 kB**，renderer JS **393.76 kB**、CSS **106.02 kB**；混淆 **3/3** 通过。新增的三个 renderer 模块就是三个控制器。
- required Rust 构建已实际尝试，但当前审查环境没有 Cargo；本项未改 Rust/原生源码，仍需 Windows pull 后执行完整 `npm run build`，不得用 Electron 分步构建替代该结论。
- `App.tsx` 从 AT-6.2 的 1406 行降至 1346 行；行数不是门禁，验收依据仍是 40 个状态/ref 的单一所有权、窄端口和行为锁。

### 5.3 Windows 首轮复验修正

Windows 在 `diagnostics:react-composition-controllers` 正确报告 `fontPreviewLoadRuntime.ts` 的冻结哈希不一致。复核确认该生产文件与 AT-6.2 基线完全一致，失败来自 AT-6.3 远端提交重建时录入了错误的 fixture 值；使用诊断自身导出的 TypeScript token 哈希函数对基线和当前文件分别重算，二者均为 `349dc568ee3957b5871fce7d76e4536ed62eff9c6a8f93b44f024441cc1ea7ef`。本次只更正这一冻结证据，不重录行为、不修改生产代码，也不放宽断言。

本项没有升级依赖，没有修改数据库结构、IPC channel、原生协议、CSS、视图 JSX 或用户数据。

## 6. AT-6.4 Operations、Library 与 Developer 控制器

### 6.1 状态所有权与窄协作端口

本项把剩余具有明确领域归属的 42 个 state/ref 从 `App.tsx` 移入三个控制器，保持已有 Selection、Folder、Preview、Browse 和视图接线不变。三个控制器仍组合原有小型 runtime；没有复制写队列、数据库刷新或开发诊断实现，也没有引入全局 store。

| 所有者 | 独占状态/ref | 对外边界 |
| --- | --- | --- |
| `useLibraryController` | 6 个 state、5 个 ref：library/status、租约冲突、索引状态、数据库刷新 token/cache，以及刷新计时器、初始化/loaded、共享元数据同步与限频 | library 持久化命令、数据库刷新命令、只读 `libraryLoadedRef`；刷新计时器只通过清理命令提供给关闭流程 |
| `useFontOperationsController` | 3 个 state、19 个 ref：cache/tag 输入、字体写队列与重试、lazy install/status、批量操作集合、renderer 活跃窗口、索引 run id、自动安装状态刷新 | 系统/安装/索引/写队列动作与字体删除清理命令；所有可变队列和集合保持私有 |
| `useDeveloperController` | 8 个 state、1 个 ref：诊断日志、索引/后台事件、架构/调度/迁移/共享元数据/任务结果，以及刷新中的 Promise | 开发视图模型、追加日志和刷新命令；生产态在任何 IPC 或日志写入前短路 |
| `App.tsx` | 不再直接声明 AT-6.4 的 state/ref | 依次组合 Browse、Folder、Selection、Library、Preview、Operations、Developer，并只传逐名端口 |

Library Controller 继续独占 autosave、初始 shell、前台共享元数据检查和数据库派生刷新。Operations Controller 组合原字体写、系统操作、安装状态、索引、用户活跃和关闭运行时；写成功仍通过 Library 的 `scheduleDatabaseDerivedStateRefresh` 窄命令失效数据库派生，删除目录中的字体仍通过单一清理命令移除 lazy install 状态。

关闭路径保持原严格顺序：清除写计时器、清除数据库刷新计时器、清除预览/滚动计时器、flush 字体写队列、flush library 持久化，最后才发送关闭完成确认。关闭运行时不再接收 Library 的可变 timer ref。`libraryLoadedRef` 只以 readonly 端口交给数据库分页运行时。

### 6.2 行为锁与自动验证

新增 `diagnostics:react-composition-domain-controllers` 并纳入 `diagnostics:all`：

- 从不可变 AT-6.3 基线 `8425146728f37ee8d0c270b947fcad9c10239236` 冻结 42 个初始化槽，验证 App 为 0、Library/Operations/Developer 分别为 11/22/9，拒绝重复所有者或初始化漂移。
- 冻结 autosave、数据库刷新、共享元数据、字体写、系统操作、安装状态、索引与开发诊断的既有函数体和组合顺序；验证写成功调用 Library 刷新端口。
- 运行真实 Library 刷新/计时器/租约提示、Operations 删除保护与 lazy install 清理、共享安装状态 refs，以及关闭 flush/确认顺序。
- 运行 Developer 生产禁用、日志去重和并发刷新行为；拒绝 raw ref 泄漏、错误关闭次序和生产态 eager 诊断三项变异，LF/CRLF 均通过。
- 更新三项既有诊断的源码所有者定位；原持久化顺序、关闭 flush 和租约提示断言未放宽。

验证结果：

- `npm --offline run verify`：退出码 0；typecheck 与 **88/88** 长期诊断通过。
- Electron/Vite main、preload、renderer **354/1/190** 个模块构建通过；main **1148.87 kB**，renderer JS **399.69 kB**、CSS **106.02 kB**；混淆 **3/3** 通过。
- required Rust 构建已实际尝试，但当前审查环境没有 Cargo；本项未改 Rust/原生源码，仍需 Windows pull 后执行完整 `npm run build`，不得用 Electron 分步构建替代该结论。
- `App.tsx` 从 AT-6.3 的 1346 行降至 1062 行；行数不是门禁，验收依据是 42 个状态/ref 的单一所有权、窄端口与生命周期行为锁。

本项没有升级依赖，没有修改数据库结构、IPC channel、原生协议、CSS、视图 JSX 或用户数据。

## 7. 后续 Atomic Task

- AT-6.5：测量对象稳定性、重复渲染与虚拟滚动；按数据优化，不以文件行数或 memo 数量验收。

每个 AT 独立提交，整个 Stage 6 沿用当前阶段分支。当前没有提前开始 6.5。

## 8. 拉取与实机验收

```bat
git status --short
git fetch origin
git switch stage/06-react-composition
git pull --ff-only origin stage/06-react-composition
npm run build
```

无需依赖升级或数据迁移。若本地修改阻止切换，保留修改并按实际冲突处理，不执行 hard reset/clean。构建后重点回归标签/收藏/删除保护写入、批量安装/卸载/激活/停用/删除、添加目录/重扫/清缓存、共享标签冲突提示，以及关闭窗口后重新打开的持久化状态；同时确认选择、目录、预览、搜索/筛选/排序、列表/网格/family 与开发页未变。构建回执与 GUI 回执分开记录。

AT-6.4 未引入新依赖或版本敏感 API，因此不重复查询 Context7；本地 React 18.3.1、@types/react 18.3.18、TypeScript 5.9.3 已实际编译验证。Mermaid Chart 更新为 Library/Operations/Developer 的真实所有权、刷新端口与关闭链；Create State 保存交接，Git/README/任务书仍为权威记录。
