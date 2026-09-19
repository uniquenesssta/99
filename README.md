# HanFontManager

HanFontManager（汉字字体工作台）是面向 Windows 的本地字体管理器。项目使用 Electron、React 与 TypeScript 构建桌面界面，并通过 Rust/C/C++ 原生组件处理字体扫描、预览、安装与系统集成。

## 主要能力

- 扫描、检索和管理本地字体库
- 字体预览、缓存与批量操作
- 字体安装、激活、停用和回收站删除
- 文件夹、标签、收藏及删除保护
- NAS/共享字体库、共享标签与索引维护
- 本地 SQLite 数据与原生 Windows 字体能力

## 开发环境

- Windows 10/11 x64
- Node.js 22.12 或更高兼容版本
- Rust 与 Cargo（构建 `hfm-core-worker` 时需要）
- Windows 原生组件对应的 C/C++ 构建工具链

```bash
npm ci
npm run setup:dev
npm run dev
```

## 验证与构建

```bash
npm run verify
npm run build
npm run build:win
```

`npm run verify` 会执行 TypeScript 类型检查和项目诊断。正式打包还需要本机私钥；配置方式见 [`build/security/README.md`](build/security/README.md)。

## 目录说明

- `src/main`：Electron 主进程、IPC、索引、数据库和系统能力
- `src/preload`：安全暴露给渲染进程的 API
- `src/renderer`：React 用户界面
- `native-src`：Rust/C/C++ 原生组件源码
- `build`：诊断、构建、打包与安全脚本

## 当前工程任务

- [操作一致性与刷新优化任务书（U-00～U-08 代码已实施，实机待验；U-08 性能测量未结案，U-09 待实施）](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md)

- [预览缓存、本地标签与 App 专项拆分任务书（规划，未实施）](docs/plans/HFM_PREVIEW_TAG_APP_DECOMPOSITION_TASKBOOK.md)

- [修复与编排重构总任务书](docs/plans/HFM_REMEDIATION_MASTER_TASKBOOK.md)
- [当前 Stage 7：IPC 收口与依赖治理任务书](docs/plans/HFM_STAGE_07_IPC_SECURITY_DEPENDENCY_TASKBOOK.md)
- [Stage 5：Rust Worker 门面拆分任务书](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)
- [已完成 Stage 6：React 根组件拆分任务书](docs/plans/HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md)
- [Stage 4：主进程组合根拆分任务书](docs/plans/HFM_STAGE_04_MAIN_COMPOSITION_TASKBOOK.md)
- [已完成 Stage 3 工程验收：文件移动一致性与预览限额任务书](docs/plans/HFM_STAGE_03_FILE_PREVIEW_TASKBOOK.md)
- [已完成 Stage 2：字体路径授权任务书](docs/plans/HFM_STAGE_02_PATH_AUTHORIZATION_TASKBOOK.md)
- [已完成 Stage 1：激活与停用事务任务书](docs/plans/HFM_STAGE_01_ACTIVATION_TASKBOOK.md)
- [已完成 Stage 0：基线与行为锁任务书](docs/plans/HFM_STAGE_00_BASELINE_TASKBOOK.md)

任务书按 Atomic Task 执行：先建立行为锁，再依次修复事务正确性、路径边界和文件一致性，之后才拆分主进程组合根、Rust Worker 门面与 React 根组件。任何阶段硬门禁失败都阻塞后续阶段。

## 安全说明

仓库只应保存公钥。私钥、许可证、构建输出、日志和本地缓存均由 `.gitignore` 排除。任何曾提交到 Git 的私钥都必须立即停用并轮换；从当前分支删除文件不会清除旧提交中的内容。

## 变更记录

- 2026-09-19：修复共享根身份重复注册与健康探测误增代次：已验证 UNC 身份不会被后续无物理参数的重复注册降级，只有新确认的不同共享才触发 `identity-changed`；在线健康复检不再使并发共享读取误报 `stale-generation`，真实离线/恢复仍推进代次。补充身份降级、同共享子路径、健康复检与离线失效回归；O-07 继续暂停，实际映射盘/NAS 待复验。

- 2026-09-19：修复共享目录中早于 1970 年的文件时间导致 `treeSnapshot` 报错并把共享根误判离线的问题；Rust 共享文件端口统一按有符号 Unix 时间处理 `stat`、目录快照和过期锁判断，不再因 pre-epoch 时间中断目录监听。真实 worker 集成新增 pre-epoch `treeSnapshot`、`stat`、`removeStaleLock` 回归；Windows/Linux 原生测试与 release 构建通过。O-07 继续暂停，实际 NAS 需更新 Rust worker 后复验。

- 2026-09-19：补齐 Rust 共享文件能力握手并纳入启动兼容检查，修复共享目录误判不可用；原生预览失败增加短暂冷却，离线错误保留字体记录，避免反复请求刷错。新增真实 worker 握手/文件读取集成验证及预览冷却回归；TypeScript、139 项诊断、Windows 36/Linux 39 项原生测试、两平台 release 与 Electron/Vite 构建通过。更新后需重新构建 Rust worker，实际 NAS 待复验，O-07 继续暂停。

