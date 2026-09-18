# HFM 共享离线保留与本地字体退出清理任务书

## 0. 文档状态与执行入口

- 文档版本：1.6；制定日期：2026-09-18；软件版本：3.0.0。
- 仓库：`uniquenesssta/99`；制定及专项实施分支：`stage/09-preview-tags-app`。本项是当前分支的补充专项，不另行宣告主线 Stage 8 或 U-09 完成。
- 制定代码基线：`5866105917d3af7a843f320f220ae047bb49d957`；实施前重新核对实际 HEAD、远端与工作树，不能把此处基线当成永远最新。
- 当前状态：**O-00 基线取证已交付；O-01 已实现，自动验证通过、实机待验；O-02 已接入七项共享请求及目录探测，完整业务隔离未完成；O-03 已实现、自动验证通过、实机待验；O-04 已开始故障取证，完整实现受阻；O-05～O-08 未开始。**
- 用户最终约定：共享监视文件夹和共享标签断网后保留原位置、置灰禁用，重连后恢复；网络永远不恢复也必须允许正常退出；已激活字体通过本机副本继续使用和清理；不做离线共享修改或离线同步系统。
- 上级：[总任务书](HFM_REMEDIATION_MASTER_TASKBOOK.md)。承接[操作优化任务书](HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md) §19、§20，保留状态按钮合一、100ms 单击防连击、标签提交即时查询及共享冲突修复。
- 同时继承[链路一致性任务书](HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md)的事务/意图/回执约束，以及 [Stage 1 激活事务](HFM_STAGE_01_ACTIVATION_TASKBOOK.md)、[Stage 2 路径授权](HFM_STAGE_02_PATH_AUTHORIZATION_TASKBOOK.md)、[Stage 5 Rust 边界](HFM_STAGE_05_RUST_WORKER_TASKBOOK.md)、[Stage 6 React 所有权](HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md)、[Stage 7 IPC 校验](HFM_STAGE_07_IPC_SECURITY_DEPENDENCY_TASKBOOK.md)的质量要求。
- 历史证据：制定基线通过 TypeScript、125/125 诊断、Electron/Vite 367/1/200 模块构建与混淆 3/3；这些是上一实现的自动验证，**不证明本专项的断网、重连、残留和 Windows 退出已经通过**。
- 本文是本专项唯一执行与验收记录；README 仍是唯一变更记录，不创建另一份简版、最终版或平行任务书。

## 1. 目标、非目标与需求追踪

### 1.1 必须实现

| 编号 | 用户要求 | 硬性结果 | 主要任务 |
| --- | --- | --- | --- |
| UO-01 | 共享监视文件夹断网后灰掉但不消失 | 保留路径、身份、目录树和顺序，禁用需要该根在线的入口 | O-01、O-03 |
| UO-02 | 共享标签灰掉但不消失 | 保留最近确认的目录/绑定展示，不将读取失败或部分结果写成空目录 | O-01、O-03 |
| UO-03 | 重新接上后仍能使用 | 验证同一共享根身份及读取能力后恢复，不重复添加根、不重复创建 watcher | O-07 |
| UO-04 | 不需要离线同步系统 | 离线新共享写入拒绝；不保存待重放标签命令、不自动补交、不自动合并离线编辑 | O-02、O-03、O-07 |
| UO-05 | 网络卡住不影响软件关闭 | 有界请求与真正的进程隔离；本地退出流程不等待网络结果 | O-02、O-06 |
| UO-06 | 激活后断网还能使用与取消 | 只使用本机托管副本和本地记录；取消路径不能重新检查网络源字体 | O-04 |
| UO-07 | 关闭后自动清理临时副本 | 先取消资源/临时注册项，再删本机副本；占用时准确记录残留并允许退出 | O-05、O-06 |
| UO-08 | 一直无法取消也有解决办法 | 明确失败阶段、可手动重试；必要的权限与重启清理路径可验证，不无限循环 | O-05、O-08 |

### 1.2 明确不做

- 不新增离线标签编辑、操作重放、后台共享上传、冲突合并、离线业务 outbox 或长期同步服务。
- 不做两次软链接/硬链接，不通过网络链接跳转来清理字体，不把临时副本导入正式字体库。
- 不复制整个 NAS 字体库，不因为置灰要求新增完整离线字体镜像或离线检索系统。
- 不重写扫描、预览算法，不升级依赖，不扩展永久安装/卸载能力，不改变现有按钮设计。
- 不自动结束 Photoshop 等第三方程序，不自动重启 Windows，不扫描删除任意同名字体。
- 不把“源目录离线”与“文件确实删除”“用户移除根”“共享标签墓碑删除”混为一件事。
- 本机安装状态的可重建脏标记、本机激活恢复记录、已提交写入的结果未知标记属于正确性元数据，**不包含待自动重放的共享编辑指令**。

### 1.3 状态定义

任务状态仅用：未开始、实施中、自动验证通过待实机、完成、阻塞。同一时间只有一项实施中。设计完成、代码完成、自动验证和实机通过必须分开记录。

## 2. 当前源码事实与缺口

以下是制定时实际读取的导航，不是把整张表授权为一次修改范围。

| 现有模块/路径 | 已有能力或事实 | 本专项需要验证/修改的边界 |
| --- | --- | --- |
| `src/main/path/startupPathAvailabilityRuntime.ts` | UNC 探测、TTL、在途合并；非 UNC 路径直接视为可用 | 映射网络盘如 `O:\字体` 不能漏掉；TTL 到期不等于恢复在线 |
| `src/main/path/ioDeadlineRuntime.ts` | I/O deadline 与超时结果 | 释放 Promise 等待不等于底层 I/O 停止；同步阻塞时定时器也不能救主进程 |
| `src/main/folders/folderCacheRootAvailabilityRuntime.ts` | 过滤可用根，返回 skippedFolders | 执行根集合不能反写为已配置根集合，防止离线消失 |
| `src/main/preview/runtime/previewCacheRootAvailabilityRuntime.ts`、`previewSharedStorageCircuitBreakerRuntime.ts` | 共享预览可用性与熔断 | 不能把预览缓存写失败直接判为整个字体根离线；不能当成统一共享状态已完成 |
| `src/main/watcher/folderWatcherRuntime.ts` | generation、watcher 重建、失败批恢复 | 区分每根离线、正常删除、旧 watcher 迟到事件；离线时停止自旋重试 |
| `src/main/library/sharedKnownTagsRuntime.ts` | 已有部分保留目录机制，仍聚合多根标签 | 审核全部调用选项；部分成功不能撤销离线根标签，缺省异常不能等价空目录 |
| `src/main/indexing/shared-metadata/sharedMetadataOverlayRuntime.ts`、`sharedMetadataDbRuntime.ts` | Rust 前置兼容回放含主进程 SQLite 操作 | 网络 DB 的同步打开/查询/关闭必须纳入隔离审计，不只包最外层超时 |
| `src/main/rust-core/rustCoreDaemonRuntime.ts` | 提交后超时发送 cancel，退出有终止兜底 | 协作 cancel 不保证系统 I/O 返回；不得杀共享 daemon 而连带中止本地清理后还报成功 |
| `src/main/activation/runtime/fontActivationCopyRuntime.ts` | 激活已先复制到本机目标，不是依赖网络软链接 | 复制完成、复用校验、断途中止、临时产物所有权需要故障证据 |
| `src/main/windows/runtime/temporaryActiveFontsStoreRuntime.ts` | `temporary-active-fonts.json`；当前解析/读取失败会返回空记录，写入直接 writeFile | 不可把损坏或权限错误视为“没有激活”；本地持久化可靠性属于退出安全的必要修复 |
| `src/main/activation/runtime/fontActivationCleanupRuntime.ts` | 本地资源/注册项/文件清理、可见性核验，默认最多 18 轮 | 核验和后续状态处理不能重新访问网络源；残留不能无限阻止退出 |
| `src/main/activation/temporaryFontDeleteQueue.ts`、`runtime/fontActivationCompensationQueue.ts` | 已有持久删除队列与补偿队列 | 复用权威 owner，不能再建立第三套重复清理队列 |
| `src/main/activation/activationInstallStatusSaveQueue.ts` | 保存后仍根定位、同步合并索引 | 从退出必经路径拆出网络校正；本地清理结果不依赖共享保存成功 |
| `src/main/app/windowRuntime.ts`、`mainProcessLifecycleRuntime.ts` | 渲染器保存等待、before-quit 清理、残留时恢复窗口、保存后才停止 watcher | 冻结入口和停止网络必须提前；窗口保存、字体清理、worker 终止共用退出预算 |
| `src/renderer/src/components/app/AppSidebarFoldersPage.tsx`、`AppSidebarTagPage.tsx` | 现有目录/标签组件及操作入口 | 同名通用组件还服务本地标签，新增离线能力不能误灰本地标签 |
| `src/renderer/src/runtime/app/effects/useWatchedFoldersRuntime.ts`、`useSharedMetadataSyncForegroundRuntime.ts` | 监听注册、前台共享刷新生命周期 | 离线/重连不能导致 effects 风暴、重复订阅或旧结果覆盖 |

重要证据边界：上一份日志关闭前已手动取消激活，不能据此声称“带激活断网退出”实机通过。映射盘探测缺口与主进程网络 SQLite 风险来自源码；具体卡住位置及耗时由 O-00 取证。

## 3. 不可破坏的不变量

| 编号 | 不变量 | 禁止的实现 |
| --- | --- | --- |
| INV-01 | 配置根集合、可执行根集合、展示缓存各有清晰含义 | 用 availableRoots 覆盖 library.folders |
| INV-02 | 无法读取不是空集，也不是删除 | catch 后返回 [] 并持久覆盖标签/目录/字体索引 |
| INV-03 | 可用性以根身份及代次为准 | 仅凭盘符/同一路径/网络接口 online 恢复操作 |
| INV-04 | 主进程校验是动作权限权威，UI 置灰只是反馈 | 绕过 UI 的 IPC 仍能写离线根 |
| INV-05 | 旧代次结果无权修改新状态 | 超时后的旧成功把根重新启用，或恢复后的旧失败再次置灰 |
| INV-06 | 未提交、已提交、结果未知分别结算 | 超时自动换后端重复写入，或把取消请求当作回滚成功 |
| INV-07 | 在线根、本地库和本机字体清理互不被离线根占住执行通道 | 一个 NAS 卡住全部 worker/全局 I/O 槽 |
| INV-08 | 字体资源成功移除与临时文件成功删除是两个事实 | 文件被占用就报仍激活，或资源未移除先删除副本 |
| INV-09 | 仅清理本软件拥有的临时资源 | 仅凭 basename 前缀删除永久字体、源文件或外部链接目标 |
| INV-10 | 持久恢复意图先于不可逆清理；只有核验成功才清记录 | 写记录失败仍激活新字体，或清理超时后清空恢复记录 |
| INV-11 | 退出不以网络恢复为前提 | 关闭后继续网络轮询、无限等待同步、要求恢复网络才退出 |
| INV-12 | 本地标签、共享标签、收藏、保护独立 | 用离线共享快照覆盖本机字段，或统一禁用所有功能 |
| INV-13 | 七 controller、Rust facade、入口编排的单一所有权保持 | App/index.ts/daemon 门面累积网络状态机和磁盘事务 |
| INV-14 | 既有 100ms 选择、混合目标、最后标签删除、版本校验保持 | 以重录全量 fixture 或拉长 TTL 掩盖回归 |

本书明确覆盖旧退出策略“残留必须阻止退出”：新策略允许持久记录残留后退出，但不允许将未清理报成功。它不覆盖 Stage 1 的逐项成功判定、逆序补偿或 Stage 2 的路径授权要求。

## 4. 目标职责与所有权

本节是待实现设计，不能作为已有代码能力对外宣称。具体新增文件在执行卡中确定；已有内聚 owner 能承担时优先扩展，不机械拆分。

| 责任 | 唯一 owner 与拟放置层 | 输入/输出边界 | 不负责 |
| --- | --- | --- | --- |
| 共享根可用性 | 主进程 path/folders 层专用运行时 | 已配置根身份、探测结果、代次；输出只读状态快照和事件 | UI 状态、共享标签写队列、字体事务 |
| 网络任务隔离 | rust-core/现有 worker 调度边界 | rootId、generation、command、deadline；明确 completed/failed/unknown | 判定标签目录为空、自动重写事务 |
| 最近确认目录 | 现有 library 持久化与共享目录 owner | 根级完整快照及已确认版本；区分部分和完整结果 | 第二套字体库、离线编辑缓存 |
| 展示及交互 | 现有 Browse/Library controller 与 sidebar/detail/menu | 只读能力状态；统一动作准入结果 | 自行 ping、修改主进程 root 状态 |
| 本地激活恢复 | 现有 activation/store/compensation/delete owner | 持久本地身份、逐阶段事实与重试结果 | 查 NAS 源文件证明能否取消、重放共享编辑 |
| 退出编排 | app 生命周期专用协调责任 | 单一 quitId、全局期限、本地保存及清理结果 | 字体删除算法、共享 SQL、另建通用任务系统 |

必须产出消费者清单：watcher、扫描、手动刷新、路径授权、共享标签目录/绑定/重命名/删除、预览共享缓存、分页/ID/统计、安装状态读写、维护备份、关闭保存。每一项标记“本地执行/隔离网络/离线拒绝/保留快照”，不得用“其余相关模块”代替审查。

禁止 UI 传入任意 rootPath 或 authorized 布尔值绕过授权。根标识由主进程配置解析；路径字符串只用于显示或经授权的定位。注册表、临时副本和永久安装身份由已有安全策略验证。

## 5. 共享状态、数据保留与界面契约

### 5.1 根级状态机

状态至少明确 `checking`、`online`、`offline`、`recovering`；移除配置是独立用户操作，不是网络状态。

| 当前状态 | 事件 | 下一状态及行为 |
| --- | --- | --- |
| 启动/未知 | 加载持久根和最近确认目录 | checking；立即展示保留项并禁用网络动作，后台有限探测 |
| online | 路径不可达、连接失败或实际 I/O 超时 | offline；增加代次，禁止新网络动作，隔离旧任务，保留展示 |
| online | 仅缓存写权限不足、DB busy 或字体被占用 | 返回对应能力/操作错误；不得无证据断言整个共享根离线 |
| offline | 到达探测时间或用户点击重试 | recovering；每根至多一个探测，仍禁用网络动作 |
| recovering | 共享目录可读、身份相符、必要状态校验完成 | online；受控刷新当前状态、只创建一份 watcher |
| recovering | 失败/超时/身份改变 | offline；保留旧数据；身份改变提示重新确认，不自动绑定新库 |
| 任意 | 进入退出状态 | 停止探测/恢复/调度；任何迟到事件不得重启任务或窗口 |

- 不能依赖 `navigator.onLine`、ping 成功或系统网卡连接作为共享库可用证据。验证实际共享目录和索引身份；探测不得创建目录、DB 或锁文件。
- 映射盘、UNC、长路径、大小写/斜杠及已知别名采用既有路径规范化；新增映射盘识别应在隔离边界完成并缓存，不能让识别本身卡主进程。
- 重启时先显示本地保留项再探测；上次 online 不能在本次未验证前直接授权写入。
- 两个根独立处理。一个离线不能删除另一个的标签、关闭另一个的 watcher 或把整个本地库锁住。

### 5.2 保留的数据与完整性

1. 已配置监视根、稳定身份、展示名称、顺序、展开状态和用户选中项保持；父根离线时其缓存子目录整体禁用，不逐个删空。
2. 保留最近确认的共享标签目录及现有绑定展示；缓存数量标记“上次记录”，不能伪装成当前已完整查询的总数。
3. 目录读回必须带根覆盖范围、完整性和代次。局部成功只替换成功根的确认快照，不能用联合结果全量覆盖未读根。
4. 本地没有某个根的标签归属证据时，先保留现有总目录。受该不确定性影响的全局共享标签操作保守禁用，不猜测归属；O-01 记录兼容恢复方案。
5. 任何新增保留元数据须使用现有本地存储责任；保存的是最近确认状态，不是离线用户修改。禁止为展示离线状态复制全部远程字体数据。
6. 离线不触发删除墓碑、不清空共享索引、不执行“空目录修复”，不改变正常在线显式删除语义。

### 5.3 交互矩阵

| 功能 | 受影响根离线时 | 恢复后 |
| --- | --- | --- |
| 共享根及已缓存子目录 | 留在原位置、置灰、显示离线；保持选中和展开状态 | 原位置解除禁用，按新鲜结果更新 |
| 共享标签 | 保留原条目；受影响项置灰，禁止编辑/右键写操作 | 校验目录后恢复；正常删除结果仍可生效 |
| 已打开的共享页面 | 保留最近确认画面并标注离线，不继续触发分页/预览请求 | 重新请求当前页面，拒绝旧代次结果 |
| 新增激活/安装、源文件复制/移动/删除 | 需要离线源的目标在副作用前拒绝 | 使用新鲜目标身份正常执行 |
| 取消本机临时激活 | 详情、右键和本地残留入口仍可用 | 同一流程，不分在线/离线两套算法 |
| 本地标签、收藏、保护 | 目标本地身份完整且不需要读源文件时继续使用 | 保留原行为 |
| 批量混合在线/离线目标 | 先完整解析并报告离线目标；不悄悄只操作在线子集 | 原 complete-or-reject 和逐项结算保持 |
| 共享标签横跨多根 | 任一必需根离线时禁止整次全局写操作 | 覆盖根全部校验后启用 |

统一覆盖鼠标、键盘、双击、右键、拖放、快捷键、详情按钮、批量标签菜单和 IPC 调用；不是只调 CSS。选中离线共享字体时仍能通过本地激活记录取消激活，不因普通源字体 hydration 失败丢失这个入口。

## 6. 请求隔离与写入结果未知

### 6.1 请求边界

- 请求必须携带主进程生成的 requestId、rootId、generation、任务类型与期限；共享根状态转换后旧代次的读结果和 watcher 删除事件不再应用。
- 本地操作、字体资源清理与可能永久阻塞的共享 I/O 分开调度。不得只在同一个单线程 daemon 内划两个逻辑队列便宣称已经隔离。
- 枚举主进程所有可能访问网络的同步调用，包括 SQLite open/query/close、exists/stat/realpath、锁、路径授权、目录扫描和兼容预检。阻塞调用迁入可终止的执行进程；保留 Rust-first 和已有后端权限策略。
- 优先复用现有进程/传输机制建立最小隔离域；确需新增实例时明确谁创建、谁终止、句柄归属及消息路由。不能无界地每根常驻一个新进程。
- 共享隔离执行默认全局至多 2 个活动任务、每根 1 个；待执行队列默认上限 128，同键读请求合并，队列满明确拒绝或取消过期读，不能丢弃已提交写入事实。为本地操作保留独立执行能力；常量由 O-00/O-02 实测固定，不引入无界每根常驻进程。
- 超时先结算等待者并暂停根，再在宽限期内取消/终止隔离任务；取消写入成功不代表底层已停。必须记录子进程退出或隔离结果，禁止无限堆积孤儿进程。
- 迟到的读结果可以丢弃；写入的迟到确认必须交给原操作结算 owner 保存事实，不可因 UI 代次变化抹掉已提交事实。
- 不杀其他应用，不用全局强杀所有 hfm worker 代替按所有权终止；本地清理通道要保持可运行。

### 6.2 不做离线同步时的写入语义

| 断网时刻 | 处理 |
| --- | --- |
| 用户尚未发起共享修改 | 禁用入口；主进程拒绝请求；不创建待办 |
| 本次操作仍在队列，尚未提交后端 | 取消未提交请求，按 R-05 仅回滚自己的乐观意图；不影响后来本地字段 |
| 后端确认失败/未提交 | 明确失败；网络恢复后由用户重新操作，不自动重放 |
| 后端确认已提交但刷新失败 | 保留提交事实，提示状态待核验；恢复后只读回当前状态 |
| 已提交给后端但响应丢失 | 标记结果未知，记录最小操作身份/阶段；禁止自动重试、换后端重写或宣称回滚 |

已有结果未知记录只用于查证，不保存可执行的离线修改队列。重连后读当前权威数据，不能仅凭“标签值恰好相同”证明特定请求提交过。没有可靠回执时保留未知事实，用户可在查看当前状态后重新发起新意图。

## 7. 本地副本、取消激活与残留清理

### 7.1 副本生命周期

- 沿用当前受托管的本机临时字体路径与命名，先核实实际 Windows 注册方式；本专项不无故迁移既有副本到另一目录。
- 激活提交前，必须有经过授权的源身份、本机目标身份和恢复记录；复制采用完整结果确认，半文件不能注册/激活。相同 size/mtime 不能单独证明碰撞副本一定属于同一字体，复用需验证既有身份依据。
- 网络断在复制中途时，注册/资源步骤不得继续，取消/终止复制执行者后再处理临时产物；原始 NAS 字体绝不删除。
- 成功激活后，本地记录包含或可从权威本地数据恢复 fontId、sourcePath（展示用）、installPath、registryName、激活身份和清理进度。此后取消不通过 sourcePath 的 exists/stat/realpath 重新授权。
- 本地取消仍要验证本机目标真实边界、所有权和注册项指向；不能因禁止访问 NAS 就把全部路径检查删掉。
- 主进程收到取消命令后按本地激活记录解析目标；正常字体源查询不可用时也应可达。单项、批量、退出、启动恢复共用结算规则。

### 7.2 清理阶段和状态

| 状态 | 已知事实 | 后续操作 |
| --- | --- | --- |
| active | 本机资源仍已激活 | 移除本应用资源；失败保留副本和记录 |
| resource-removed | 资源移除已确认 | 删除精确匹配的临时注册项并核验，不碰永久安装 |
| registration-removed | 临时注册项已移除 | 删除本机副本；不存在必须经本地核实后幂等结算 |
| file-pending | 资源和注册项已清理，仅文件占用/删除失败 | 显示“临时文件待清理”，不显示仍激活；复用持久删除队列 |
| cleanup-unknown | 系统调用超时、进程退出或确认丢失 | 保留足够记录，后续本地核验；不先报成功或先删文件 |
| complete | 所需清理事实全部核实 | 移除对应恢复记录，不能清空其他字体的失败记录 |

上表为语义要求，不强迫建立第二份并行状态机；应映射到已有激活/补偿/删除 owner，新增字段必须解释兼容读取。

### 7.3 持久化与极端失败

1. 审核本地激活记录、补偿队列、删除队列的写入原子性与崩溃窗口。禁止原地截断写造成全部记录丢失；复用已有持久化工具或在原 owner 内实现同目录安全替换和串行写。
2. ENOENT 与解析失败、版本不支持、权限错误分开。不能把后三者返回为空并覆盖原文件；保留可恢复原数据并提示诊断。
3. 新字段优先兼容 version 1；必须升级格式时先登记双读、一次迁移、失败恢复和回滚方案。不要凭文件名猜测所有权去删除孤儿。
4. 本地盘满/只读时停止新激活，不能制造无记录资源；退出不能为等待网络继续挂起。若本地保存也失败，显示真实风险并提供返回或明确退出选择，不能声称状态已可靠保存。
5. 清理中的强杀、重复关闭、下一次启动、重复重试必须幂等；晚到的激活成功不能在退出清理之后重新增加未记录资源。

### 7.4 用户可执行的残留处置

- 在现有维护/诊断界面提供最小“临时字体清理”入口，列出字体、失败阶段、最近错误和重试操作；不新增庞大管理页面。
- 能可靠识别占用者才显示进程名；没有可靠证据就提示关闭使用该字体的程序，不能猜测或自动结束第三方应用。
- 只有确证权限不足才提供用户主动触发的提权清理。提权 helper 接受窄身份，重新验证目标，不能接受任意 renderer 路径。
- 资源/注册已处理而文件仍被占用时，提供经过 Windows API 文档及实机验证的重启后删除路径；安排成功与实际删除成功分开记录，重启后核验再移除恢复记录。
- 如果系统仍不释放资源或环境不允许安排删除，明确显示可执行步骤与保留项，允许退出，不宣称“一定无需重启立即清掉”。不自动重启电脑。

## 8. 退出协议与时间预算

### 8.1 退出顺序

1. 生成唯一 quitId，进入 closing；重复关闭加入同一流程，主进程在开始处拒绝新扫描、共享写入和新激活。
2. 停止共享探测、watcher 新事件、预览发布和网络恢复调度；取消未提交任务，隔离已提交网络任务，记录其结果类型。
3. 渲染器只结算已经发起的操作和本地配置保存；共享写入未确认时遵循 §6.2。不能要求 renderer 无限等待在线同步才返回 flushComplete。
4. 按本地记录清理临时资源、注册项和文件，有限重试；每个未完成项已有持久恢复事实。原本必须全清完才退出的策略在此替换。
5. 本机安装状态以实际清理结果更新或标记需重新核验。共享/合并索引只是可重建状态，不进入退出必经路径，不保存供后续重放的共享标签命令。
6. 关闭自有本地句柄、写入日志和关闭标记，终止剩余自有执行进程，退出。日志写入失败不能破坏已有清理记录或形成网络等待。
7. 下一次启动先加载本地恢复状态，再独立探测共享根；不能等待 NAS 才处理上次残留。

### 8.2 待实施的默认预算与测量要求

以下是验收目标，不是本版本已有实测承诺；O-00/O-02 首次实现前固定为集中策略常量，所有实际值和必要调整在执行卡中说明，不能测试失败后悄悄放大。

| 项目 | 默认设计目标 | 计时口径 |
| --- | --- | --- |
| 共享根探测 | 单次 1 秒，每根至多 1 个在途；全局至多 2 个 | 排队单独计时，实际探测有硬期限 |
| 离线自动探测 | 5 秒起，失败退避至 30 秒，加入有限抖动 | 在线不做持续全库轮询，关闭后 0 次 |
| 普通目录/标签/分页读取 | 实际 I/O 3 秒；允许命令明确覆盖 | 扫描/复制另设进度与无进展期限，不套普通读期限误判 |
| 扫描/复制无进展 | 10 秒没有实际字节/文件处理进展则暂停并取消 | 心跳仅说明进程存活，不能冒充工作进展；总任务期限按真实命令登记 |
| 已提交共享写入 | 10 秒等待回执，超时结果未知 | 不等同数据库事务回滚，不触发自动补交 |
| 取消请求宽限 | 1 秒，随后按隔离域终止 | 必须核实自有子进程/任务生命周期 |
| 整体退出 | 用户确认退出后 15 秒内结束应用自有进程 | 从 closing 开始；所有阶段共用单调时钟剩余预算，不逐字体累加 |

退出参考分配：本地结算/保存 3 秒，字体清理 8 秒，进程收尾 2 秒，余量 2 秒。阶段只使用剩余预算；不以“每个字体最多 18 轮”累乘。用户主动停留在数据丢失确认框的时间单列，不能把后台等待伪装成人工等待。

测量分别记录窗口关闭和进程真正退出时间；窗口不可见不等于验收通过。Windows 内核或本地磁盘严重失效无法由应用绝对保证，应明确与“网络永久不恢复、本机正常”这一必过场景区分，不能用系统极端故障借口放弃网络卡死验收。

## 9. 原子任务与实施顺序

每项先填 §12 执行卡，明确精确文件白名单后再改。下述路径是导航候选；必要新 owner 的路径、依赖方向和测试必须提前登记。依赖关系：O-00 → O-01 → O-02 → O-03 → O-04 → O-05 → O-06 → O-07 → O-08。

### O-00：基线、日志与故障复现