- 2026-09-19：修复中文共享名的映射盘监视目录添加失败：使用 Windows 本机结构化映射及编码明确的返回值，避免 `net use` 本地化输出被误解码为乱码路径；错误映射不缓存，保留异步期限与单在途。新增旧版乱码复现、Unicode/空格/别名去重及失败重试诊断；TypeScript、138 项诊断、Electron/Vite 构建及混淆通过；Windows/NAS 实际添加待复验。O-07 暂停，详见[修复记录 §24](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#24-中文映射共享路径修复o-07-暂停)。

- 2026-09-19：实现 O-06 整体有界退出：重复关闭共用 15 秒预算，人工保存确认暂停计时；退出冻结网络与新激活，保留本地保存通道，残留或清理超时不再无限阻止关闭。取消退出恢复窗口和监视，迟到复制/批次不会继续激活，最终显式终止自有执行者。TypeScript、137/137 诊断、三端构建和混淆通过；真实 Windows/NAS 退出仍待验。详见[O-06 执行卡](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#23-o-06-执行卡)，下一项 O-07。

- 2026-09-19：补齐 O-02/O-04/O-05：共享扫描、标签维护、预览及文件操作进入可终止进程；NAS 激活字体通过本机受管副本取消，本机状态结算不再访问源根；新增身份校验、分阶段恢复、残留重试及重启后清理入口。TypeScript、136/136 诊断、JS 三端构建和混淆通过；Windows/Linux 原生测试与 release 构建通过，详见[执行记录](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#22-o-02o-04o-05-完整实现接续)。实际 Windows/NAS 与重启待验，整体退出预算留在 O-06。

- 2026-09-18：O-05 接入三份本地恢复记录的严格 version 1 校验、串行更新和临时文件 flush/rename 发布；损坏、权限或磁盘异常保留旧记录。删除清理期间新增任务不会被覆盖，占用错误持久保存。TypeScript、132/132 诊断、专项 7 组及 JS 三端构建/混淆通过；手动处置、文件身份核验、分阶段恢复和 Windows 重启清理尚未完成，O-05 不标记全部通过。详见[O-05 执行卡](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#21-o-05-执行卡)。

- 2026-09-18：O-02 将共享元数据五项命令、共享安装状态读写接入有界独立进程；目录探测移出主进程，共享签名读取不再先做主进程路径检查。隔离失败及坏回执均阻断兼容回退，输入文件保留至进程真正关闭；共享标签读取失败保留已有目录。本地命令保留原通道。TypeScript、131/131 诊断及三端构建通过；旧迁移、扫描等消费者和 Windows/NAS 仍待完成，详见[接续执行记录](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#185-本次接线的实际边界与验收)。

- 2026-09-18：O-04 建立本机副本与取消激活故障基线，复现内容不符副本复用、复制半文件、回执身份缺失、取消后共享索引依赖及前置归属检查缺口；保留正常复制/本地资源移除等 4 组对照。TypeScript、130/130 观察型诊断通过；O-04 严格验收仍失败。生产实现尚未切换，O-02 隔离与原生验证环境仍阻塞完整验收。详见[O-04 执行卡](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#20-o-04-执行卡)。

- 2026-09-18：O-03 接入共享离线置灰与主进程整批准入：目录、标签和选择保留；离线共享写/源文件操作整体拒绝，本地标签、收藏、保护与取消激活入口保留。两套 preload 同步，旧能力缺失保守禁用；查询拒绝保留当前分页，不建设离线同步系统。TypeScript、129/129 诊断、定向 40 组、三端构建及混淆通过；O-02 业务隔离及 Windows/NAS 仍待完成。详见[O-03 执行卡](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#19-o-03-执行卡)。

- 2026-09-18：O-02 新增尚未接入业务的有界进程基础及真实子进程诊断：限制并发/队列、同根互斥，取消后等待 close 才释放名额，已启动且无回执的结果标为未知。TypeScript、128/128 诊断、三端构建与混淆通过。现有执行链保持 O-01；共享 SQLite legacy/replay 原生迁移因 Cargo 环境缺失、工具链下载连接超时而待继续，O-02 未完成。详见[O-02 执行卡](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#18-o-02-执行卡)。

- 2026-09-18：O-01 实现根状态/代次与共享标签按根保留：离线或读取失败保留已确认目录，在线完整空结果及显式删除仍正常生效；旧数据无归属时保守保留，迟到读回不得覆盖新状态。新增本地 meta 记录并与 tags 原子提交，映射盘可用性识别改用异步缓存入口；共享库格式、依赖及字体激活流程不变。TypeScript、127/127 诊断、三端构建与混淆通过，Windows/NAS 待验；详见[O-01 执行卡](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#17-o-01-执行卡)，O-02 未开始。

- 2026-09-18：O-00 建立共享离线与退出基线，登记 16 类消费者和句柄所有权；复现 8 项已知行为缺口，保留 5 组正常对照。TypeScript、126/126 诊断通过；观察成功不表示缺陷已修复，严格观察按预期失败。无生产代码或数据格式变更，Windows/NAS 实测待验，O-01 未开始。详见[O-00 执行卡](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md#16-o-00-执行卡)。

- 2026-09-18：新增[共享离线保留与本地字体退出清理任务书](docs/plans/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md)，规划离线目录/共享标签保留置灰、网络请求隔离、本机副本取消激活、残留处理、有界退出和重连恢复；明确不做离线共享编辑或同步。含 O-00～O-08 执行卡、28 项故障矩阵及兼容/回滚门禁；本次仅文档，功能尚未实施。

- 2026-09-18：修复本地/共享标签提交后查询仍额外等待 220ms，保留版本校验、并发重读和错误保护；共享标签冲突只统计当前版本竞争，正常顺序增删/跨电脑编辑不再误报，旧诊断计数与样本自动重算且不覆盖已确认标签。新增提交到查询专项和真实 SQLite 回放/回滚验证，TypeScript、125 项诊断、三端构建及混淆通过，Windows/NAS 实测待补；验证及退出/断网能力边界见[补充执行卡 §20](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#20-标签提交查询延迟与共享冲突误报)。

- 2026-09-18：按最新交互要求移除主界面选中字体后出现的操作栏，保留详情操作；安装/卸载、激活/取消激活、保护/取消保护、收藏/取消收藏各合并为一个随所选状态变化的按钮，字体右键同步。混合状态明确设值，继续完整目标检查、确认和失败回滚。单击选中、再次单击取消，同字体 100ms 防连击；Ctrl/Shift/框选后详情可操作，双击不再重新选回已取消字体。修正列表网格行及详情按钮布局，无存储/IPC/依赖变更；TypeScript、124 项诊断、三端构建和混淆通过，Windows 实机待验；验证与实机边界见[补充执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#19-用户补充详情状态按钮与单击选择修正)。

- 2026-09-18：U-08 缩窄字体索引和列表派生依赖，统计读回/预览文字修改不再造成无关全表重算；1499 条字体各 40 次受控更新的对应重算均由 40 次降至 0。补齐统计调度、缓存复用/失效重读、主进程读取及本机状态校正日志，保持旧结果拒绝和失败重试。新增派生/统计及真实 SQLite/PNG 缓存复用检查，预览 owner/原生生成未改；TypeScript、124/124 诊断、三端构建与混淆通过；真实 React 对照入口为 `npm run benchmark:u08`。浏览器访问本地页受限，尚无中位数/P95 或完整应用绘制实测，U-08 性能验收未结案；结果与 Windows 开发模式复验见 [U-08 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#18-u-08-执行卡)。

- 2026-09-18：U-07 修复新目录 events/hash 尚未创建导致的维护误报；与 preview/metrics 统一按 ENOENT 识别惰性库，权限、损坏、锁及 I/O 错误仍保留。启动维护先等待原 owner 初始化明确缺失的 library/tasks/kvs，Node 备用备份不再创建未使用的可选库；自动备份失败参与最终结果并保留重试资格。TypeScript、122/122 诊断（新增 78 项真实 SQLite/受控端口检查）、三端构建与混淆通过；Windows 原生故障实测待验，见[U-07 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#17-u-07-执行卡)。无依赖、数据库格式、IPC 或 Rust 变更，下一项 U-08。

- 2026-09-18：U-06 停用后的系统枚举增加代次屏障，拒绝删除前在途结果；正常批量注册表删除合并一次，失败后仅逐值重试注册表，不重复移除字体资源。临时状态匹配建立一次索引，最终复核失败不再同时计为成功；补齐前台分阶段、系统排队/读取及渲染回执应用计时，保留原后台文件清理、持久保存与永久安装核对。TypeScript、121/121 诊断（新增 74 项受控专项）、三端构建与混淆通过；Windows 同机重复耗时验收见[U-06 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#16-u-06-执行卡)。底层枚举部分来源失败的完整性协议本轮未改，仍是审计边界。无新依赖、数据库/IPC 或 Rust 变更，下一项 U-07。

- 2026-09-18：U-05 共享标签按已提交 ID 定位并复用增量索引同步，替代 set/batch/rename/delete 的无条件全根快照；目录仍完整确认，提交后读失败不重放写入。渲染刷新合并并区分页面/统计，拒绝过期通知，收藏/激活按筛选刷新；保护通知只更新字段并保留其他用户状态与预览。标签权威字段读回和未知事件的保守刷新保留。TypeScript、120/120 诊断（新增 31 项 SQLite/真实队列、控制器及通知专项）、三端构建与混淆通过，Windows 实机待验，见[U-05 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#15-u-05-执行卡)。无新依赖、数据库格式或 Rust 变更，通知新增可选字段，下一项 U-06。

- 2026-09-18：U-04 在字体库/收藏、文件夹、本地及共享标签、高级筛选页面补齐“全部状态 / 已安装 / 未安装”公共入口，按页恢复状态。SQL、主进程内存及渲染回退统一与原范围求交集，未安装排除未知及残留旧匹配记录；临时激活不算永久安装，分页/总数/缓存键同步，标签乐观补入不放宽筛选。TypeScript、119/119 诊断（新增 43 项筛选场景）、三端构建和混淆通过，Windows GUI 待验，见[U-04 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#14-u-04-执行卡)。无依赖、数据库/IPC 或 Rust 变更，下一项 U-05。

- 2026-09-18：U-03 开放操作栏、字体右键、详情的多选本机收藏/取消收藏，明确目标值并跳过未变化项；整组合并更新、计数及队列提交。失败按请求归属恢复最近已保存值，旧回执不覆盖新操作；收藏页清理取消项、补齐已加载分页并保留其他有效选择。TypeScript、118/118 诊断、新增 37 个收藏场景、三端构建与混淆通过；真实 SQLite 覆盖重启、机器隔离和事务失败。Windows 滚动/键盘实机待验，见[U-03 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#13-u-03-执行卡)。无依赖、数据库/IPC 或 Rust 变更，下一项 U-04。

- 2026-09-18：U-02 将操作栏、字体右键和详情统一为同名命令，单选/多选按明确范围执行；安装汇总结果，卸载一次确认，删除与安装等操作共用在途保护。标签按所选集合增删指定名称，保留其他字段；普通状态提示与工具栏布局合并，操作栏支持换行。保留本机单项收藏，多选收藏明确禁用并留待 U-03。TypeScript、117/117 诊断（新命令 36 项、激活入口 72 项）、三端构建与混淆通过；Windows 开发模式复验见[U-02 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#12-u-02-执行卡)。无依赖、数据库/IPC 或 Rust 变更。

- 2026-09-18：U-01 修复多选记录与分页缓存不一致导致少执行/不派发、Shift 选择被误裁剪；统一完整目标与缺项提示，保护整个选择，范围切换拒绝旧事件。标签激活/停用读取完整分页范围，保留逐项回滚与 busy 保护，普通页面显示操作结果；保护、删除和卸载入口同样拒绝静默丢项。TypeScript、116/116 诊断（含 72 个入口受控场景）、旧源码对照、三端构建及混淆通过；完整验证结果、Windows 开发模式复验和边界见[U-01 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#11-u-01-执行卡)。无依赖、数据库/IPC 或 Rust 变更；菜单统一、收藏和筛选扩展留待后续任务。

- 2026-09-18：U-00 新增激活入口关联诊断，区分多选操作栏、字体右键、标签右键、缺缓存、全部跳过、部分失败与 IPC 回执；受控复现 1400 项缓存与累计分页不一致、Shift 中间项被裁剪。保留业务行为，修复安排在 U-01；TypeScript、116/116 诊断及三端构建通过；Windows 原故障归因待新日志确认，见[U-00 执行卡](docs/plans/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md#10-u-00-执行卡)。

- 2026-09-18：新增操作一致性与刷新优化任务书，覆盖字体多选激活入口、统一单选/多选操作、多选本机收藏、跨页面安装筛选、局部刷新、停用耗时、启动维护及预览/渲染验证。区分用户确认故障、日志事实与待证原因，规定真实入口及 Windows 验收；本次仅文档规划，未实施生产修复。

- 2026-09-17：修复共享标签删除后目录残留，提交后同步完整目录并取消界面旧目录回写；停用单个/批量及启动退出清理重新核对本机安装，保留永久安装，分页、完整载入与计数拒绝旧激活状态。收藏改存本机app.sqlite，首次仅迁移已有本机快照，后续不读写共享收藏；筛选、智能排序与统计同步使用本机值，收藏操作不清空NAS缓存。新增本机收藏隔离、SQLite迁移/回滚、标签目录及异步失效回归。TypeScript与115/115诊断、Electron/Vite三端构建及混淆3/3通过。无依赖、IPC签名或Rust源码变更；本地新增收藏表，共享历史字段保留。Windows/NAS实机仍待验，见[修复执行卡](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#25-标签目录停用核对与本地收藏修复执行卡)。

- 2026-09-17：修复Windows反馈四项问题：停用成功后的待保存状态立即用于查询；单字体安装变更保留到增量索引同步；存储介质探测改为异步合并并保守限流；预览runtime跨render保留防重状态，重置/卸载拒绝旧结果并支持失败重试。TypeScript与114/114诊断、Electron/Vite构建及混淆3/3通过，新增4条真实链和8个LF/CRLF退化检查；无依赖、DB或IPC迁移。Windows视觉、冷启动/NAS耗时及Rust原生实测仍待验，详见[修复结果](docs/audits/HFM_FULL_CHAIN_AUDIT.md#windows反馈四项修复结果)。

- 2026-09-17：完成Windows反馈四项审计：确认停用后安装状态延迟可见、单字体全根同步、前台同步存储探测及预览批查状态随render重建。新增只读真实模块观察器，四条路径均复现；三项相关既有诊断通过，未改生产代码。首屏耗时分段与视觉表现仍需Windows验证，详见[专项审计](docs/audits/HFM_FULL_CHAIN_AUDIT.md#windows反馈专项审计停用同步与预览)。

- 2026-09-17：R-07全链路自动验收通过，TypeScript及113/113；原只读observer的F-01/F-02/F-03反例均不再复现。修正R-02/R-03历史Rust测试夹具缺少R-06可选字段的问题，并拒绝把编译失败当数据库反例；不改生产源码、依赖或原冻结fixture。汇总F-01～F-05、X-01～X-13证据、真实Node SQLite关联样本与Windows开发模式步骤。六个原生入口因缺Cargo未执行，Windows/NAS待验，R-07保持自动验证通过待实机，见[执行卡](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#22-r-07-执行卡)。

- 2026-09-17：R-06修复不同根目录、相同前80项但尾部不同及目录变化被误去重；Rust/Node已提交通知具有独立mutationId，完整存储域与语义摘要使daemon/worker同提交只通知一次。旧消息缺身份保守刷新，缓存上限2048项/60秒，trace不作业务身份。新增真实信号、8个客户端传输场景、Node SQLite链及10次LF/CRLF退化验收；TypeScript、112/112、三端366/1/196构建及混淆3/3通过。仅增加内部可选通知字段，无依赖、DB schema或IPC方法签名变化。Cargo缺失，Rust原生/Windows/NAS待验；sidecar需用当前源码重建，开发验收仍用npm run dev，见[R-06执行卡](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#21-r-06-执行卡)。

- 2026-09-17：R-05修复标签旧确认清除新输入、失败超过20秒丢失保护、弹窗与写队列编辑身份不一致；成功回读不会再被旧目录清空，后续外部删除仍生效。目录删除失败不再转换为逐字体解绑重试，本地/共享标签与收藏/保护保持字段隔离。新增真实交互、Node SQLite关联链和10次LF/CRLF退化验收；TypeScript、111/111、三端365/1/196构建和混淆3/3通过。无依赖或数据格式变化；Windows/NAS及前置Rust原生缺口待验，见[R-05执行卡](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#20-r-05-执行卡)。

- 2026-09-17：修复日志发现的四项问题：增量字体更新保留未加载及空目录；激活队列对照持久化安装状态，未变化时跳过写入和全根同步；未创建的可选metrics缓存不再误报维护失败，损坏/权限/I/O错误继续报告；临时激活字体有可用文件时直接走Rust文件预览，系统字体及离线名称路径保留。新增四组真实运行时回归与10个LF/CRLF退化反例，110项诊断及三端构建通过；旧目录树可通过根目录刷新恢复，Windows开发模式待复验。

- 2026-09-17：修复操作后的刷新放大：安装/未安装统计保留最后成功快照，查询失败不清空；收藏/保护纳入共享元数据增量同步，共享标签快照限目标目录，跨目录及其他签名变化继续重建；普通监听仅发布实际变化，失败恢复仍重发。新增60种索引分流与统计保留诊断，Windows需用debug日志复验；启动长等待、目录统计波动、维护缺文件仍待定位。

- 2026-09-17：修复R-04诊断在Windows CRLF下多行变异未命中导致的 Missing expected exception；统一变异输入换行并强制检查替换命中，覆盖客户端和原生反例入口，生产代码不变。

- 2026-09-16：R-04预览缓存提交完整性：Rust apply行与updatedAt同事务；apply/delete执行结果未知时不再返回null触发Node重写，成功后的日志/临时文件清理失败不改变写入结果。新增系统预览operation trace、16个客户端故障场景及独立原生SQLite/commit故障验收入口。verify 108/108、Electron/Vite 365/1/196及三个入口混淆通过；当前无Cargo，原生/Windows验收待执行，详见[链路一致性任务书](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#16-r-04-执行卡)。开发验收使用 `npm run dev`；R-05/R-06未启动。

- 2026-09-16：R-03将Rust共享元数据行、ops/events、metadata和signature纳入一致事务；删除目标/revision在锁内读取，普通只读signature保持旧兼容。修复Rust提交成功后日志异常误报失败，新增原生故障和默认门；verify 107/107、12个TS场景及三端构建通过，Rust/Windows原生仍待验。见[执行卡](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#15-r-03-执行卡)。

- 2026-09-16：R-02将Rust本地标签绑定、目录和localTagsUpdatedAt纳入同一Immediate事务，并把目录/绑定读取移入事务；新增真实worker故障测试、commit失败测试及原生旧实现/退化验收入口。默认verify 106/106；本环境无Cargo，原生编译/测试与Windows开发态仍待验，不代表问题已完整关闭。见[执行卡](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#14-r-02-执行卡)。

- 2026-09-16：R-01新增写入关联日志，贯通队列意图/重试、两种preload、IPC、Node/Rust提交证据、信号去重与页面状态应用；详细模式使用既有startup日志，新增容量限制和非干扰验收。默认verify为105/105，三端构建与混淆通过；原生故障测试已加入，Rust/Windows实机结果待验；见[修复任务书](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#13-r-01-执行卡)。

- 2026-09-16：新增[全链路一致性修复任务书](docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md)，按用户要求将关联日志R-01设为后续修复前置；规定事务、意图确认、去重与总验收7项任务及白名单/反例/原生和GUI证据约束。本轮仅规划，未开始实施。
- 2026-09-16：完成[全链路审计](docs/audits/HFM_FULL_CHAIN_AUDIT.md)，记录标签旧确认/保护到期、信号去重碰撞、Rust提交边界和跨层日志关联缺口；附只读反例观察脚本。现有104/104仍通过，新增发现尚未修复，专项继续待验收。
- 2026-09-16：D-11完成专项全量回归（TypeScript、104/104）与三门面职责审查，可达静态运行时导入图未发现循环；更新专项/总任务书状态及Windows开发模式验收清单。实现与自动验证完成，GUI及Rust定向测试待验收，专项未完整关闭。
- 2026-09-16：D-10 将App六组视图输入整理为复用AppRootViewProps的显式类型对象，保持原UI映射与生命周期；新增类型/控制器透传/计时器退化门，10k卡片引用及500项选择复核、TypeScript、104/104诊断及三端362/1/194构建通过。Windows开发模式交互待验，D-11未开始。
- 2026-09-16：D-09 提取App菜单/对话框、详情/选择组合，保留原Hook/构造顺序、七控制器所有权和六组视图接线；前向命令增加初始化保护及反例门。TypeScript、104/104诊断与三端362/1/194构建通过，Windows继续使用npm run dev复验交互，D-10未开始。
- 2026-09-16：D-08 收敛本地标签门面611→378行，提取Rust适配/回退准入与同步日志/信号协议；保持五方法契约、写异常禁止跨后端重放和修订号→缓存清理→广播顺序。103/103诊断及三端362/1/191构建通过，Windows开发模式待复验。
- 2026-09-16：D-07 提取Node本地标签持久化，原门面833→611行；绑定与目录保持同事务，保留500项读取分块及提交后同步通知顺序。真实SQLite故障回读和四个退化变异、102/102诊断及三端360/1/191构建通过，Windows开发模式待复验。
- 2026-09-16：D-07前置修复：标签提交后的生命周期日志失败不再误报写入失败或阻断状态通知；新增真实SQLite事务故障与提交后回读门。
- 2026-09-16：D-06 统一批量预览行构建，分离状态/图片策略与I/O包装；预览存储门面782→216行，保留400项分块、并发6、缺图补齐与touch时序，兼容分支本轮不删除。TypeScript、101/101诊断及三端359/1/191构建通过，Windows开发模式待复验。

- 2026-09-16：D-05 提取预览索引访问模块，集中读写删除、512项缓存与数据库句柄生命周期；原预览门面1150→782行，保留提交失效、共享失败降级与本地清理时机。TypeScript、100项诊断和三端构建通过，Windows开发模式检查待回执。

- 2026-09-16：D-04 提取预览存储路由与库快照缓存，保留唯一目录可用性实例及共享准备/本地降级顺序；四函数体保持，99项诊断及三端构建通过。D-03已收到用户构建成功回执，其他实机检查按用户安排后续进行。

- 2026-09-16：D-03 修正 Node/Rust 标签读取中共享路径或别名只匹配最后一个字体的问题，F-T1纳入默认必过；TypeScript、98项诊断和三端构建通过。Rust原生测试因本环境无Cargo待Windows执行 `npm run test:local-tag-hydration-rust`，随后开发模式复验。

- 2026-09-16：D-02 修复预览索引写入/删除后的旧缓存回填，覆盖 Rust 超时后晚完成与输出路径变更；F-P1 转默认门，97项诊断与三端构建通过，Windows开发模式复验待回执。

- 2026-09-16：A-02 去除收藏写前360ms及提交后520ms/空闲等待；修复批量停用缺项误结算，保护异步计数不覆盖新操作。补齐动作、列表、计数与重开策略自动回归；typecheck、96项诊断与三端构建通过，Windows开发模式硬验收待回执。

- 2026-09-16：将收藏跨页稳定性、激活展示一致性、旧结果晚到正式列为 A-02 必过用例，明确证据与失败停止条件；Windows 验收保持待回执。

- 修复收藏切页闪退与停用后其他列表仍显示已激活：会话操作保护、旧查询拒绝、收藏写入/回读确认与列表成员一致性；typecheck、95 项诊断、三端构建通过，Windows `npm run dev` 待复验。


- 2026-09-15：W-03a 修复监听将权限/网络/解析异常视为删除的问题；目录枚举不完整时保留原索引，只有确认目标不存在且根可访问才删除。恢复和界面合并在后续独立提交实施。

- 2026-09-15：A-01 界面修复：单项停用返回失败或抛错均恢复激活状态，结算后重查列表/计数并拒绝旧计数响应；与独立主进程修复配合，部分清理失败不再显示成功。

- 2026-09-15：A-01 主进程修复：单项停用部分/全部清理失败返回失败并保留记录，部分失败不再清空安装状态；原生异常传播和无记录幂等保持。界面修复尚待后续独立提交。

- 2026-09-15：W-02 修复旧监听启动晚到注册、离线根同请求无法重试及失效回调入队问题；同签名仅在句柄全部健康时跳过，错误句柄关闭后下次请求可恢复。93/93 诊断及三端构建通过，Windows 开发模式待复验；下一项 A-01。

- 2026-09-15：W-01 新增监听/单项停用跨层基线，四项历史故障可独立重放；锁定事件过滤、宽限期、扫描延迟、停止重启、停用成功/异常回滚和手动刷新合并。无生产修改；下一项 W-02 修复监听启动及恢复，详见专项任务书第 12 节。

- 2026-09-15：D-01 建立拆分前可执行基线，冻结三目标文件/七控制器/相关 IPC 契约，新增真实四域写队列、重试隔离和 24 种字段合并排列；全量 92/92 通过。预览缓存及重复身份 hydration 两项旧问题在独立观察命令复现，尚未修复；无生产代码变化。下一项 W-01，详见专项任务书第 11 节。

- 2026-09-15：专项任务书升至 1.2，加入目录监听生命周期与已激活展示审计，登记监听启动竞态/离线恢复、单项停用返回与界面结算问题；新增 W/A 五项任务与七组联动门禁。仍为审计规划，尚未修复上述生产行为；Stage 8 暂缓，使用开发模式验收。

- 2026-09-15：专项拆分任务书升至 1.1，补齐文件范围冻结、唯一状态所有者、跨字段隔离、异步/事务门禁、逐任务执行卡和失败暂停条件；D-01 必须落地可执行基线，后续禁止仅搬文件或放宽断言判定完成。此次仅更新实施约束，尚未开始专项代码拆分。

- 2026-09-15：修正 Electron 42 Windows 原生依赖兼容遗漏，better-sqlite3 从 12.10.0 锁定到 12.11.1；新增 `npm run setup:dev`，安装 Electron 二进制并按项目 Electron 版本准备原生依赖，不生成安装包。依赖门禁新增三个不兼容旧版本反例。Windows 重建及实际数据库读写待实机复验。

- 2026-09-15：新增预览缓存、本地标签与 App 专项拆分计划，定义 11 项原子任务、已复现问题的独立修复及标签/收藏/共享标签/保护字段联动矩阵；尚未实施代码拆分。本专项使用 `npm run dev` 验收，不要求打包安装。

- 2026-09-15：修复 AT-7.2 Windows 首轮 `build:win` 暴露的诊断反例构造问题：生产依赖、锁文件和 `electron-builder.yml` 均正确且未改，失败仅因诊断用 LF 字面串改写 CRLF 配置时没有命中。现在按 YAML 行结构构造旧 `win.publisherName` 反例，CRLF 重放先规范换行，并分别要求 LF/CRLF 反例确实发生改写且被门禁拒绝；定向诊断及 91/91 全量验证通过。用户的 Windows `npm ci` 已确认 395 个包、审计 0 漏洞；pull 本修复后需继续重跑 `npm run build:win`。

- 2026-09-15：完成 AT-7.2 依赖安全矩阵与本环境自动验证：Electron 35.7.5 -> 42.11.3、electron-builder 25.1.8 -> 26.15.3、electron-vite 3.1.0 -> 5.0.0、Vite 6.4.3 -> 7.3.6，Node engine 固定为 >=22.12；生产依赖及版本不变。完整锁图审计从 1 critical + 21 high + 1 moderate（23）收敛为 0，未使用 `npm audit fix --force`。迁移 electron-vite 默认外部化和 builder v26 的 `win.signtoolOptions.publisherName`，新增安全下限、六项变异与 CRLF 门禁；`npm ci`、typecheck、91/91 诊断、354/1/190 三端模块及混淆 3/3 通过。Linux 已验证 Windows 配置 schema 并到达原生重建边界，因不能交叉执行 Windows node-gyp 且本环境无 Cargo，pull 后须在 Windows 执行干净安装、完整构建、NSIS 打包及安装/启动/卸载烟测。详见 [Stage 7 任务书](docs/plans/HFM_STAGE_07_IPC_SECURITY_DEPENDENCY_TASKBOOK.md)。

- 2026-09-15：完成 AT-7.1 IPC 来源收口：开发与打包 renderer 统一使用解析后的 protocol/origin/host/path/query 精确身份，拒绝路径前缀、伪主机、错端口、错协议与 query 变体，仅允许同一文档的 hash 路由；原 115 项业务 IPC 与 5 个窗口 channel 均在副作用前走中央 sender validation，开发/打包导航与新窗口同样 fail closed。新增真实 URL/IPC/导航行为、全主进程注册扫描、四项变异和 CRLF 门禁；typecheck、90/90 诊断、`npm audit --omit=dev` 0 漏洞、Electron/Vite 354/1/190 模块及混淆 3/3 通过。无依赖版本、锁文件、IPC 名称、preload、数据库、CSS 或原生源码变更；本环境无 Cargo，pull 后需 Windows 完整构建。详见 [Stage 7 任务书](docs/plans/HFM_STAGE_07_IPC_SECURITY_DEPENDENCY_TASKBOOK.md)。

- 2026-09-15：完成 AT-6.5 渲染性能复核：控制器返回对象都在 App 内逐项消费，未做无效的大面积 memo；实测定位并修复卡片六个回调每次 render 重建、使既有 `FontCard.memo` 失效的热点。`useFontCardRenderer` 以 `WeakMap` 保持每字体事件身份，通过最新端口 ref 避免过期闭包；滚动重叠卡、详情开/关和 500 项批量选择只更新语义变化的卡片。新增 10,000 字体查询/虚拟滚动/选择、两项反例与 CRLF 长期门禁；typecheck、89/89 诊断、Electron/Vite 354/1/190 模块及混淆 3/3 通过。用户随后完成 Windows Cargo 1.97.1 release、同一 354/1/190 三端构建和混淆 3/3，并明确进入 Stage 7；大字体库 GUI/性能回执仍单列。无依赖、数据库、IPC、CSS 或原生源码变更。详见 [Stage 6 任务书](docs/plans/HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md)。

- 2026-09-15：完成 AT-6.4：将 Library、Operations、Developer 的 42 个 state/ref 从 `App.tsx` 收入三个单一所有者（11/22/9），写队列、安装状态、数据库刷新和开发诊断的可变引用不再泄漏；autosave 恢复、写后刷新、共享元数据前台同步、关闭 flush/确认顺序及生产态开发诊断惰性保持。新增真实运行时、42 项基线、三项变异与 CRLF 门禁；typecheck、88/88 诊断、Electron/Vite 354/1/190 模块及混淆 3/3 通过。AT-6.3 Windows 完整构建回执已收；本环境无 Cargo，6.4 pull 后 Windows 完整构建与 GUI 复验待补。无依赖、数据库、IPC、CSS 或原生源码变更。详见 [Stage 6 任务书](docs/plans/HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md)。

- 2026-09-15：修正 AT-6.3 远端提交中 `fontPreviewLoadRuntime.ts` 冻结 token 哈希的录入错误；以 AT-6.2 基线源码和诊断使用的 TypeScript scanner 重算正确值，生产源码与控制器行为不变。目标诊断和 87/87 全量门禁通过；后续 Windows 完整构建回执已收。详见 [Stage 6 任务书](docs/plans/HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md)。

- 2026-09-14：AT-6.3 将 Selection、Folder、Preview 的 40 个 state/ref 收入三个单一所有者（17/6/17），Preview 可变队列不再暴露给 App、目录或索引事件，跨域删除与滚动只传窄命令/只读 ref；选择 hydration、详情竞态序号、目录拖放和预览队列时序保持。新增真实单击、Ctrl/Shift 多选、框选、双击详情、目录拖放/删除、快速滚动预览、40 项基线、两项变异与 CRLF 门禁；typecheck、87/87 诊断、Electron/Vite 354/1/186 模块及混淆 3/3 通过。AT-6.2 Windows 完整构建回执已收；本环境无 Cargo，6.3 pull 后 Windows 完整构建与 GUI 复验待补。无依赖、数据库、IPC、CSS 或原生源码变更。详见 [Stage 6 任务书](docs/plans/HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md)。

- 2026-09-14：AT-6.2 将 16 个浏览 state、7 个持久 ref 收入 `useBrowseController`，并把字体索引/指标、标签/目录、可见字体等 9 项无副作用计算提取为只读派生；数据库分页、family、滚动、preview/selection 的原所有权和时序保持。新增真实逐页 toolbar/筛选行为、初始化与调用顺序、派生函数体、显式端口、两项变异和 CRLF 门禁；typecheck、86/86 诊断、三端构建及混淆通过。6.1 Windows 完整构建回执已收；6.2 pull 后 Windows/GUI 复验待补，6.3 未开始。详见 [Stage 6 任务书](docs/plans/HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md)。

- 2026-09-13：AT-6.1 将 AppRootView 的 169 个平铺 any 参数改为六组强类型，补齐侧栏/列表/弹层直接边界，删除 App 的六个无用组件 import；原状态与 UI 接线保持。18 个编译拒绝、四种渲染组合及 CRLF 基线、typecheck、85/85 诊断和三端构建/混淆通过。新分支 `stage/06-react-composition`；详见 [Stage 6 任务书](docs/plans/HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md)。

- 2026-09-12：独立修复 AUD-5.4-01：daemon 通过捕获的进程发送 shutdown，正常 stop 提供 1 秒退出期限，写入失败/超时及父进程最终退出保留 kill 兜底；未完成写任务保留已提交错误，旧进程事件不再影响替代进程。typecheck、84/84 诊断、三端构建与混淆通过，包含真实 Node 正常/超时退出测试。公开接口与原生协议保持，pull 后 `npm run build` 并验证实际关闭，详见 [Stage 5 第 10 节](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-12：完成 AT-5.4 兼容门面收尾：219→185 行，45 项方法直接归属 transport/五组 client，89 个类型导出保持；强化纯组合边界和 7 项控制引用检查，20 个退化反例、typecheck、83/83 诊断及三端构建/混淆通过。5.3 Windows 构建回执已收，本次 pull 后正常 `npm run build` 复验；审计另发现原有 daemon shutdown 写入未执行、实际走 kill，列为独立待修 AUD-5.4-01。Stage 5 拆分实现收尾，实机/退出验收与该问题尚未关闭，Stage 6 未开始。详见 [Stage 5 第 9 节](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-11：AT-5.3 完成 Indexing client（9 条命令），累计 5/5 组；领域函数与结果/失败语义保持，使用同一个 transport 和显式窄端口。原 369+7 行为基线、38 项 client 方法身份、typecheck、83/83 诊断及三端构建/混淆通过。沿用 Stage 5 分支，pull 后正常 `npm run build` 复验；Cargo 在审查环境不可用，未宣称本项 Windows 完整构建通过。下一项 AT-5.4，详见 [Stage 5 第 7 节](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-11：AT-5.3 完成 Metadata client（11 条命令），累计 4/5 组；领域函数与结果/失败语义保持，使用同一个 transport 和显式窄端口。原 369+7 行为基线、29 项 client 方法身份、typecheck、83/83 诊断及三端构建/混淆通过。沿用 Stage 5 分支，pull 后正常 `npm run build` 复验；Cargo 在审查环境不可用，未宣称本项 Windows 完整构建通过。下一项 indexing，详见 [Stage 5 第 7 节](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-11：AT-5.3 完成 Windows client（8 条命令），累计 3/5 组；领域函数与结果/失败语义保持，使用同一个 transport 和显式窄端口。原 369+7 行为基线、18 项 client 方法身份、typecheck、83/83 诊断及三端构建/混淆通过。沿用 Stage 5 分支，pull 后正常 `npm run build` 复验；Cargo 在审查环境不可用，未宣称本项 Windows 完整构建通过。下一项 metadata，详见 [Stage 5 第 7 节](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-11：AT-5.3 完成 Preview client（8 条命令），累计 2/5 组；领域函数与结果/失败语义保持，使用同一个 transport 和显式窄端口。原 369+7 行为基线、10 项 client 方法身份、typecheck、83/83 诊断及三端构建/混淆通过。沿用 Stage 5 分支，pull 后正常 `npm run build` 复验；Cargo 在审查环境不可用，未宣称本项 Windows 完整构建通过。下一项 Windows，详见 [Stage 5 第 7 节](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-11：AT-5.3 完成 Maintenance client（2 条命令），累计 1/5 组；领域函数与结果/失败语义保持，使用同一个 transport 和显式窄端口。原 369+7 行为基线、2 项 client 方法身份、typecheck、83/83 诊断及三端构建/混淆通过。沿用 Stage 5 分支，pull 后正常 `npm run build` 复验；Cargo 在审查环境不可用，未宣称本项 Windows 完整构建通过。下一项 preview，详见 [Stage 5 第 7 节](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-10：完成 AT-5.2：提取 Rust Worker transport，统一诊断、daemon/scheduler、取消与日志状态，28 处临时文件集中管理并保留原释放时序；门面 2195→1985 行，45 个方法/38 条命令及旧类型导出保持。新增 369 个基线用例、7 组状态/并发序列、真实 Node 进程边界和 10 个退化反例；typecheck、82/82 诊断、三端构建及混淆通过。5.1 流程的 Windows 构建成功回执已收；沿用 Stage 5 分支，pull 后执行 `npm run build` 复验，无依赖升级或数据迁移。下一项 5.3 尚未开始，详见 [Stage 5 第 6 节](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-10：完成 AT-5.1：提取 89 个 Rust Worker 公开契约和 38 个内部 payload，5 个类型调用方迁至 contracts，旧门面类型导出保持兼容。6 个既有生产文件编译后 JS 不变，门面 2994→2195 行。新增类型身份、私有边界、循环依赖、41 项编译拒绝和 9 个反例门禁；typecheck、81/81 诊断、三端构建及混淆通过。新分支 `stage/05-rust-worker-composition`；无需数据迁移或更新依赖，切换后正常 build 复验。下一项 5.2 尚未开始，Windows 最后已收回执仍为 `c981777`。详见 [Stage 5 任务书](docs/plans/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)。

- 2026-09-10：完成 AT-4.4：入口 715→77 行，Application 按五组发布原 115 项注册能力；标签协调独立归属，Data/Mutation/Operations 分组输入保持原 31/65/118 项端口。新增逐项能力引用与八个错误接线/重复启动退出反例；typecheck、80/80 诊断、三端构建及混淆通过。Windows 前置 `c981777` 已完整验证，新提交 pull 后正常 build 复验；无依赖版本、数据库或原生源码变更。Stage 4 实现收尾，Stage 5 未开始，详见 [Stage 4 第 10 节](docs/plans/HFM_STAGE_04_MAIN_COMPOSITION_TASKBOOK.md)。

- 2026-09-09：修复 Windows 编译契约诊断将正反斜杠视为不同文件的问题，虚拟源、旧适配器替身和错误位置采用一致路径匹配。新增正斜杠/反斜杠/混合写法与 LF/CRLF 六组用例和三个退化反例，保留原 125 项编译拒绝；typecheck、79/79 诊断通过。沿用 Stage 4 分支，pull 后重新 build；应用、依赖版本与原生源码不变。用户上一轮 Windows build 确实失败，AT-4.4 待本机复验通过再推进，详见 [Stage 4 第 9.5 节](docs/plans/HFM_STAGE_04_MAIN_COMPOSITION_TASKBOOK.md)。

- 2026-09-09：完成 AT-4.3：提取 Mutation/Operations 及扫描、维护组合，入口 1222→715 行；四处 Operations 可变引用改为唯一实例和显式反馈绑定，全部绑定后才允许启动扫描、刷新、后台任务及共享标签定时刷新。任务库仍由后台运行时唯一持有，补强任务端口类型。新增 12 个提前启动拒绝场景、14 条操作流程与 9 种真实生命周期场景，包含退出取消/失败恢复和异常退出；typecheck、78/78 诊断、三端构建与混淆通过，原 115/45/38/10 项契约保持。沿用 `stage/04-main-composition`，下一项 AT-4.4；无依赖、数据库或原生源码变更，pull 后正常 build。详见 [Stage 4 任务书第 9 节](docs/plans/HFM_STAGE_04_MAIN_COMPOSITION_TASKBOOK.md)。

- 2026-09-09：完成 AT-4.2：提取 Core/Data 组合工厂及 storage/query 所有者，`index.ts` 2075→1222 行；保留句柄单一所有权和成功保存后的预览失效通知，收窄 Rust/后台任务端口，消除一处前向同步占位。115 项注册与 14 条基线流程等价、429 个操作表面类型及 6 种错误接线反例通过；typecheck、77/77 长期诊断、Electron 三端构建和三份新 JS 混淆通过。更新两处旧诊断的源码定位，原断言保留。仍在 `stage/04-main-composition`，下一项 AT-4.3 未开始；本次不改数据库、依赖版本、字体文件或原生源码，pull 后按通常流程 build。边界与操作见 [Stage 4 任务书第 8 节](docs/plans/HFM_STAGE_04_MAIN_COMPOSITION_TASKBOOK.md)。

- 2026-09-08：Stage 4 在 `stage/04-main-composition` 分支完成 AT-4.1：为 Core/Data/Mutation/Operations 与 Application 建立只含类型的组合返回契约，现有 115 项注册能力全部必填，明确 24 项生命周期和 7 项数据库资源操作的所有权。新增编译器门禁覆盖 125 项负例，验证旧入口遗漏可选能力的问题及适配器运行时等价；typecheck、76/76 长期诊断、Electron 三端构建和混淆通过。复审并记录 8 处延迟绑定、真实回调循环与后续拆分顺序；三大巨型编排文件未改，AT-4.2 尚未开始。详见 [Stage 4 任务书](docs/plans/HFM_STAGE_04_MAIN_COMPOSITION_TASKBOOK.md)，本项无需迁移字体库或额外重建原生程序。
- 2026-09-08：Stage 3 Windows 完整构建验收通过：拉取 `476c5d6` 后，typecheck、75/75 诊断、三后端预览输入、Rust release、公钥同步、Electron 三端与混淆 3/3 全部成功。NAS、实际位图/峰值内存及安装包验收仍单列为外部项；下一项为新 Stage 4 分支上的 AT-4.1，见 [Stage 3 第 10.9 节](docs/plans/HFM_STAGE_03_FILE_PREVIEW_TASKBOOK.md#109-windows-完整构建通过与阶段交接)。
- 2026-09-08：Windows 管理员窗口已通过路径 POLICY/PHYSICAL/READ 检查，symlink 权限阻塞解除；后续 io-deadline 暴露源码换行匹配问题。修复六项诊断的 CRLF 误报/漏报，新增 LF/CRLF 正反例 24 场景；typecheck 与本环境 75/75 诊断通过。应用源码和依赖版本未改，**本次需先 pull 再重跑 Windows build**，步骤见 [Stage 3 第 10.8 节](docs/plans/HFM_STAGE_03_FILE_PREVIEW_TASKBOOK.md#108-windows-权限问题已解决修复诊断的-crlf-兼容性)。
- 2026-09-08：记录 Stage 3 Windows 复验：C++ 68、PowerShell 68、Rust shared fixtures、JS 190 的预览严格诊断全部通过；类型检查和移动事务 29 用例通过。完整 verify/build 仍因测试 symlink EPERM 中止，阶段尚未完整验收；管理员终端重试步骤与下一项 AT-4.1 的前置条件见 [Stage 3 第 10.7 节](docs/plans/HFM_STAGE_03_FILE_PREVIEW_TASKBOOK.md#107-windows-严格诊断复验通过完整构建仍受阻)。
- 2026-09-08：修复 Stage 3 Windows 补验暴露的 PowerShell 孤立代理项漏检：先检查 JSON 原文再解析，保留合法 U+FFFD、emoji 和字面量反斜杠；诊断与生产共用解析校验。symlink EPERM/EACCES 改为明确提示所需 Windows 权限，保持门禁失败。190 个 JS 行为用例、68 个 C++ 输入策略用例、typecheck、74/74 本环境诊断及三端构建/混淆通过。用户 C++/Rust 原生构建已成功；PowerShell 修复和 Windows 完整门禁仍需复验，操作见 [Stage 3 第 10.6 节](docs/plans/HFM_STAGE_03_FILE_PREVIEW_TASKBOOK.md#106-windows-日志反馈与回归修复)。
- 2026-09-07：Stage 3 AT-3.2 统一预览输入边界：width 64–4096、height 32–2048（整数）、fontSize 8–320（保留小数）、text 最多 4096 UTF-16 单位。非法请求在缓存/任务/后端分派前拒绝，Rust/C++/PowerShell 保留分配前校验，拒绝日志限频；修复小数字号调度合并、C++ 数值/JSON 转义解析与空白文本后端差异。预览渲染版本提升，旧缓存按需重生成，不迁移字体库。175 个 JS 行为场景、C++ 输入策略 59 场景、typecheck、74/74 长期诊断及三端构建/混淆通过；巨型编排与公开契约保持原状。**pull 后需重建 Rust 与 C++ 原生程序**；Rust/PowerShell 实际校验执行、Windows 位图/峰值内存与 NAS 验收仍待补，Stage 3 未标为完整验收。操作与边界见 [Stage 3 任务书](docs/plans/HFM_STAGE_03_FILE_PREVIEW_TASKBOOK.md)。
- 2026-09-07：Stage 3 AT-3.1 将字体移动拆成授权/批量结算 owner 与文件提交 owner；跨卷采用唯一排他临时文件、刷盘关闭、尺寸/流式 SHA-256 校验及原子排他发布，再删除源。避免普通 rename 覆盖同名竞态目标；源删除失败、源状态未知、NAS 提交确认丢失均返回真实状态并对账两侧索引，前端仅更新成功项。新增 29 个移动/真实进程中断场景，73/73 长期诊断、类型检查、三端构建/混淆及编排契约通过。`physicalFolders.ts` 614→280 行，`index.ts` 只净增 7 行组合接线，Rust/React 巨型编排未改。排他发布要求文件系统支持硬链接，不支持的卷安全拒绝并保留源；Windows/NAS 能力和性能、断电持久性及未改动的 Rust 构建仍待外部验收。AT-3.2 未开始，协议和中断恢复办法见阶段任务书。
- 2026-09-04：Stage 2 AT-2.4 将托管字体卸载改为完整所有权证明：先由主进程 root index 还原权威字体，再验证应用自有目录真实路径、直接安装目标、精确生成文件名和派生 HKCU registry name；同名系统字体、根外/根内伪路径、伪造 registry、伪造 renderer 字段及缺失索引身份全部在 registry/unlink/broadcast 前拒绝。registry 删除失败保留文件，unlink 失败恢复 registry，补偿失败返回真实 `ok:false`。P8 已成为第 72 项长期门禁，Stage 0 路径观察入口删除，`npm run verify` 与 Electron/Vite 三端 build/混淆通过。巨型编排复审确认 `index.ts` 只增加 12 行窄组合，Rust Worker、`App.tsx`、`AppRootView` 与 115/45/38/10 项契约未漂移；Windows HKCU/占用文件、真实 UNC/长路径/junction 和未改动 Rust 构建仍为外部验收项。
- 2026-09-03：Stage 2 AT-2.3 将物理目录 create/rename、单项和批量字体 move 统一接入主进程窄路径授权：renderer 路径先由当前 watched roots 与主进程索引身份解析，lease lock 由授权根锚定，锁内及 rename/copy/unlink 前重新授权，跨卷 copy 后在 unlink 前验证目标普通字体，操作后复核新真实路径并由主进程安排根索引对账。任意 parent、watched root 重命名、未索引/非字体源、相似前缀、根外链接和锁内替换均拒绝；P6/P7 已成为第 71 项长期门禁，`npm run verify` 与 Electron/Vite 三端 build/混淆通过，P8 托管卸载仍留给 AT-2.4。巨型编排复审确认 `index.ts` 只增加窄组合 11 行，Rust Worker、`App.tsx`、`AppRootView` 与 115/45/38/10 项公开契约均未漂移；Windows 真实 UNC/跨盘/junction 和未改动 Rust 构建仍为外部验收项。
- 2026-09-02：Stage 2 AT-2.2 将 `hfm-font://` 与 FontFace 预览数据读取统一接入中央授权：协议只接受一次严格 base64url/百分号解码，拒绝畸形、双重编码、控制字符、非字体、目录、超限和 realpath 越界，两个消费者均只读取授权 `ioPath`。watched、Windows Fonts、当前用户/临时字体与主进程索引例外保持可用，预览授权保留 NAS I/O deadline。P1-P5 已成为第 70 项长期门禁，`npm run verify` 与 Electron/Vite 三端 build/混淆通过；`windowRuntime.ts` 的协议领域逻辑已拆入独立运行时，`index.ts` 只新增窄组合与索引桥，Rust/前端巨型编排文件未改。
- 2026-09-02：Stage 2 在独立分支 `stage/02-font-path-boundaries` 启动；AT-2.1 建立纯路径组件边界与文件系统授权运行时，统一盘符/UNC/长路径、真实路径、允许字体扩展名、普通文件、80 MiB 上限、主进程索引身份、watched root 和应用自有目录规则，并移除 `fontPathPolicy` 对物理文件操作模块的反向依赖。P0.1-P0.5 已成为第 69 项长期门禁，`npm run verify` 与 Electron/Vite 三端 build/混淆通过；协议/预览、物理操作和托管卸载尚未接入，分别留给 AT-2.2 至 AT-2.4，三大巨型编排文件及公开契约未变。
- 2026-09-02：Stage 1 AT-1.4 将单项与批量临时激活统一到同一个串行事务所有者：批量层只负责去重、逐项调度、取消、结果汇总和一次最终刷新；提前取消不会进入事务，处理中取消保留已提交项并将未开始项标为可重试取消，混合失败与重试均保留稳定 ID 和真实原因。A1-A8 已全部转为长期正确性门禁，`npm run verify` 增至 68/68 并与 Electron/Vite 三端 build 通过；Stage 1 自动门禁收口，三大巨型编排文件及其公开契约未变，Windows 实机矩阵仍为外部验收项。
- 2026-09-02：Stage 1 AT-1.3 为单项临时字体激活加入阶段化逆序补偿：注册表、resource 或会话状态失败时按 resource -> registry -> file 回滚，保留原始根因并汇总全部补偿错误；未完成阶段写入独立持久队列，由启动/退出清理继续重试，且 resource/registry 未清理前不会误删字体文件。A3-A7 已成为长期正确性门禁，`npm run verify` 增至 67/67 并与 Electron/Vite 三端 build 通过；三大巨型编排文件及其公开契约未变。
- 2026-09-02：Stage 1 AT-1.2 将批量字体停用改为逐记录三阶段结算：只有字体资源、注册表和持久文件删除队列均明确成功后才删除临时会话状态；混合失败、缺失 helper 结果及后续清理失败均保留可重试状态和逐项原因。A2 已反转为第 66 项长期正确性门禁，`npm run verify` 与 Electron/Vite 三端 build 通过；三大巨型编排文件及其公开契约未变，Windows 实机与未改动的 Rust worker 构建保留为外部验收项。
- 2026-09-02：Stage 1 在独立分支 `stage/01-activation-transactions` 启动；AT-1.1 修复单项字体资源 add/remove 的结果传播，区分 helper 不可用与 helper 已执行失败，禁止 `ok:false` 静默成功或重复 fallback，并将 A1 反转为第 65 项长期正确性门禁。`npm run verify` 与 Electron/Vite main、preload、renderer build 通过；Windows 实机与未改动的 Rust worker 构建保留为外部验收项。
- 2026-09-01：Stage 0 AT-0.4 固化三大编排契约：主进程 115 个注册键与生命周期、Rust 45 个公开方法和 38 条命令路由、Input/Result 类型及失败边界、React 10 条关键流程和六组目标视图契约。Stage 0 总门禁通过，`diagnostics:all` 增至 64 项；生产编排代码未修改。
- 2026-09-01：Stage 0 AT-0.3 新增字体路径授权基线观察，在自动清理的临时目录和纯注册表替身中覆盖 8 个场景；稳定复现非字体读取、symlink 越界读取、任意目录写入/移动和前缀式托管卸载等 6 个缺陷，并锁定 2 个现有安全停止行为；未修改生产逻辑。
- 2026-09-01：Stage 0 AT-0.2 新增激活/停用事务基线观察，使用真实运行时与纯替身覆盖 8 个故障场景，稳定复现 7 个已知缺陷并锁定复制失败的安全停止行为；未修改生产逻辑。
- 2026-09-01：Stage 0 使用独立分支 `stage/00-baseline-behavior-locks` 启动；AT-0.1 固化修复前环境、架构与安全基线。TypeScript、63 项诊断和 Electron/Vite build 通过；生产依赖漏洞为 0，Rust/Windows 实机验证待补。
- 2026-09-01：建立 HFM 修复与编排重构总任务书及 Stage 0 当前任务书；完成三个巨型编排文件的二次职责审计，明确按状态所有权和领域边界拆分，不以行数或机械搬文件作为验收标准。本次仅更新文档，未修改运行时代码。
- 2026-09-01：删除误留的任务书、开发私钥、可重建输出与 Rust 构建缓存；完善忽略规则，并将锁文件中的内部制品地址改回公共 npm registry，使新环境可正常执行 `npm ci`。
- 本次验证：`npm ci`、TypeScript 类型检查、63 项诊断、Electron/Vite 构建及混淆通过。审查环境缺少 Cargo，未完成 Rust worker 与 Windows 安装包的全量重建。

W-03b：监听失败后有界重读并同步根快照；grace 事件保留，旧代次不通知，错误枚举下手动刷新不删除缺项。TypeScript / 94 项诊断通过；Windows 开发模式复验待执行。

W-03c：文件监听与手动文件刷新按来源更新文件信息，保留已有收藏、标签、保护与激活状态；共享元数据更新保持原行为。详见专项任务书 §15，Windows 使用 `npm run dev` 复验，下一项 A-02。

W-03 最终验证：TypeScript、94/94 全量诊断、Electron/Vite 354/1/190 模块通过；自动验证完成，Windows GUI 待回执。

### 2026-09-16：F-07 Windows 回执复核

已发布b7f68e1。新日志确认可选metrics缺失健康检查通过，目录本次未再缩减但历史完整清单未恢复；正常激活/停止仍全根同步，激活文件预览新路由未实际触发。纠正changed=0解释：它是同步输入relative_paths数量，不是数据库变化行数。详细时间、证据与待查项见链路一致性任务书§19；随后按R-05独立处理标签意图生命周期。