- **状态：自动验证通过、实机待验。** 前置已核对；证据与限制见 §16。
- 范围：诊断、故障夹具、现有日志边界和文档；不先混入置灰/退出业务修改。
- 步骤：列出 §4 全部消费者；记录真实后端、线程/进程、网络调用与句柄 owner；复现 UNC 和映射盘断网、永不返回请求、激活后离线退出、误清目录风险；核对副本真实位置及本地记录读写。
- 交付：旧实现失败证据、真实时序、每根访问计数和子进程清单；区分已复现缺陷、代码风险、Windows 待证项。
- 必过：故障注入只作用于临时库/专用共享根；日志无副作用；未修复场景以明确预期失败记录，不修改旧门禁为通过。
- 提交建议：`test(offline): establish shared-root and shutdown fault baselines`。

### O-01：根状态与最后确认目录的单一权威

- **状态：已实现，自动验证通过、实机待验。** 前置：O-00 自动证据齐备；继承 Windows/NAS 缺口，见 §17。
- 导航：startupPathAvailabilityRuntime、folderCacheRootAvailabilityRuntime、sharedKnownTagsRuntime、现有 library shell/schema/read/write owner。
- 步骤：根身份/代次状态机；配置和执行集合分离；映射盘识别；根级快照完整性与部分失败保留；启动离线保留；持久字段兼容策略。
- 不做：UI 全面改版、网络进程终止、离线写队列。
- 必过：一个根离线/全部离线/启动离线/空目录成功/读失败/相同标签来自两根；配置路径和已有目录不能丢；真实 SQLite 重开后保留；旧实现至少一个反例仍被新门拒绝。
- 交付：强类型状态合同、owner 图、准确新增存储字段清单与回滚规则。
- 提交建议：`feat(offline): retain shared roots and confirmed catalogs`。

### O-02：网络任务隔离、超时与取消结算

- **状态：进行中，原生迁移验证环境受阻；尚未通过 O-02 完整门。** 前置：O-01 自动门通过。进程基础及未接入范围见 §18。
- 导航：ioDeadlineRuntime、rustCoreDaemonRuntime、rustCoreDaemonWriteBoundaryRuntime、共享 metadata 前置读取、DB worker 与现有调度器。
- 步骤：逐消费者迁移/证明无主进程阻塞网络 I/O；按根准入；本地清理与网络隔离；取消宽限、终止、旧代次结果拒绝；已提交未知结果保留；共享/本地句柄不能跨所有者误关。
- 必过：真实子进程永不回应/忽略 cancel/退出前迟到返回；两个根一坏一好、本地调用持续可用；读超时可取消，写超时不重写；10 次连续故障后进程、句柄、队列有界；无主进程同步网络调用漏网。
- Native 改动须查实际依赖/API 文档并运行对应 Cargo 测试与 Windows process 生命周期测试，不以 JS mock 替代。
- 提交建议：`fix(offline): isolate stalled shared I/O from local operations`。

### O-03：离线置灰与主进程动作准入

- **状态：已实现，自动验证通过；Windows/NAS 待验。** 用户明确要求先开始 O-03；O-02 前置完整门尚未满足，不能把本项视为隔离/退出综合验收通过。详见 §19。
- 导航：AppSidebarFoldersPage、AppSidebarTagPage、AppSidebarTypes、FontDetailPanel、AppOverlays、fontCommandRuntime、Browse/Library controller、preload、IPC handlers、shared types。
- 步骤：只读状态接线；保留目录/标签/选择；离线提示与真实禁用；详情、右键、键盘、拖放和批量共同准入；本地取消激活入口保留；mixed-root 目标完整性。
- 必过：真实 TSX 事件到主进程拒绝链，禁用样式/aria 状态；直接 IPC 绕过 UI 无副作用；本地标签/收藏/保护正常；旧详情状态合一与 99/100ms 边界保持。
- 协议新增仅限必要可选状态/能力字段和最小事件；两套 preload 同步、缺字段兼容、安全来源校验完整，不能复制一套新 IPC 注册系统。
- 提交建议：`feat(offline): disable shared actions while retaining navigation`。

### O-04：本机副本与源路径无关的取消激活

- **状态：已开始，已建立故障基线；完整实现受 O-02 及原生验证环境阻塞。** 前置仍为 O-02、O-03 自动门通过，用户明确要求先开展 O-04；当前取证不代表前置通过。见 §20。
- 导航：fontActivationCopyRuntime、fontActivationTransactionRuntime、fontActivationVerifyRuntime、fontDeactivationBatchRuntime、fontDeactivationSettlementRuntime、fontActivationInstallStatusRuntime、临时激活记录及路径授权 owner。
- 步骤：梳理本机副本所有权与完整性；复制断网补偿；本地记录独立解析取消目标；去除取消/核验中的 NAS 必需访问；本地结果与可重建网络索引分离。
- 必过：激活成功后所有源路径访问被故障端口拒绝，单项/多项/退出候选仍能本地结算；资源失败、注册失败、混合永久字体、源文件删除、同名不同字体、半文件和目标被替换；原 A1～A8 事务门保持。
- 不以简单改变路径字符串或跳过系统真实核验来通过；新本地入口必须证明授权没有放宽。
- 提交建议：`fix(activation): deactivate managed copies without network access`。

### O-05：持久恢复与残留处理闭环

- **状态：未开始。** 前置：O-04 自动门通过。
- 导航：temporaryActiveFontsStoreRuntime、fontActivationCompensationQueue、temporaryFontDeleteQueue、fontActivationCleanupRuntime、既有维护/诊断入口和必要 native helper。
- 步骤：本地记录原子性和版本错误处理；复用现有队列记录分阶段事实；最小手动清理入口；文件占用/权限错误准确提示；必要的用户触发提权与重启清理；启动核验。
- 必过：每个阶段进程中断、磁盘满/权限拒绝/JSON 损坏/缺文件/未知版本；重开 owner/应用恢复；文件残留不能报仍激活；重复重试不能误删永久字体；重新安装或重新激活后的旧删除任务必须因身份变化被拒绝。
- Windows 专项：占用文件无法立即删时安排重启清理，并实际重启核验；无法执行时标记待实机，不提前“完成”。
- 提交建议：`fix(activation): persist and resolve local cleanup remnants`。

### O-06：整体有界退出

- **状态：未开始。** 前置：O-02、O-04、O-05 自动门通过。
- 导航：windowRuntime、mainProcessLifecycleRuntime、cleanShutdownRuntime、activationInstallStatusSaveQueue、现有 renderer 写入/关闭 owner、watcher 和 daemon shutdown。
- 步骤：实现 §8 单一 closing/quitId；提前关闭准入；本地保存/清理、网络隔离、收尾共用期限；不再因残留恢复窗口无限等待；保留本地保存失败的明确选择；防止迟到激活及重连任务复活。
- 必过：重复关闭、关闭时复制中/激活中/标签写入中、renderer 无回应、worker 忽略 cancel、网络永不恢复、1/100/1000 条清理记录；不能按记录数累加无限时间。窗口/主进程/子进程三者生命周期均有证据。
- 原 shutdown/flush 夹具若约定“残留阻止退出”，只对本书授权变更定向迁移；保存事实、日志耐久性和未提交操作保护不得删除。
- 提交建议：`fix(shutdown): finish local cleanup without waiting for shared roots`。

### O-07：重连校验与恢复使用

- **状态：未开始。** 前置：O-01～O-06 自动门通过。
- 导航：根状态 owner、folderWatcherRuntime、sharedKnownTagsRuntime、sharedMetadataSyncRuntime、useSharedMetadataSyncForegroundRuntime、分页/统计 generation owner。
- 步骤：有限退避探测；相同 rootId 校验；保留旧画面直到需要的数据校验；按根恢复 watcher；读回当前标签/索引；结果未知请求只核验、不重放。
- 必过：断连 20 轮、网络抖动、两根交错、盘符映射到不同库、用户移除根后迟到成功、重连时关闭、其他机器已改标签；没有重复根/重复 watcher/旧值覆盖；没有任何离线共享操作自动提交。
- 用户移除根后必须删除其探测资格，不能因旧请求成功把已移除根加回来。
- 提交建议：`feat(offline): restore validated shared roots without replaying edits`。

### O-08：完整故障矩阵、性能与验收

- **状态：未开始。** 前置：O-00～O-07 自动门通过，所需 Native/Windows 回执齐备。
- 步骤：执行 §10、§11；对同一基线、字体集、窗口与设备比较在线正常操作、离线响应、退出时间；复核全部消费者、权限、持久数据、资源所有权与文档。
- 必过：所有必需实机项有可定位证据，无已知 P0/P1 遗留；自动失败门没有被删除；125 个历史诊断与新增门同时通过；回滚可读历史配置和清理记录。
- 无法取得 Windows/NAS/重启证据时保留“自动验证通过待实机”，不凭日志或 mock 关闭专项。
- 提交建议：`test(offline): close shared-root and local-exit acceptance matrix`。

## 10. 全链路验收矩阵

每条写明起始数据、动作时刻、实际结果、日志身份、存储前后差异和未验证边界。网络故障必须涵盖立即失败与无限等待，二者不能互相替代。

| 编号 | 场景 | 必须证明 | 验证层 |
| --- | --- | --- | --- |
| X-01 | 启动时 NAS 永久离线 | 原根/标签可见且置灰，本地启动不被拖住 | 存储重开＋Windows |
| X-02 | 在线后拔网线/断开共享 | 保留目录、标签、排序、选择；不生成删除 | 状态/真实 UI＋NAS |
| X-03 | `O:\字体` 映射盘不可达 | 与 UNC 同样受控，不绕过探测 | Windows |
| X-04 | 根 A 离线，根 B 在线 | A 灰且保留，B 和本地功能可用 | 集成＋NAS |
| X-05 | 共享标签多根同名、归属未知 | 不删除离线根标签、不执行不完整全局写入 | SQLite＋IPC |
| X-06 | 网络恢复，同一根身份 | 原项目解灰、读回新状态、只创建一次 watcher | UI＋NAS |
| X-07 | 同一路径换成另一个共享库 | 不自动将新库绑定为旧库 | Windows＋身份夹具 |
| X-08 | 恢复前其他电脑改标签 | 读到新状态，旧缓存不覆盖，不重放旧编辑 | 双实例/专用共享库 |
| X-09 | DB/文件 I/O 永不返回 | 主进程仍响应；网络任务可隔离，退出满足预算 | 真子进程＋Windows |
| X-10 | 超时后迟到成功/失败/删除事件 | 不改变新代次状态或清空目录 | 确定调度＋集成 |
| X-11 | 写入提交前断网 | 明确未提交/失败，无自动待办 | 真实事务＋故障注入 |
| X-12 | 写入提交后响应丢失 | 结果未知/已提交分别处理，不能换后端重写 | Rust/SQLite＋IPC |
| X-13 | 激活成功后永久断网 | 字体可用，取消及关闭无源网络访问 | OS spy＋Windows 字体验证 |
| X-14 | 复制到一半断网并关闭 | 不注册半字体，不删除 NAS 源，局部副本可恢复清理 | 原生复制故障＋Windows |
| X-15 | 同名永久字体和临时字体混合 | 永久字体和他人资产不受损 | A1～A8＋Windows |
| X-16 | resource remove 或 registry delete 失败 | 不先删副本、不报成功；其他项按项结算 | 原生失败＋事务门 |
| X-17 | 已停用但本地副本被占用 | 明确 file-pending；可以退出；后续重试/重启完成 | 文件占用＋真实重启 |
| X-18 | 本地记录写失败/损坏/未知版本 | 不能读为空覆盖，停止无记录新激活 | 真实文件系统故障 |
| X-19 | 清理每阶段强杀后再启动 | 本地恢复幂等，不需网络才能恢复 | 真进程终止＋重开 |
| X-20 | 退出遇到 renderer 不响应、worker 忽略 cancel | 不无限等待，有真实进程退出证据 | 集成＋Windows |
| X-21 | 重复关闭、关闭与重连/激活并发 | 单一退出流程，无资源重新激活或后台任务复活 | 确定调度＋OS |
| X-22 | symlink/junction/长路径/大小写/目标替换 | 维持 Stage 2 授权，无越界删除 | PTH 门＋Windows |
| X-23 | 20 次断连恢复循环 | watcher/队列/子进程/订阅数量有界 | 资源计数＋实机 |
| X-24 | 本地标签/收藏/保护及新按钮交互 | 原状态独立、100ms 边界和混合目标正确 | 真实 TSX/IPC/SQLite |
| X-25 | 在线零条标签/用户显式删除目录 | 真空集按原语义生效，不因保留策略永久显示幽灵数据 | 事务＋UI |
| X-26 | 重启清理期间字体被重新激活或路径重用 | 旧任务不能删除新的资源/文件 | 身份变化＋Windows |
| X-27 | 1/100/1000 项清理、网络永久离线 | 整体退出期限不随重试轮数无界放大，残留准确 | 确定时钟＋实机 |
| X-28 | 软件关闭后等待网络恢复 | 没有常驻探测、自动上传或幽灵进程 | OS 进程/连接检查 |

## 11. 自动门、原生门与测量纪律

### 11.1 既有硬门

每个业务原子任务执行与影响相匹配的定向检查并运行 `npm run verify`。变更生产代码时执行三端构建；涉及产物混淆时执行既有混淆。以下命令在制定基线存在，不能删除或降低断言：

```bash
npm run typecheck
npm run diagnostics:all
npm run diagnostics:font-path-policy
npm run diagnostics:font-physical-path-authorization
npm run diagnostics:font-deactivation-batch-settlement
npm run diagnostics:font-activation-compensation
npm run diagnostics:font-activation-batch-transaction
npm run diagnostics:activation-save-queue-durability
npm run diagnostics:rust-daemon-shutdown
npm run diagnostics:shutdown-log-durability
npm run diagnostics:watcher-index-consistency
npm run diagnostics:tag-commit-query
npm run diagnostics:tag-intent-lifecycle
npm run diagnostics:tag-mutation-identity
npm run diagnostics:shared-tag-ops-replay
npm run diagnostics:local-user-state
npm run diagnostics:activation-entry
npm run diagnostics:main-composition-contracts
npm run diagnostics:react-composition-controllers
npm run diagnostics:ipc-sender-validation
npm run verify
node node_modules/electron-vite/bin/electron-vite.js build
node build/obfuscate-dist.cjs
git diff --check
```

定向命令用于定位，不要求在 verify 已覆盖后无理由重复全部。真实 Rust 改动必须执行对应 Cargo 测试和 release build，并记录真实命令/退出码；`npm run verify` 不代替 Cargo。使用真实 package.json 版本，不为修复顺手升级。

### 11.2 拟新增长期门（目前尚不存在）

O-00/O-01 开工时登记准确文件和 npm script；实施时接入 `diagnostics:all`/`verify`，不能仅在文档里列名称。

| 建议门 | 覆盖 |
| --- | --- |
| `diagnostics:shared-root-offline` | 根状态/身份/代次、UNC/映射盘、目录保留、部分失败 |
| `diagnostics:shared-offline-actions` | 真实 UI 到 IPC、快捷键/拖放/混合目标、离线拒绝 |
| `diagnostics:shared-io-isolation` | 真子进程超时/cancel 无效、进程终止、共享与本地隔离 |
| `diagnostics:local-activation-offline` | 无源路径取消、半复制、永久安装保护、逐项结果 |
| `diagnostics:temporary-cleanup-recovery` | 本地耐久、记录损坏、崩溃恢复、旧删除身份拒绝 |
| `diagnostics:bounded-local-exit` | 统一预算、重复关闭、迟到操作、renderer/worker 无回应 |
| `diagnostics:shared-root-reconnect` | 相同根恢复、换库拒绝、watcher 唯一、无离线写重放 |

- 不只匹配日志字符串、源码 needle 或自己复制算法；加载生产模块，从真实入口到副作用边界验证。
- 每个原故障保留旧实现失败输出；至少一个退化变异恢复旧行为后必须失败。
- 正常失败、取消、超时、提交未知和晚到成功分别建例；fake timer 证明策略边界，真子进程与实机证明 I/O/系统能力，两者缺一不能声称硬超时有效。
- 真实 SQLite/文件测试使用临时目录，重开句柄/进程验证持久结果；不能只断言内存 Map。
- LF/CRLF、正反斜杠、路径空格、无管理员权限均纳入已有兼容门；只迁移被授权改变的冻结字段，记录旧值、新值和行为证据。
- 诊断与故障注入只在测试端口、临时数据或显式开发测试环境启用；生产不得出现任意路径删除、故障注入 IPC 或绕过安全检查的开关。

### 11.3 日志与性能

复用现有 operation trace 和 startup/performance logger。必要字段：rootId/rootKey、generation、requestId、quitId、command、queuedMs、ioMs、deadlineMs、cancelRequested、workerExited、outcome、pendingLocalCleanup、unknownWrites、phase。operationId/attemptId 沿用既有语义，不拿日志 ID 当业务幂等证明。

日志必须能串起：在线 → 请求失败/超时 → 离线禁用 → 本地取消 → 关闭期限 → 实际进程终止；以及离线 → 探测 → 身份校验 → 恢复 → 一次 watcher 注册。默认限频，详细日志有界；不得记录凭据、整份标签内容、字体二进制或完整大快照。

每场景在线/离线至少 30 个同条件样本，冷启动单列；记录样本数、中位数/P95、最高退出耗时、主进程长任务、进程/句柄/队列峰值。耗时基准必须来自真实测量，不预填改善比例。O-08 在线正常操作的 P95 若有明确退化，应定位原因并修复或登记具体范围和依据，不能只依靠“没感觉卡”。

### 11.4 Windows 开发模式验收

用户继续用 `npm run dev`，不要求 build:win 或重装。准备独立测试共享根、本地测试字体副本和另一可用根；不得切断正在写生产数据的 NAS 来做破坏性测试。

按 X 矩阵记录 Windows/Electron/Rust 版本、HEAD、字体数量、UNC/映射盘类型、权限、断网方式、在途动作、日志片段和窗口/进程时间。分别用共享路径拒绝、网络丢包/黑洞、真实服务不可达覆盖故障，避免只测试快速返回的“找不到目录”。重启清理需用户在合适时机实际重启后核验；未执行明确挂起该验收项，不自动重启设备。

## 12. 强制执行卡与交付格式

每项开工前补齐以下内容，路径必须精确，禁止“及其他相关文件”兜底。实际影响扩展时先更新理由/职责/测试再继续既有授权范围的工作，不为常规接线反复询问；新增功能、依赖或破坏性格式迁移不得自行扩张。

```text
任务/状态/日期：
实际 HEAD / 远端 / 分支 / 工作树：
前置任务及继承的 Windows/Native 缺口：
需求编号、不变量、对应 X 矩阵：
旧行为证据、复现命令及输出：
精确生产文件白名单：
精确诊断/fixture/文档白名单：
新增/调整 owner、输入输出、状态及句柄所有权：
协议/存储字段及旧版本读写兼容：
截止时间/取消/结果未知/代次处理：
真实模块与受控外部端口、不能证明的部分：
验证命令、退出码、用例数、反例/变异：
Windows/NAS/原生及重启证据：
差异与权限审查、性能变化：
README/任务状态、提交、推送、回滚定位：
插件实际结果与失败记录：
```

每个原子任务独立提交并按已有授权推送原分支；禁止强推、覆盖用户工作、把纯搬迁与功能修复混成大提交。代码、测试、精确文档状态必须同批可审查。技术细节入任务书，结果与兼容影响入 README。

## 13. 兼容、迁移、回滚与停止条件

### 13.1 兼容要求

- 保持字体 ID、sourceId、共享根身份和路径规范化；缓存旧数据不等于允许旧授权票据。
- 共享 DB schema 与标签格式本专项默认不变；不得为离线禁用新增共享 tombstone 或清空业务表。
- 必要本地状态/清理阶段扩展先列旧数据读取、缺字段默认、错误恢复、并发写和回滚策略；离线标记不会在旧版本中解释成删除。
- 新状态事件仅传最小可序列化 DTO，类型在 main/preload/renderer 对齐，两套 preload 能力一致；缺失能力时显示明确保守状态，不能重新开启绕过网络隔离的旧执行路径。
- 保留 Rust 已提交写入禁止 fallback 的边界；任何新增 helper 协议都需版本/能力协商与缺能力行为测试。

### 13.2 回滚单元

以 O-xx 独立提交为单位。可按反向依赖回滚 UI/调度修改，但回滚前必须检查新版产生的本地清理记录是否仍可被旧版读取和正确恢复。不能只回滚代码后删除新记录“解决兼容”；存在未完成清理时先完成本地结算或保留兼容恢复入口，再回退数据相关模块。

断网状态仅清除临时执行状态，绝不以回滚为由删除监视根、共享标签目录、源字体或未知提交证据。不得使用破坏性 reset 清除用户已有变更。

### 13.3 停止条件

- 自动门失败、冻结迁移没有行为依据、只能通过删除断言或加长 TTL 才过。
- 尚有未隔离的主进程网络同步调用，但实现声称退出已完全有界。
- 超时写入被自动重放、旧代次覆盖新状态、断网被当删除、存在无界进程或重试。
- 本地清理访问网络源、删除权限放宽、永久字体受影响、残留记录可能丢失。
- 主进程退出了但自有 worker 无限存活，或本地资源清理被网络 worker 连带中断且未记录。
- 需要增加无关依赖/完整离线同步系统/新全局状态库，或数据迁移缺兼容与回滚。
- Windows 实测与受控测试矛盾时暂停推进，先解释并修复；不能让后续任务掩盖。

出现以上问题，保留现场和证据，回到当前任务修复；不可宣称阶段完成。环境缺口可记录为待实机继续独立设计，但最终 O-08 必须收齐证据。

## 14. 工具协议与本次文档交付

- 实施遵守根目录 ALL_AI_CODE.md、AI_PROJECT_RULES.md、AGENTS.md；与旧专项的任务特定范围不同之处以用户最新需求和本文明确覆盖项为准，不能削弱通用安全/验证要求。
- Context7：实施涉及新 Windows/进程 API、第三方依赖或兼容疑问时先核对仓库实际版本，再查对应官方文档；本次仅源码核查与制定任务，没有选择未验证的新 API 实现。
- Mermaid Chart：本次已绘制实际存在的关闭 → renderer 保存 → 本地清理 → 状态保存/索引同步 → 停止进程链，指出当前网络依赖；本书目标状态表均标为待实现。实施后更新真实链路，不把设计图伪装成已运行架构。
- Create State：沿用此前容量 2/2 后跳过的既定约定；Git、README 与本文负责交接，不因此阻塞文档交付。
- 本次交付只新增本任务书并更新 README、总任务书和旧操作任务书的衔接说明；检查路径、文档链接、npm 命令存在性、任务覆盖和 diff。没有运行本专项业务验收，也不把历史 125 项通过写成本次功能通过。

## 15. 任务状态登记

| 任务 | 状态 | 实施提交 | 自动验证 | Windows/NAS/原生 | 备注 |
| --- | --- | --- | --- | --- | --- |
| O-00 | 自动验证通过、实机待验 | 本节同批提交（Git 可追溯） | TypeScript、126/126；8 项已知问题观察、5 组对照 | 待验 | 证据与消费者清单见 §16，非修复完成 |
| O-01 | 自动验证通过 | 本节同批提交（Git 可追溯） | TypeScript、127/127、LF/CRLF、旧反例、三端构建与混淆 | 待验 | 根状态与目录保留，见 §17 |
| O-02 | 进行中，部分业务已接入 | §18.4 接续提交 | 接线专项及构建通过；全量回归记录见 §18.5；完整 O-02 门未通过 | 待验 | 七项请求与目录探测已切换，旧迁移等消费者仍待迁移 |
| O-03 | 已实现、实机待验 | 本节同批提交 | TypeScript、129/129、定向 40 组及构建通过 | Windows/NAS 待验 | 置灰与完整动作准入；O-02 前置仍未满足 |
| O-04 | 故障取证完成、实现受阻 | 本节同批提交 | 5 缺口观察/4 对照；完整门未通过 | 待验 | O-02 隔离及原生验证待补齐，见 §20 |
| O-05 | 未开始 | — | 未执行 | 未执行 | 持久残留与处置入口 |
| O-06 | 未开始 | — | 未执行 | 未执行 | 整体有界退出 |
| O-07 | 未开始 | — | 未执行 | 未执行 | 校验后恢复，不重放编辑 |
| O-08 | 未开始 | — | 未执行 | 未执行 | 28 项 X 矩阵与收尾 |

继续执行入口：O-02。先恢复原生迁移验证条件，完成所有消费者隔离后再进入 O-03；Windows 待证项持续登记，最终验收不得跳过。


## 16. O-00 执行卡

- 状态：自动验证通过、实机待验；起点 `117b08470b55556d9c066da618e4afaf7947178a`，原分支，工作树干净。
- 精确生产白名单：无。复用已有日志，不为基线引入业务状态、网络探测或新 IPC。
- 精确诊断/配置白名单：新增 `build/diagnostics/check-shared-offline-baseline.cjs`；`package.json` 注册只读基线诊断。
- 精确文档白名单：README.md、本任务书、HFM_REMEDIATION_MASTER_TASKBOOK.md（均位于原目录）。
- 复用 `check-operation-chain.cjs` 的 TS 模块加载器；网络/Windows/Electron 使用明确受控端口，SQLite/临时文件/测试子进程为真实资源。新观察器输出逐项证据与已知缺陷标签，不能用观察器成功代替修复成功。
- 计划复现：映射盘跳过探测、UNC 失败抑制、部分共享标签回读覆盖、Promise 超时后子进程仍运行、退出受根定位/索引同步阻塞、清理残留阻止退出、损坏本地激活记录被视为空。另保留本机副本和已有保护路径的正向对照。
- 所有注入只作用于模块加载端口、临时 SQLite/文件和由测试创建的子进程；不访问用户 NAS、不注册/删除系统字体。真实 Windows 映射盘/字体资源与 SMB 黑洞测试待回执。


### 16.1 消费者与执行/句柄清单

下表逐项覆盖 §4 消费者。线程/进程按源码边界识别；本轮未接真实 Windows daemon/NAS，不把源码路由列作实机进程证据。“拟处置”仅供后续 O-01～O-07，不表示已实施。

| 消费者 | 当前入口/传递路径 | 执行及 I/O、句柄 owner | 现有控制及缺口 | 拟处置 |
| --- | --- | --- | --- | --- |
| 根探测与目录缓存 | startupPathAvailabilityRuntime → folderCacheRootAvailabilityRuntime | main 发起 fsp.stat；模块级可用性 Map | UNC 500ms/TTL；映射盘未探测，期限不终止 I/O | 根级统一准入、映射盘识别、隔离探测 |
| watcher | folderWatcherRuntime.startWatchingFolders/flushPendingFolderChanges | main 的 fs.watch/stat；运行时持有 FSWatcher、timer、generation、恢复批 | 有 generation 与停用清理，缺统一每根离线状态；错误不是删除证据 | 离线停止该根事件应用，保留配置，恢复单一 watcher |
| 扫描 | scanOrchestrator → scan-orchestrator/scanListingRuntime → font index worker | Rust 路由优先；indexListWorkerSourceRuntime/scanWorkerSourceRuntime 的 worker_threads 为兼容执行端 | 已有工作进度/调度，不能据此认定取消系统阻塞有效 | 实际根准入、网络隔离、进度期限，不自动扫空写删 |
| 手动刷新 | manualFolderRefreshRuntime → manual-refresh/manualWatchedFolderRefreshRuntime、manualFolderRustListingRuntime | 主进程编排、Rust listing/索引写入及缓存 repair 端口 | 错误恢复与快照需逐根验证完整性 | 离线拒绝、保留旧快照，恢复后新鲜读取 |
| 路径授权/文件动作 | fontPathAuthorizationRuntime → realpath/stat、权威根/索引端口 | main 发起 fsp；消费者拥有后续文件动作 | 安全拒绝已有，等待网络本身仍在主线程发起 | 网络授权隔离；本地取消使用独立托管身份，不取消权限检查 |
| 共享标签目录 | mainOperationsCompositionRuntime.startStartupTasks → sharedKnownTagsRuntime | 启动延迟 1500ms 后默认参数刷新；Rust metadata read，兼容 main SQLite；本地 library owner 保存 tags | B02 默认部分根路径真实删除本地目录项；显式 preserve/requireFresh 是正向对照 | 根级保留和完整性标记、离线禁用 |
| 共享绑定/批量/重命名/删除 | sharedFontMetadataMutations → sharedMetadataMutationRuntime/LockRuntime → Rust/显式兼容 | main 锁文件 fsp.open/stat，共享 SQLite 由 mutation owner/原生端执行并按借用规则关闭 | 提交/刷新结果已有区分，未知写不能重放；锁与前置 I/O 仍需隔离 | 提交前准入，已提交保留结果未知，只核验不补交 |
| 共享 metadata 覆盖/同步 | sharedMetadataOverlayRuntime → openSharedMetadataDb/回放；sharedMetadataMergedIndexSyncRuntime | Rust 前置有 main 同步 SQLite；共享 DB 自有句柄在 finally 关闭 | 外层 Promise deadline 不能中断同步 SQLite | 网络 open/query/close 隔离，不改共享事务语义 |
| 预览读取/发布 | previewCacheRootAvailabilityRuntime、previewSharedStorageCircuitBreakerRuntime、现有 preview cache owner | main 发起共享根 stat，缓存/渲染经原 worker/原生执行端；存储 owner 管 DB | 已有预览熔断与本地缓存，不是全应用根状态；缓存写失败不能当根全失联 | 本地命中继续可用；共享读取/发布暂停，不清空本地缓存 |
| 分页/ID/统计 | fontQueryFacadeRuntime → merged-page worker/ runRustMergedIndexIdsQuery/runRustMergedIndexMetricsQuery | Rust daemon 路由；兼容 DB worker 为 worker_threads（dbQueryWorkerClientRuntime） | 标签 revision/generation 已有；主进程 fallback 和外部 metadata 检查需纳入 | 未确认快照保留，离线不新发网络查询，恢复拒绝迟到结果 |
| 安装状态读/写 | install/status/installStatusReadRuntime、installStatusWriteRuntime → rootForFontPath → worker | main 根定位/分组，Rust/DB worker 执行；fallback main SQLite 受策略控制 | 在选择 worker 前已经需要源根定位 | 本地取消结果独立，网络状态可重建，不阻塞退出 |
| 安装状态保存队列 | activationInstallStatusSaveQueue.flush → read/save → rootForFontPath → syncMergedIndexAfterInstallStatusRefresh | main 内存 pending/in-flight 与重试 timer；依赖端口负责 DB | B03/B04 真实 queue 与 lifecycle 组合可被未返回端口卡住 | 退出只结算本地事实，根校正移出退出必经链 |
| 数据库维护/备份 | maintenance/databaseBackupRuntime、applicationDatabaseMaintenanceRuntime | main exists/stat、Rust backup；显式兼容 spec.open 句柄由维护 owner 关闭 | 保留已有维护串行保护；共享 backup 前置访问也需准入 | 离线共享维护禁用，本地维护保留，关闭时有限结算 |
| 渲染器关闭保存 | runtime/app/effects/useAppFlushOnUnloadRuntime → flushApplicationState → windowRuntime | renderer 写队列/库保存；main close request/12 秒 timeout/dialog | 本轮没有真实 DOM/renderer hang 复现；现有 gate 保留 | 不等未确认网络写无限返回，真实 IPC 关闭流程 O-06 验证 |
| 主进程退出 | mainProcessLifecycleRuntime.before-quit → cleanup → save queue → stop watchers → will-quit | app 生命周期 owner；stopRustCoreDaemon、dbQueryWorkerShutdown 负责各自进程/线程 | B03～B05 可复现未到 stop/quit；不是 Windows 真退出测量 | 单一预算与 closing 准入，本地记录残留后可退出 |
| 本机副本/残留 | fontActivationTransactionRuntime → CopyRuntime → currentUserFontsDir；Cleanup/Verify/store/delete/compensation | Windows 本机用户 Fonts、HKCU、原生资源；本地 JSON 由各自 store/queue 唯一管理 | B06 损坏读为空，B07 fileExists 纳入 stillVisible；不能混称注册残留 | 保留所有权，分阶段事实和原子持久，O-04/O-05 修复 |

源副本位置已核对：`fontActivationTransactionRuntime` 用 `currentUserFontsDir()` 与安全临时名生成 dest，后者来自 LOCALAPPDATA 下 Microsoft/Windows/Fonts。现有副本不在用户正式共享字体库中；本轮没有改路径或建立第二个副本。恢复文件分别为 `temporary-active-fonts.json`、`pending-font-activation-compensations.json`、`pending-temporary-font-deletes.json`，都由既有本地 owner 管理。

### 16.2 可执行基线证据

观察器直接加载实际 TS 生产模块。默认通过 Git 读取制定基线的生产源码（包括加载到的内部依赖），用当前未修改的测试 loader 执行；后续修复不会被要求继续保留缺陷。`--current` 复核当前源码，后续任务须将对应场景迁为新正确性门；它不注册为强制保留旧缺陷的长期门。

| 观察 | 已复现结果 | 证据强度与后续归属 |
| --- | --- | --- |
| B01 | `O:\fonts` 返回可用，stat 调用 0 次 | 实际根策略，受控路径端口；不是 Windows 映射盘实测。O-01 |
| B02 | 根 A 离线/根 B 在线；原 tags 两项变一项，重开真实 SQLite 连接仍只剩在线标签 | 默认参数；startup tasks 存在真实默认调用。不能宣称所有调用都会丢。O-01 |
| B03 | 本地 cleanup 端口完成后，根定位 Promise 不返回：queue 在途、app.quit 未调用、watcher stop 未执行 | 实际 lifecycle＋queue；外部 OS 清理及网络端口受控。O-04/O-06 |
| B04 | 根定位完成，索引同步 Promise 不返回：同样阻止退出；释放端口后可正常结束 | 同 B03；排除测试忘记触发退出的假阳性。O-02/O-06 |
| B05 | cleanup 返回 remaining=1，恢复窗口一次，退出次数 0 | 实际现有政策，与新需求不符；不称作原设计意外崩溃。O-05/O-06 |
| B06 | 真实临时激活 JSON 损坏，load 返回空记录；只读时原损坏文件仍保留 | 已证明错误被解释为空，未声称本次读取已经覆盖原文件。O-05 |
| B07 | 本地文件存在、系统枚举端口为空，stillVisible 返回 true；删掉测试文件后 false | 证明当前核验合并文件/资源事实，非真实 Windows 资源状态证据。O-05 |
| B08 | 实际 withIoDeadlineResult 超时返回，真实测试 Node 子进程仍活着 | 证明 deadline 不负责终止执行者；测试 finally 杀自己创建的进程并观察 close，存活数回到 0。O-02 |

五组正向对照：C01 UNC 错误返回不可用且 TTL 内重复探测只一次；C02 显式保留目录成功、requireFresh 对部分根拒绝；C03 正常退出按 cleanup→delete flush→status flush→watcher stop→log flush→quit；C04 本地记录重开能读取、真实副本在测试源删除后仍可读；C05 子进程 close 被确认且无残留。C04 的 Rust copy 端口由真实本地 fsp.copyFile 替换，不能当作真实 Rust/Windows 激活成功。

B03/B04 注入期间实际顺序为 `prevent-quit → cleanup-local → delete-flush → status-flush`；状态队列根定位访问计数为 1，根定位或同步释放前退出仍为 0。观察器同时输出生产 before-quit 日志和测试边界事件，二者明确分开；未伪造 production operationId 或 quitId（现版本没有后者）。

B08 每次输出实际 childPid 与实测 elapsedMs，不写成固定性能门或 P95；100ms 是该测试主动设置的最小 deadline，不是应用新增网络策略。实际 Windows daemon/shared I/O 的进程数、handle 数、15 秒退出目标及 30 样本性能仍待 O-02/O-08 实测。无网络连通探测接触用户系统。

### 16.3 运行方式与基线门语义

```bash
npm run diagnostics:shared-offline-baseline
node build/diagnostics/check-shared-offline-baseline.cjs --crlf
node build/diagnostics/check-shared-offline-baseline.cjs --current
node build/diagnostics/check-shared-offline-baseline.cjs --current --strict
npm run verify
```

- 前三条观察器成功时退出码 0，报告 8 项 KNOWN_DEFECT、5 组 CONTROL_PASS、businessCorrectnessPassed=false；表示基线取证有效，**不表示共享离线功能已通过**。
- `--strict` 使用同一执行证据，在已知问题存在时明确返回 1。已实际运行确认，不能把这个预期失败隐藏为业务绿色门。
- 默认只读基线观察接入 diagnostics:all，不删除原 125 项诊断。后续修复要新增/提升对应正确性断言；不得以 pinned baseline 代替当前源码门。
- LF 和 CRLF 两种真实模块编译加载完成；fixture 使用 Node SQLite/真实临时文件，最后清理。脚本有 15 秒整体保护，测试子进程有 5 秒保护和 finally 所有权清理；没有系统字体/注册表副作用。
- 初次脚本解析因测试端口对象缺一处闭合括号而失败，已修正；这是夹具构建错误，没有调整生产代码或删业务断言。后续当前源码与 pinned/LF/CRLF 均产出一致分类。
- 日志只增加测试报告，生产 logger 未改，不引入业务影响；真实运行日志在 scratch 临时输出，关键证据、命令和边界已保存本文。

### 16.4 验证、兼容与交接

- `npm run verify` 实际退出码 0：TypeScript 通过，126/126 诊断通过，原 125 项全部保留；新诊断成功只证明历史问题可复现。
- pinned 默认、CRLF、当前源码观察各自退出码 0，均为 8 项已知问题及 5 组对照；当前源码 `--strict` 实际退出码 1，为预期缺陷证据。`node --check`、`git diff --check` 通过。
- 观察器默认依赖 Git 中的 `117b08470b55556d9c066da618e4afaf7947178a` 生产源码；运行环境需保留该历史对象。缺失时明确失败，不能降级为当前源码假称历史基线。
- 本轮无生产、Rust、IPC、依赖、数据库格式或字体目录变更；未运行新一轮打包、Cargo 或 Windows 实机，不复用历史构建冒充本项验收。回滚单位为本次诊断、脚本注册与文档提交，无数据迁移。
- 真正的 Windows 映射盘/UNC 断网、SMB 永不返回系统调用、系统字体资源与注册表清理、渲染器关闭及应用自有进程真正退出仍待实测；受控端口和测试 Node 子进程不能替代上述证据。
- O-01 依据 B01/B02 开始根状态与最后确认目录设计；O-02 接管真正隔离与回收；O-04～O-06 接管本地取消、残留和退出。各项须使用当前实现的正确性测试，不将本观察器当成修复门。
- 现有按钮合一、100ms 防连击和标签提交契约不变；不新增离线同步。工具协议沿用 §14，已补绘真实退出等待链；Create State 按既定容量跳过约定执行。

## 17. O-01 执行卡

- 状态：自动验证通过、实机待验；起点 `3cfc5716a5971e588270a44bd872a5d0da61c749`，原分支，工作树干净；仅执行 O-01。
- 生产白名单：`src/main/path/startupPathAvailabilityRuntime.ts`（根状态/代次）；`src/main/path/pathCanonicalizer.ts`（复用映射表的异步识别）；`src/main/folders/folderCacheRootAvailabilityRuntime.ts`（明确配置集合）；`src/main/library/sharedKnownTagsRuntime.ts`（实际读回与完整性）；新增 `src/main/library/runtime/sharedRootCatalogRuntime.ts`（现有 library DB 的根目录保留元数据）。
- 诊断白名单：新增 `build/diagnostics/check-shared-root-retention.cjs`、`package.json` 注册；必要时仅扩充已有诊断的真实端口/持久库夹具，事先记录具体文件，不删除旧断言。O-00 固定历史观察不变。
- 文档白名单：README、本任务书、总任务书。
- 存储计划：现有本地 `meta` 表新增一个 `sharedRootCatalog` JSON 值，不改共享库或 schemaVersion；记录版本、按规范根路径的确认目录/签名/确认时间及未归属旧目录。状态和代次仅内存，重启不继承在线授权。新元数据与 tags 在同一事务提交。
- 兼容：无根归属/元数据损坏/不支持版本时保留当前 tags；仅完整成功刷新解除未知归属。旧版忽略新增 meta；回退再升级时重新核对目录。签名是读取版本，不冒充共享库稳定身份；重连身份核验仍属 O-07。
- 根路径识别使用已有 Windows 映射表语义、异步子进程和缓存；失败时对盘符路径保守探测，不默认在线。目录 stat 的真正网络执行隔离仍属 O-02。
- 必验：单根/全根离线、重启离线、真实空目录、读取错误和 metadata:error、同标签双根、迟到与并发、真实 SQLite 重开/事务失败、旧反例拒绝、LF/CRLF、原全部回归。

- 诊断白名单补充：`build/diagnostics/check-local-user-state.cjs` 的 knownCatalog 夹具补齐真实根状态读取与 Rust 根级回执字段，保留原删除/离线断言；原因是旧夹具仅模拟全局 tags，不能验证新增完整性合同。


### 17.1 实际 owner、状态与数据链

- `startupPathAvailabilityRuntime` 是本轮根可用性状态的唯一内存 owner，导出只读 `SharedRootAvailabilitySnapshot { rootId, state, generation, lastError? }`。路径使用既有去设备前缀、大小写/斜杠规范化；已识别映射盘与 UNC 共用根键。状态为 checking/online/offline/recovering，每次探测或失效推进代次；旧探测不得把新 offline 改回 online。健康 online 根复查期间保持 online；离线 TTL 到期后的实际重试进入 recovering。
- 映射表复用 pathCanonicalizer 的缓存，新增 `mappedDriveTableAsync` 用 `execFile(net.exe, ['use'])` 异步识别；无 shell、1500ms 进程超时、并发合并，成功缓存 30 秒、失败抑制 5 秒。修正盘符冒号后原单词边界导致识别失败，并保留共享名中的单个空格。未知盘符仍做目录探测；已知映射丢失或换目标时拒绝恢复旧根身份。
- 目录探测沿用现有 500ms 默认值及环境参数，离线抑制默认 30 秒，成功缓存沿用 1～5 秒；本轮没有把设计目标 1 秒/15 秒伪装成实测承诺。普通本地根也确认目录，避免把根状态留在 checking；这不是所有本地动作的准入锁。
- `filterFolderCacheAvailableRoots` 明确返回 configuredFolders（原配置全集）、folders（本次可执行集合）、skippedFolders（不可执行集合）。持久配置和节点表仍由现有 library owner 管理，本轮不将可执行集合写回配置。
- `sharedKnownTagsRuntime` 使用根覆盖和代次验证实际 Rust 回执，按 rootPath/dbPath 对应读取成功项；metadata:error、缺项、重复项、缺失签名不能作为空目录。metadata:none 仅在真实 stat 明确 ENOENT 且根目录仍可读时确认为空；I/O 错误、权限拒绝和目录消失不等价于零标签。
- 旧 aggregate-only 回执只能增加/保留未归属项，不能证明全量为空；requireFresh 明确拒绝。当前 Rust client 已传递 roots；本轮没有修改原生协议。显式 Node 兼容读同样逐根保留失败项，非法 JSON 不再降为空数组；共享句柄始终由读取 owner 在 finally 关闭，本地库借用句柄不关闭。
- 新 `sharedRootCatalogRuntime` 只负责现有本地库中的确认目录读取/合并，不执行网络、不保存离线编辑、不拥有新 DB 或写队列。已确认根用新结果替换，未读根保留旧结果；同名标签取并集。没有归属证据或目录被旧版本/其他合法写入修改时，保守回到现有 tags。
- 目录读取使用请求 revision 与根 generation 双重检查，发布前再次核验；新请求或根失效后晚到的目录不写库，requireFresh 不报告成功。零绑定重命名/删除失效时明确返回 superseded，读取失败时不能假称“没有绑定”。
- 已使用 Mermaid Chart 绘制实际 owner 链：配置 → 根状态 → 可执行集合 → 根级读回 → 完整性/代次检查 → 确认目录合并 → 本地事务。图没有包含尚未实现的 UI 置灰、硬隔离或退出协调器。

### 17.2 持久字段、兼容和回滚

仅新增本地 `meta` 表键 `sharedRootCatalog`，值为：

| 字段 | 含义 |
| --- | --- |
| version = 1 | 本地记录格式；缺失、损坏或未知版本回退到现有 tags |
| roots[].rootId | 已配置规范根路径，非字体 ID、非新共享库 UUID |
| roots[].tags | 该根最近完整确认的标签名集合 |
| roots[].signature | 原读取签名或 node-confirmed；仅表示读取版本，不能证明服务器身份 |
| roots[].confirmedAt | 确认时间，非激活时间或清理租约 |
| unattributedTags | 未确认根归属的旧目录/保留项，不能据此准许跨根写操作 |
| publishedTags | 与 tags 的一致性检查；旧版本或其他写入更改 tags 时自动退回保守模式 |

- `tags` 变化与该 meta 值在同一个既有 library 事务提交；目录没变化时不反复删除/插入 tags。事务失败时二者一起回滚，不出现目录已更新但归属没保存。
- 不改 schemaVersion=100、共享 SQLite 格式、字体 ID、绑定数据、收藏/保护/本地标签、现有根配置格式或软件版本。新增元数据不放入会被设置保存全量重写的 app_state。
- 回滚只回退本次代码/测试/文档提交；旧版忽略额外 meta，不要求删除它。再次升级时若 publishedTags 与当前 tags 不一致，旧归属失效并保留当前目录。完全在线且读取完整后正常删除仍生效；离线未确认时不利用 dropTags 删除未知归属项。
- 保存的只是最近确认目录，不含用户离线写操作、补交命令、字体副本或同步队列。

### 17.3 定向证据与实际限制

- 新命令 `npm run diagnostics:shared-root-retention` 已注册进 diagnostics:all。LF 默认 17 组（含旧实现负例），CRLF 16 组运行行为；加载真实 TS owner、真实临时 SQLite 和文件，只替换 Windows/网络等外部端口。
- 已覆盖状态迁移/别名/并发探测/迟到、映射盘异步识别与失败缓存、旧归属保留、单根空目录更新、双根同名标签、SQLite 重开、全离线启动、配置与节点保留、metadata:error、全量空集、旧 aggregate 协议、损坏元数据、事务回滚、并发请求/根失效、真实空目录、Rust 读取失败、显式 Node 真实 SQLite 与句柄关闭、零绑定改名/删除。
- `--baseline` 实际加载 `3cfc571` 的旧共享目录 owner，同一保留断言退出码 1：实际 `[A, both]` 缺失预期的 legacy。LF 默认自动确认该负例；不是用日志文字冒充故障。
- 原 local-user-state 夹具补齐根状态和完整 roots 回执，原“删除最后标签、离线不删、剩余绑定仍保留”的断言未删除。第一轮回归在未补齐端口时明确失败；修正夹具后通过。新诊断首次缺 db.exec 适配也明确失败并修正，没有放宽生产行为。
- 根目录探测依然是 main 发起的异步 fs I/O；旧同步映射/路径规范化调用点仍存在，网络 SQLite 的真正隔离、系统调用硬期限和关闭子进程证明归 O-02。不能把 execFile 的 timeout 当作全应用进程回收证明。
- roots 签名不是 NAS 稳定库身份；跨重启换库识别、恢复 watcher、事件代次传播及 UI 动作准入仍归 O-03/O-07。O-01 的 online 表示目录可读证据，不能独立充当共享写授权。
- Windows 映射盘、真实 NAS 黑洞、网络永不恢复下本地字体取消/残留/进程退出仍待对应任务实机验证。没有声称 O-01 已解决网络卡死退出，也没有修改字体激活/清理逻辑。
- Context7 已结合仓库 @types/node 24、Electron 42 核对 Node 24 execFile 异步/timeout/shell 语义；使用现有 API，不新增依赖。Create State 沿用容量 2/2 后跳过的既定约定。


### 17.4 验证与交接登记

- 对应需求：UO-01/UO-02 的根配置与目录保留基础、UO-03 的代次和路径身份基础、UO-04 不新增离线编辑；覆盖 X-01/X-02/X-03/X-10/X-25 中的本轮目录行为。完整 UI/进程矩阵仍在后续任务验收，不能据本项关闭 X 矩阵。
- 构建已实际通过 Electron/Vite main/preload/renderer 368/1/200 模块，混淆 3/3；无 Rust 源码变化，未运行或宣称新 Cargo release、原生字体实测、安装包验收。
- 性能仅有受控证据：同根并发探测合并为 1 次 stat，映射识别成功及失败缓存均抑制重复子进程调用；不填真实 NAS/P95 改善比例。在线完整结果的确认时间仍会更新本地 meta；目录内容未变时不重写 tags。
- Windows 继续用 `npm run dev`；后续实测先用独立共享根，分别检查首次离线启动、一个根断开、metadata 不可读、恢复后标签目录。UI 置灰和网络永久不可恢复时安全退出不是本次已交付能力。
- 回滚单位：本执行卡对应的独立提交。下一项 O-02 尚未开始；不得跳过对遗留同步路径规范化、网络 SQLite 及进程退出的隔离检查。


最终执行结果：`npm run verify` 退出码 0，TypeScript 与 127/127 诊断通过；定向 LF 17 组、CRLF 16 组退出码 0，`--baseline` 预期退出码 1 并精确检出 legacy 丢失。三端构建和混淆分别退出码 0，`git diff --check`、11 文件精确白名单、文档链接与脚本注册检查通过。原 126 项门全部保留，未删断言或放大超时。Windows/NAS/原生及真实断网退出仍为待验，不以自动门代替。

## 18. O-02 执行卡

- 状态：实施中；基线 `dfdec2f26103a65d53fd86bc1534c58861561c71`，原分支，初始工作树干净。执行 O-02，不提前实现 O-03 UI 或 O-06 退出策略。
- 已确认两个独立缺口：daemon cancel 只释放调用方而未回收执行者；共享 metadata 的 legacy/replay preflight 与部分 fallback 仍在 main 打开同步 SQLite。禁止仅修前者便声称 O-02 完成。
- 第一批生产白名单：新增 `src/main/path/sharedIoProcessRuntime.ts`（有界进程与任务所有权）、`src/main/rust-core/rustSharedIoCommandRuntime.ts`（Rust 命令隔离分类）；`src/main/rust-core/rustCoreWorkerTransportRuntime.ts`（实际调度接线）。后续前置 I/O 迁移按消费者登记准确扩展文件。
- 第一批诊断白名单：新增 `build/diagnostics/check-shared-io-process.cjs`，package.json；文档为 README、本任务书、总任务书。
- 进程原则：全局至多 2 个网络执行进程、同根互斥、排队至多 128；超时/取消不能自动补交，已启动写入没有确定回执即 unknown；取消后仍占用进程名额直到 close，不能用 killed=true 假称退出或不断补开进程。
- 当前环境没有 cargo；本轮如必须变更 Native，先解决对应测试环境并保留 Windows 实机门，不以 JS 代替 Cargo。


### 18.1 本次可审查交付与未接线边界

- 当前交付仅 `sharedIoProcessRuntime` 及其真实进程诊断。先前试接的 rustSharedIoCommandRuntime 和 transport 路由已撤回，未提交；不能把 metadata 命令切成独立进程却继续在 main 做同步 preflight，造成“已隔离”的假象。原业务执行链保持 O-01。
- 最终生产白名单：新增 `src/main/path/sharedIoProcessRuntime.ts`。最终其他白名单：新增 `build/diagnostics/check-shared-io-process.cjs`、package.json、README、本任务书、总任务书，共 6 个文件。没有隐藏的 Rust、IPC、schema 或原入口变更。
- 工厂返回 run/stop/whenIdle/status，接线时必须由既有 transport 持有唯一实例，不能每个请求创建一个实例绕过全局额度。当前调用方只有诊断，不存在新常驻后台进程。
- 一次任务持有实际 ChildProcess、timer、abort listener、根集合、排队/开始时间和独立 Promise 结算标记。排队与执行各自有截止时间，重复取消幂等，队列最多 128、活动进程最多 2，同根任务互斥；多根任务占有全部根身份。
- caller 的超时/取消立即结算，但 active 名额及根锁必须等 close 才释放。先 SIGTERM，1 秒后仍未 close 则 SIGKILL；不以 child.killed 或 exit 代替 close。即使系统未完成回收，也不无界补开进程。
- 进入 stop 后拒绝新任务，排队任务按 not-started 结算，已启动但没有确定回执的任务按 unknown 结算。基础不自动重试、不持久化离线操作；后续接线必须沿用原生已提交写禁止 fallback 的错误标记及业务回执协议。
- stdout/stderr 合计字节预算，按 UTF-8 流解码避免中文被跨块截坏；超限取消任务。日志不影响结算。请求的 args/roots/env 复制后归 owner 持有，不能由调用方改变已排队资源身份。

### 18.2 实际阻塞、原因与继续条件

已核查的主线程事务不只是只读查询：

| 当前入口 | 必须保留的行为 | 下一步必要工作 |
| --- | --- | --- |
| sharedMetadataLegacyImportRuntime | 从旧 root cache 导入 font_metadata、写迁移标志和 metadata_events | 在原生边界承接幂等导入及失败原子性，不删除导入步骤 |
| sharedMetadataOverlayRuntime | overlay 前 legacy 导入、tag ops backfill/replay，再读取字段 | 增加可确认的原生 preflight/读回能力，避免 main 打开 SQLite |
| sharedTagOpsBackfillRuntime / sharedTagOpsReplayRuntime | 历史 tag ops 回填、回放和冲突保护 | 搬迁同一业务协议与反例到 Native，保留事务和兼容约束 |
| sharedMetadataSignatureRuntime | Rust 失败后的 Node SQLite 查询 | 在隔离读取完成后统一拒绝/保留；不能超时又退回 main 打开库 |
| SharedKnownTags Node 兼容 / merged index / maintenance | 共享句柄及路径检查 | 逐消费者迁移；与本地状态库/清理分开持有与回收 |
| watchedFolderCanonicalRuntime / watcher / scan / preview / authorization | 同步路径规范化、监听及前置共享 I/O | 保留路径授权语义，逐项证明无主进程同步网络访问 |

- 当前 Rust shared_metadata 模块只有 apply/read_state/remove_tag/schema/signature/state_machine/types；没有可直接替代上述 legacy/backfill/replay 的公共命令。本任务沿用既定 Rust 主路径，不能悄悄删掉旧格式兼容，或把完整事务改成逐条远程 SQL 调用。
- 环境核查：`command -v cargo` 没有结果；常见 Cargo 安装目录也不存在。对 `https://static.rust-lang.org/dist/channel-rust-stable.toml` 的连接测试 10 秒超时，curl 退出码 28，当前无法从该地址准备工具链。没有声称所有网络地址永久不可达，也未申请或绕过网络权限。
- 根据本书 O-02 Native 硬门和 §11.1，原生修改必须实际运行对应 Cargo 测试/release；因此本次不发布未编译的原生事务迁移，不将 JS 子进程用例写成原生通过。
- 继续条件：在可访问依赖且具备 Cargo 的环境完成 Native 事务/故障测试，接入新增能力并核验当前 worker 能力；再完成 §16.1 全部消费者的调用迁移、提交未知错误传播和本地执行隔离。仍需 Windows 真进程与 SMB 实测。
- O-02 尚未满足“无主进程同步网络调用漏网”，也未满足全业务写入未知持久回执和 16 类消费者隔离；O-03 不得据本次基础测试提前开工。没有离线同步系统或提前变更退出策略。

### 18.3 基础验证和交接

- 新门 `diagnostics:shared-io-process` 已接入 diagnostics:all，仅证明进程 owner 行为，不代表业务隔离完成。
- LF 实际 7 组通过：真实 Node 成功/UTF-8 边界；坏根卡住、另一根与本地文件操作继续；连续 10 次忽略取消的进程回收；同根串行/排队超时无副作用；128 队列满额拒绝及取消不启动；输出上限/启动失败；迟到结果与 stop 准入。最终 active=0、queued=0、pids=[]。
- 注入仅测试自建 Node 进程和临时目录，没有 NAS 写入、注册/删除字体或任意 IPC。Linux 的 SIGTERM 忽略/强杀行为不冒充 Windows 实测。
- 初次断言比较 VM 中的空数组与宿主空数组因原型不同失败，改为校验实际 PID 数量为 0；没有修改回收条件或弱化超时要求。
- 已用 Context7 核对 Node 24 spawn/close/exit/kill 语义；Mermaid 图明确标题“已实现但尚未接入业务的进程基础”。Create State 按既定容量跳过约定，不阻塞本次交接。
- 本次不涉及持久格式迁移；回滚为本次基础提交。用户软件功能仍是 O-01，不能宣称升级后已经能抵御 NAS 卡死退出。


本次最终验证：`npm run verify` 退出码 0（TypeScript、128/128）；`diagnostics:shared-io-process` 的 LF/CRLF 各 7 组通过且资源归零；三端构建 368/1/200 模块及混淆 3/3 退出码 0。6 文件白名单、链接与 `git diff --check` 通过。原 127 项诊断未修改。上述结果只覆盖当前未接入业务的基础，不解除 §18.2 的阻塞，也不允许把 O-02 标记完成。


### 18.4 O-02 接续实施登记（基线 35a0e9d）

- 用户要求继续实现，代码实现与 Windows 实机验收分开记录；本次优先实际接入现有 Native 命令，保留旧迁移语义。此前以缺少 Cargo 为由停止现有命令接线的判断已纠正；新增原生代码的编译门与全阶段验收要求继续保留。
- 实施前白名单：src/main/path/{sharedIoProcessRuntime,sharedPathProbeRuntime,startupPathAvailabilityRuntime}.ts；src/main/rust-core/{rustSharedIoCommandRuntime,rustCoreWorkerTransportRuntime,rustCoreDaemonWriteBoundaryRuntime}.ts；src/main/rust-core/clients/rustMetadataClientRuntime.ts；src/main/indexing/shared-metadata/{sharedMetadataOverlayRuntime,sharedMetadataSignatureRuntime}.ts；src/main/library/sharedKnownTagsRuntime.ts；src/main/install/status/{installStatusReadRuntime,installStatusWriteRuntime}.ts。
- 诊断白名单：新增 build/diagnostics/check-shared-io-integration.cjs；既有 check-shared-root-retention.cjs、check-startup-nas-deadline-policy.cjs、check-shared-io-process.cjs 的系统端口夹具可随真实边界迁移，原断言不删；package.json、README.md、本任务书及总任务书。实际遇到其他诊断契约须先补充登记。
- 本次目标：共享元数据五项命令与安装状态读写按资源路径分流至单一有界独立进程 owner；本地命令保留原通道；隔离请求失败不得回主线程兼容读写，未知写不得重试；输入文件保留至进程 close；目录探测也用可回收子进程。
- 验证计划：真实 Node 故障进程经过生产 transport/client，覆盖同根互斥、跨根及本地进展、取消/停止、坏回执、兼容回退阻断、临时文件生命周期、UNC/映射盘归一、目录探测；TypeScript、全部诊断、三端构建。Node 故障进程不冒充 Rust 或 Windows 实机。

- 18.4 诊断白名单补充：check-orchestration-contracts.cjs 的 TS 模块加载器需认识新增隔离依赖；helpers/rustWorkerTransportHarness.cjs 补齐纯路径端口；fixtures/rust-worker-clients.fixture.json 仅更新本项七个修改方法的源码哈希，保留其他方法、全部行为断言与变异反例。不是整份重录历史行为基线。


### 18.5 本次接线的实际边界与验收

| 环节 | 已实现行为 | 保留的边界 |
| --- | --- | --- |
| 七项业务 | shared-metadata apply/remove-tag/known-tags/overlay-read/signature，install-status read/save 传入真实资源路径；共享目标绕过常驻 daemon 和原调度器，使用 transport 唯一 sharedIo owner | 本地路径仍用原 daemon/scheduler；没有更改 Native 命令格式、能力探测或数据表 |
| 路径身份 | 纯文本正规化 UNC、设备 UNC、大小写、点段；映射盘复用现有异步映射查询；同一 SMB share 共用互斥键 | 按 share 串行比按子目录更保守；映射查询失败直接拒绝。旧同步映射调用及库身份恢复验证仍未迁移 |
| 超时/回收 | 共享业务执行期限最多 30 秒，排队期限 3 秒；最多 2 活动进程、128 排队；取消先 TERM，1 秒后 KILL；名额与锁只在 close 后释放 | 调用方更短的旧软期限仍可先返回，底层任务继续由 owner 跟踪至回收；不把 Promise 拒绝当作进程结束 |
| 输入文件 | 复用 transport 本地临时 JSON；隔离进程持有期间 dispose 只登记意图，close 后才实际删除 | 不改业务 payload；删除仍沿用原有 best-effort 策略；不保证系统强制断电时清除临时输入 |
| 失败与回退 | 隔离错误带 sharedIo 终止标记，未启动与结果未知分开；坏 JSON、ok=false、业务回执结构错误也不回退；安装状态外层及 overlay/signature 吞错点保留终止语义 | 不新增离线队列、自动补交或重放；全业务未知提交的持久记录仍未实现 |
| 共享签名 | 共享路径不再先执行 main exists/stat/SQLite，直接交由 worker；同库合并在途请求，共享分支达到 64 个签名在途键时拒绝新请求 | 原生命令对 metadata:none 的既有语义未改，严格缺失/权限分类与共享身份确认仍需后续 Native 验证 |
| 标签目录 | Rust 读取失败或外层超时保留本地确认目录，requireFresh 使用原中文失败提示；即使显式启用 Node 兼容也不在失败后再次开共享库 | 正常完整回执、部分根保留与旧数据兼容规则不删除 |
| 目录探测 | Windows 路径及 UNC 的 stat 在独立 Node 模式子进程执行；路径为独立 argv，shell=false；探测池独立于业务池，各最多 2/128；既有生命周期 stop 同时停止业务池和探测池 | Linux 普通本地目录仍走异步 stat。映射盘查询仍复用既有 net.exe/1500ms 实现；本轮不宣称迁完所有目录/扫描/预览 I/O |
| 本机行为 | 本地标签、字体资源移除/注册表操作、系统枚举保持原执行通道；测试证明所迁移的共享请求卡住不占该通道 | 未迁移的其他 NAS 命令仍可能进入原 daemon；O-04 的状态保存尾部与 O-06 的有界退出未完成 |

- 生产入口已切换，不再是只有诊断引用的基础工厂；但 §18.2 的 legacy import、backfill/replay、overlay 的前置 SQLite、merged index、维护、扫描、预览、授权等库存仍未全部迁移。因此 O-02 继续标记进行中，不能仅凭七项客户端与目录探测通过就关闭“16 类消费者无漏网”验收。
- 本次没有修改 Rust；当前环境没有 Cargo，未声称执行 Cargo 测试/release。也没有把此限制继续当成现有 TypeScript 接线不能推进的理由。本轮查阅 Electron 包入口时发现本地缺少可执行文件、触发自动下载提示，已中止；没有取得 Electron/Windows 实机运行结果。
- Context7 已核对 Node 24 的 close/exit/kill 行为及 Electron 的 ELECTRON_RUN_AS_NODE、默认启用的 RunAsNode fuse；项目未配置禁用该 fuse。Mermaid 已展示当前实际接入链；首次参数名错误后修正成功。Create State 沿用既定容量 2/2 跳过约定，不另建平行状态文件。
- 实施失败及修正：旧组合诊断加载器未识别新增 path 模块；已限定扩展到实际新增依赖。共享目录 requireFresh 原提示被底层 EIO 替代；已恢复原中文提示并保留 cause。兼容目录旧用例原先依赖“Rust 抛错后再开库”，已增加该行为必须禁止的断言；原正常兼容读取/损坏保留/句柄关闭断言改在未提供 Rust 端口的显式兼容场景执行，全部保留。原 369 个 transport 行为用例、7 个状态序列、28 个输入文件作用域和 10 个变异反例原样通过；仅本项七个方法源码哈希发生变化。
- 新诊断为生产 client→transport→真实故障子进程；故障脚本只读取自建本地 JSON，绝不连接真实 NAS 或执行字体注册/移除。10 组包含 UNC/映射身份、七项方法接线、本地通道、错误回执、同根/跨根、输入文件直到 close、外部取消、外层回退阻断、目录探测及关闭。LF/CRLF 通过，移除实际分流的反例必须失败，最终子进程数为 0。原进程门的连续 10 次忽略取消、128 队列上限等检查继续通过。
- 三端构建实际为 374/1/202 模块，退出码 0；混淆实际日志为 3/5（本次重建的 3 个 JS 文件已处理，另 2 个旧产物已带标记而跳过），退出码 0。没有冒充完整 npm run build、安装包或真实 Windows/NAS 验收。
- Windows 后续应在 dev 模式验证目录选择/加载、共享标签读写、映射盘与 UNC、断网时本地取消及关闭；网络永不恢复、残留字体与全链路退出仍须完成 O-04～O-06 后验收。回滚单位为本轮 Git 提交，无持久格式迁移；旧本地目录/标签、100ms 选择与合并按钮不变。


- 最终验证：npm run verify 退出码 0，TypeScript 与 131/131 全部诊断通过；目录保留门 LF 18 组（含历史反例）、CRLF 17 组通过。实际修改 20 个文件，均在 §18.4 及其补充白名单内；文档目标与 git diff --check 通过。三端构建和混淆结果如上；没有更改 Rust、依赖、IPC、schema 或激活副本文件。当前自动证据只覆盖本次已接入范围，O-02 完整门、O-04～O-08 及 Windows/NAS 实机仍未关闭。

## 19. O-03 执行卡

- 状态：实施完成，自动验证通过、Windows/NAS 待验；基线 2cc43a894431a92a4631ec7b920fddea9fb9f073，工作树干净。用户明确要求开始 O-03，按最新指令先实施可独立验证的界面/IPC 准入；§18.2 的 O-02 依赖未满足事实保留，不据此声称网络隔离或退出保障完成。
- 生产白名单：新增 shared/sharedAvailability.ts、main/path/sharedAvailabilityRuntime.ts、main/ipc/sharedActionAdmissionRuntime.ts、renderer/src/sharedAvailabilityRuntime.tsx；修改 main/bootstrap/mainDataCompositionRuntime.ts、mainCompositionContracts.ts、mainApplicationRuntime.ts，main/ipc/ipcHandlerTypes.ts、ipcHandlers.ts，preload/index.ts、main/preload/runtimePreloadSource.ts，renderer/src/components/app/{AppRootView,AppSidebar,AppSidebarFoldersPage,AppSidebarTagPage,FontCommandButtons,FontDetailPanel,AppOverlays}.tsx。路径均位于 src/ 下。
- 诊断白名单：新增 build/diagnostics/check-shared-action-admission.cjs；必要的现有组合契约夹具按实际新增能力精确更新并记录，不能删断言；package.json。文档白名单：README、本任务书、总任务书。
- 设计：复用 O-01 唯一根状态 owner、本地配置与标签归属；只读快照 IPC，不持久化 online、不设同步队列。主进程依据配置和目标路径检查全部目标，预检失败整体拒绝；保留原 sender/路径授权。UI 使用单一只读订阅，离线项留在原位，使用 disabled/aria-disabled，并阻止键盘、右键和拖放。共享标签无归属时保守处理；本地行为与取消激活不受共享准入限制。
- 验证：真实生产模块和 TSX 行为、直接 IPC 拒绝零副作用、混合根完整性、失联保留/恢复、双 preload、原 100ms 防连击边界、全部自动诊断及三端构建。真实 Windows/NAS 和未完成的 O-02/O-04/O-06 不冒充通过。

### 19.1 白名单补充（实施前登记）

- 查询保留：src/renderer/src/runtime/database/useRendererDatabasePageRuntime.ts，拒绝共享离线查询时保留已有分页/选择；不将拒绝转换成空集合。
- 视觉禁用：src/renderer/src/styles/15-global-interaction.css，为 disabled/fieldset 提供真实灰色样式。
- 新能力带来的夹具变化：build/diagnostics/fixtures/{orchestration-contracts,main-application-registration,main-composition-runtime}.fixture.json，check-main-composition-contracts.cjs；新增 getSharedAvailability，原键不移除。check-activation-entry.cjs 的 React 受控端口补齐 context，仅设原有正常在线基线；离线行为由新门实际注入状态检验。

- 白名单调整：只读状态 Provider 放入 src/renderer/src/main.tsx 的应用入口，覆盖界面及控制器且不改变六组视图参数契约；AppRootView 的试接已撤回，保留原有结构锁和四种模式哈希。

- 编译路径夹具白名单补充：build/diagnostics/check-main-composition-compiler-paths.cjs、check-main-application-runtime.cjs。新增只读能力使必需能力数 115→116、缺失能力编译反例 125→126；同步精确计数与输出，保留正/反路径、LF/CRLF 和旧遗漏反例。

### 19.2 实际边界与兼容约束

- 状态快照由现有本地库借用句柄读取 folders/tags/meta，再结合 O-01 唯一根状态 owner；不调用 loadLibraryShell 的共享统计，不新开共享数据库、不写 online 状态、不增加持久格式。沿用 owner 的合并探测/失败缓存，目录 stat 仍属 O-02 未隔离部分。
- 新增唯一 `library:getSharedAvailability` 注册项，正式和运行时 preload 同步。内部组合能力必需且类型固定；旧 preload 无该方法、快照缺字段或读取错误时 UI 保守禁用共享入口。原 sender 校验在准入前执行，原路径/业务授权仍在处理器中执行。
- Provider 位于应用入口，默认两秒读取一次，最多一项未结算读取；六秒未返回仅将界面置为不可用，不声称取消了 IPC 或系统调用。StrictMode 重复 effect 复用未结算 Promise，卸载清理 timer 并忽略旧回包；超过六秒的旧回包也不恢复在线状态，等待下一次新读取确认。目录/标签来自原 library，不用快照重建或删除它们。
- 目录、子目录、共享标签的 disabled/aria-disabled 与灰色样式同步；保留选中 class 和展开记录。详情共享标签 fieldset、输入 Enter、菜单与拖放均有限制。旧菜单中的危险动作再次点击时仍经过 main 当前状态检查。合并状态按钮及 99/100ms 单击逻辑保留。
- main 整批检查安装、激活、物理删除/移动、目录创建/改名/刷新、共享标签写、显式扫描/缓存/树读取、需源文件的预览和资源管理器入口；不会在混合根列表中筛掉离线项再执行剩余写操作。共享标签旧写链可能访问多个索引，所以任一配置根不可用时保守暂停共享标签写；按归属读取的在线独占标签仍可用，同名跨根和无归属旧标签保守禁用。
- library:save 变更共享标签目录时同样受准入限制；仅本地标签/收藏/保护、配置移除及取消激活不因此禁用。来源不明 UNC 路径保守拒绝。主进程仍依据本地配置和真实目标 path 判定，不接受 renderer 提供的 online 布尔值。
- 指定共享目录/标签查询在执行前和回包时检查；拒绝时 renderer 保留当前分页、字体记录与选择，不能把错误转为空结果。通用本地查询与既有索引同步机制不迁移到本项。后台监听保留 O-01 逐根跳过方式，避免一个离线根阻止其他根启动；watcher 重新绑定、共享库身份复核和完整恢复归 O-07。
- 取消激活入口可用只表示本项不拦截，不表示现有激活文件已复制本机。字体本地副本归 O-04；共享 SQLite/同步路径隔离归 O-02；网络永不恢复下有界退出归 O-06。新增监视目录在保存配置前先经现有 owner 实际验证可读，不把未配置路径一律拒绝；这类探测不直接写入配置。真实断网至检出存在 O-01 TTL/探测窗口，O-03 不是原子网络事务或系统调用熔断器。
- 新增 1 个只读能力和 1 个诊断脚本；无依赖、schema、Rust、持久同步队列变化。Create State 沿用容量 2/2 后跳过的既定约定；Context7 核对 React 18 effect 清理，Mermaid 展示已接入的状态/准入链。

### 19.3 验证记录

- 新诊断直接执行实际 TSX、两套 preload、完整 IPC 注册和真实 sender 校验；覆盖混合根无副作用、目录/标签保留、共享/本地行为区别、迟到菜单点击、恢复、缺失能力、损坏快照、轮询截止/卸载/StrictMode。默认 40 组（含 CRLF 子进程及故意移除 main 准入的负例），负例必须因“缺少预期拒绝”失败。
- 实施中失败记录：原缺失字体预检被新增按钮完整数量禁用遮住，已保留原 resolver 报错路径并让原断言通过；Provider 试放视图导致结构锁失败，改为应用入口并恢复原视图哈希；组合新增能力导致 115/125 旧计数失败，精确增加到 116/126，旧键/旧反例全部保留。新诊断初次将审计日志计作副作用、按钮 void 返回当 Promise、运行时 preload 导出名写错均已修正夹具，没有放宽业务拒绝断言。
- 已实际通过一轮 TypeScript 与 129/129 全部诊断；新增目录准入补查后，定向 39 组、最终 TypeScript 及三端构建 371/1/202 模块、混淆 3/3 均退出码 0。最终完整重跑 129/129 退出码 0；随后仅加严过期回包不得恢复在线的分支，定向 40 组（含 CRLF/负例）、最终 TypeScript、三端构建 371/1/202 和混淆 3/3 再次退出码 0。32 文件精确白名单、文档链接与 git diff --check 通过。Windows/NAS、浏览器原生焦点/布局、实际断网激活和退出不在本环境冒充通过。


### 19.4 交接与回滚

- 本项对应 UO-01/UO-02 的置灰保留、UO-04 的禁止离线共享写；自动证据覆盖 X 矩阵的 UI/主进程准入部分，不能据此关闭整个断网/退出矩阵。
- 最终实际 32 文件，AppRootView 试接未保留；32 文件均在 §19/§19.1 及补充白名单内。既有 128 项诊断保留，六组视图绑定与原结构哈希保持，新增只读能力的 116 个必需键和 126 个编译拒绝检查通过。
- 性能证据限于有界轮询、StrictMode 合并同一未结算读取、计时器清理及旧回包抑制；没有虚报 NAS 延迟/P95、Windows 句柄数量或字体清理耗时。未新增依赖/原生代码，因此没有新 Cargo/Windows 安装包构建结果。
- Windows 后续以 npm run dev 验证：选中并展开共享根后断开、同名跨根标签、菜单打开中断网、混合根批量操作、离线取消激活入口、恢复后的状态；真正的源路径无关取消、共享身份/监听恢复和有界退出须分别完成 O-04/O-07/O-06，并补齐 O-02。
- 回滚单位为本执行卡同批 Git 提交；不存在需要撤销的 schema 迁移或离线操作队列。O-02 仍未完成，后续不得用本项 UI/IPC 通过替代网络执行隔离验收。

## 20. O-04 执行卡

- 状态：已开始，故障基线与调用审计已完成；生产切换未实施。基线 8e9f42befc95e71ecd92e5ad6d6bd54511c67363，初始工作树干净。按用户最新指令开始 O-04，O-02 前置未满足事实继续保留。
- 已确认当前激活成功链已复制到 currentUserFontsDir，并由 temporary-active-fonts.json 保存 sourcePath/installPath/registryName；O-04 复用这套所有权，不另建两个互相接替的源链接。
- 本次精确白名单：新增 build/diagnostics/check-local-activation-baseline.cjs；修改 package.json、README.md、本任务书、总任务书。暂不修改生产、Rust、schema、依赖或用户字体。
- 可运行基线覆盖：同大小同时间但内容不同的副本复用、复制失败半文件、错误原生回执接受、取消激活后状态保存仍按 NAS 源路径路由，以及不属于临时目录的记录先进入资源移除。仅受控 OS/worker 端口和自建临时文件，不对真实字体进行注册或删除。
- 完整实现须在同一事务中保证：副本完整性和安全发布、目标身份/归属校验、注册/资源失败补偿、本地取消目标解析、本地核验与可重建共享索引分离。不能靠修改路径字符串、跳过真实系统核验或开启默认 Node fallback 来满足断网验收。


### 20.1 已复现的故障与有效对照

| 证据 | 实际执行内容 | 结论及限制 |
| --- | --- | --- |
| 副本内容不同仍复用 | 真实临时文件 AAAA/BBBB，长度和时间相同；实际 Node 兼容复制模块返回 reused | 兼容路径没有内容完整性校验；测试显式启用隔离环境变量，不改变产品默认 Rust 策略 |
| 复制失败半文件 | 仅替换 fs.copyFile 故障端口，写入 AA 后模拟源断开；实际复制模块拒绝后目标仍存在 | 当前复制入口未自行回收未完成目标；没有用真实 NAS 断网冒充该注入 |
| 错误原生回执 | 实际 JS 桥收到其他 id/source/dest 的 ok 回执，目标不存在仍返回 copied | 证明桥端未核验回执身份；并未执行或宣称 Rust worker 通过 |
| 取消后的源依赖 | 实际 batch→settlement→reconcile 将原 FontItem 交给保存队列；实际 installStatusWrite 在 rootForFontPath 收到 NAS sourcePath，随后向 worker 端口提交共享根 dbPath 写组 | 本机资源移除后仍可把共享路径传入状态保存链，受控 worker 拒绝网络写后保存失败 |
| 非所属目标进入资源移除 | 本地会话记录指向临时目录外的受控路径，实际批量结算先调用资源移除端口 | 仅记录调用、未触碰真实资源；记录归属校验必须放在副作用前，不能依赖后置删除队列拒绝 |

四个有效对照：真实成功复制得到本机正确内容；资源移除使用记录中的 installPath；资源移除失败保留会话记录；没有临时记录的其他字体不被移除。这些对照说明现有本机副本和补偿流程可以复用，不需要从零建立第二套激活系统。

- 默认诊断固定加载 8e9f42b 的实际生产模块，保留历史证据，后续修复不应把历史断言改成无条件通过。`--current` 用于加载当前模块；`--strict` 要求缺口为零，目前应失败。默认还校验 CRLF 和固定历史 strict 反例。
- 默认退出码 0 只表示五个已知缺口与四个对照被正确观察，绝不表示 O-04 功能验收通过。模块读回、比较、调用队列均为真实 TS 执行；OS/worker 端口为受控替身，临时文件由 finally 回收。

### 20.2 完整实现的具体接续顺序（尚未实施）

1. **复制与发布**：在 native-src/hfm-core-worker/src/font_resource/activation_files.rs 保持 Rust 主路径，承接独占临时文件、内容/大小校验、成功发布及失败回收；copy_one 当前原生源码只比较长度即 reused。同步修改 fontActivationCopyRuntime 回执关联验证。必须覆盖同名不同内容、源中途变化、部分写入、目标替换和异常回执，不能只改目标路径字符串。
2. **副本所有权**：沿用 currentUserFontsDir 和本地会话记录，在资源/注册表/删除副作用之前校验目标为本机受管文件及记录身份；扩展时保留 v1 记录的明确兼容策略。旧记录证据不足时保留待修复状态，不能删永久字体。候选 owner 为 fontDeactivationSettlementRuntime、fontActivationCleanupRuntime、temporaryFontDeleteQueue、managedFontOwnershipRuntime 及现有路径授权边界。
3. **源无关取消**：单项、批量和退出候选只用本地受管目标完成资源移除、注册表清理和真实系统核验；记录按已确认步骤结算。保留资源/注册/保存失败的补偿记录，禁止错误清空记录后靠网络恢复补救。
4. **本地状态结算**：分开 reconcileDeactivatedInstallStatus 的本机事实和共享机器索引保存。现有 installStatusWrite 按 sourcePath 分组至共享根，不能在取消尾部继续作为必须成功的步骤。需要同时核对读端优先级、意图版本及持久边界，不能仅把路径改成本机副本来伪造共享字体签名，也不增加离线共享写队列。
5. **联合验证**：先补齐 O-02 对工作进程取消/迟到执行者的真实隔离，再运行本任务单项/批量/退出候选的“所有源路径端口均拒绝”测试，以及 A1～A8、半文件、永久字体混合、同名不同字体、目标替换测试；实际 Cargo tests/release、Windows 与 NAS 永久断开结果单独记录。准备生产变更时另补精确文件白名单，以上是调用导航，不是本次已改文件。

### 20.3 当前阻塞与环境证据

- O-02 业务隔离尚未接入；其执行者生命周期未闭合时，复制失败/超时后可能仍有原生执行者写入，单靠 JS Promise 拒绝或 finally 删除临时路径不足以证明半文件回收完成。O-03 的界面准入不能替代该能力。
- 当前执行环境 `command -v cargo` 无输出；/usr/bin、/usr/local/bin、/opt 未找到 cargo/rustc。再次访问官方工具链地址 `https://static.rust-lang.org/dist/channel-rust-stable.toml`，10 秒超时、curl 退出码 28。此结论仅针对当前执行环境，不否认用户 Windows 开发机已有 Cargo。
- 仓库没有 .github 工作流目录，没有可直接复用的原生 CI 验证链。本次未擅自新增 CI/依赖/默认兼容模式来改变既有构建工作流。
- 按本任务书 §11.1，真实 Rust 修改须实际运行对应 Cargo 测试与 release，JS 模拟不能替代；因此本次只交付故障基线与准确接续记录，不发布未验证的原生改动，不标记 O-04 完成。也没有关闭 O-05/O-06/O-07 的残留、退出、恢复验收。
- 已用 Mermaid 展示当前实际取消→本地资源→共享状态保存的依赖链；没有新增生产 API，无本轮 Context7 API 使用需求。Create State 沿用容量 2/2 后跳过的既定约定。

### 20.4 验证与交接

- 已实际运行定向诊断：LF 观察 5 个缺口、4 个对照，CRLF 子进程退出码 0，历史 strict 子进程预期退出码 1。完整 npm run verify 退出码 0（TypeScript、130/130）；补强共享 worker 写组证据后定向基线仍退出码 0。另实际运行 --current --strict，退出码 1，精确报告上述 5 个未解决缺口；这才是本项尚未通过功能验收的结论。5 文件白名单、文档链接和 git diff --check 通过。
- 最终范围仅本卡五个文件；没有生产、IPC、schema、Native 或激活目录变更，没有新构建/Windows/Cargo 结果，不复用 O-03 的构建结果冒充本项。
- 回滚单位为本次诊断及文档提交，无数据迁移。下一步需在具备 Cargo 和依赖访问能力的环境补齐 O-02 原生隔离及上述 O-04 实现；本轮不把已知缺口变成静默成功，也不继续宣告后续任务通过。
