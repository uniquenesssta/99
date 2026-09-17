# HFM 全链路审计

日期：2026-09-16。代码基线：`7e0e6d74b4a7f06abf06edae92c3b587970a96c6`，分支 `stage/09-preview-tags-app`。本轮为审计，不修改生产代码或冻结测试期望。

执行顺序更新：用户要求日志最先。后续以[修复任务书](../plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md)为准：R-01关联日志→三类Rust事务→标签意图/确认→广播去重→总验收。下文原始发现与原建议保留为审计历史，不作为当前实施顺序。

R-05修复进展（2026-09-17）：F-01a/b与F-02原始反例在b7f68e1分别复现，当前观察均为false；真实队列/页面/弹窗与失败重试门、Node SQLite关联链及LF/CRLF退化检查见[修复任务书§20](../plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#20-r-05-执行卡)。Windows/NAS实机待验；F-03仍留R-06。以下旧审计结果保留原基线含义。

R-06修复进展（2026-09-17）：F-03a/b及相同IDs不同目录内容三项旧反例已转真实生产门；完整存储域/提交身份、双通道去重、保守旧消息与容量/过期边界见[修复任务书§21](../plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#21-r-06-执行卡)。未修改只读observer，F-03a/b当前均false；Rust原生/Windows/NAS仍待验。

R-07验收进展（2026-09-17）：TypeScript与113/113通过，原observer的F-01a/b、F-02、F-03a/b均false；历史原生反例夹具补齐可选字段并严格区分编译失败和SQL断言失败。F-01～F-05证据、Node SQLite真实关联样本及X矩阵见[修复任务书§22](../plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md#22-r-07-执行卡)。原生入口缺Cargo未执行，Windows/NAS待验；保留下面原审计基线、未宣称全部关项。

## 结论

发现 **4项正确性问题/风险与1项可观测性缺口**。现有 `npm run verify` 的TypeScript及104/104诊断仍全部通过，说明以下边界未被既有门覆盖，不能把拆分和门禁通过解释为业务链路全部正确。

优先修复 **Rust提交边界F-04和标签确认F-01**，再处理未确认意图寿命F-02、信号身份F-03，最后补跨层日志关联F-05。本轮不执行修复，不改变D-11“GUI待验收”结论；新增问题进入专项未关闭项。

## 范围和方法

沿现有六组业务IPC注册入口及窗口IPC，检查界面动作→写队列→preload/IPC→主进程业务门面→Rust/Node持久化→信号/修订→查询/页面合并，以及预览、监听、退出和维护的生命周期。重点逐段阅读状态写入、异步等待、提交/通知、旧响应拒绝的位置。

证据等级：

- **运行时复现**：直接转译并加载实际TypeScript函数；仅替换Electron广播出口、控制输入/时间。不等于完整Electron端到端测试。
- **源码确认**：明确的控制流/事务边界，结合SQLite故障重建验证后果；不冒称运行了Rust worker。
- **检查未见新问题**：入口/关键分支审查和既有自动门通过，不是整域无缺陷证明。
- **未执行**：Windows原生系统字体接口、真实NAS断连/多机冲突、GUI逐步操作、原生Rust测试、实际备份恢复/破坏性操作。环境Linux/Node24.19.0/npm11.9.0，无Cargo，不触碰用户数据。

## 发现清单

### F-04 · P1 · Rust标签绑定与目录不在同一事务

**位置**：`native-src/hfm-core-worker/src/local_tags/state_machine.rs`，set第36～58行，delete第159～167行；`local_tags/catalog.rs`的`save_known_tags`；`local_tags/schema.rs`的`set_app_state`。

- set先在事务内修改`local_font_tags`，第48行commit；第57行才写`app_state.localTags`，第58行写`localTagsUpdatedAt`。
- delete同样先提交删除绑定，再保存目录/时间。后续每个步骤使用`?`传播错误。
- 若目录写入/元数据写入失败，命令返回错误，但已提交的绑定无法回滚，成功结果和信号也未生成。前端可能继续重试；“不跨后端重放”不等于“此命令原子提交”。
- Node持久化门已经测试绑定/目录同事务；Rust适配门只控制客户端结果，没有运行Rust事务，所以104项通过不能覆盖本缺陷。

**证据**：源码明确确认；使用临时内存SQLite按原顺序执行绑定commit、目录INSERT，并用目录触发器RAISE(ABORT)。返回`audit catalog failure`后，绑定仍为`a/new`，目录仍为`["old"]`。这只是SQL顺序后果复现，不是Rust二进制执行。

**同类待修范围**：`shared_metadata/state_machine.rs`第168～174、356～362行，metadata在commit后写入；`preview_cache/write.rs`第76～78行也在commit后写updatedAt。这些同样可能“提交成功但返回失败”，具体跨层后果需各自故障测试；不能把标签SQL复现当成全部原生路径已测。

**修复验收**：在Rust实际函数测试中注入目录、时间、共享metadata失败，确认所有必需状态共同回滚；明确非事务性日志/通知失败的已提交结果语义；以第二连接回读为证据。Node/Rust五方法结果对齐，禁止失败跨后端重放继续保持。

### F-01 · P1 · 旧标签确认可清除更新的用户输入

**位置**：`src/renderer/src/fontTagStateAuthorityRuntime.ts`的`applyFontTagMutationSignalToLibrary`（175～250行）；事件入口`runtime/app/effects/useFontTagStateSignalEventRuntime.ts`。

真实链路：标签输入→`markFontTagsOptimistic`→写队列；前一次写入广播到达→`applyFontTagMutationSignalToLibrary`→commit→查询刷新。

- 收到信号后，使用`max(signalRevision, updatedAt, now)`提高本地revision并把dirty截止时间设为当前时间，没有证明信号对应最新一次编辑。
- `knownTags`随后过滤**所有**字体，不限changedIds，不保护其他字体尚未提交的新标签。
- 接收时间与编辑时间、后端修订号混合比较，并不能建立操作因果关系。

**实测反例**：t=2000为a输入`new`；t=3000收到t=1000旧确认，knownTags仅`old`。实际a标签变为`[]`、dirty=false。将changedIds换成b，a的新标签同样被清掉。

**影响边界**：已确认会丢失当前内存显示/意图保护；后续新写入和回读可能恢复，因此不直接断言永久数据库数据丢失。此处足以造成标签消失/反弹，并为紧接着的用户操作提供旧状态；并未证明它就是之前收藏闪回的唯一原因。

**修复验收**：引入按字体/字段的意图代次及明确确认关系；旧ack不清新dirty，目录刷新不剔除未确认新增项；覆盖同字体第二次编辑、其他字体并发编辑、空目录删除、乱序确认、确认后真实外部删除。

### F-02 · P2 · 未确认标签依赖固定20秒保护，失败重试后仍可能被旧读覆盖

**位置**：`fontTagStateAuthorityRuntime.ts`第4、54～73、86～128行；`fontWriteQueueRuntime.ts`的前台/后台重试。

写队列可持续后台重试，但标签dirty只靠`now + 20000`。`mergeFontTagState`没有查询队列的未确认状态；当incoming没有revision且dirty到期，就采用旧读。

**实测反例**：t=2000输入new，无任何成功确认；t=22001合并后端old，结果old。这里直接测试真实合并函数，未模拟20秒墙钟或断开真实NAS。

**影响**：离线、数据库忙、长时间重试时，UI可能显示旧标签而队列仍持有new，后续成功再反弹。修复应让pending寿命由settlement决定，不能单纯延长超时；必须有失败/取消/最终确认与外部新状态的收敛规则，防止永久屏蔽外部更新。

### F-03 · P2 · 信号去重身份不完整，存在漏通知

**位置**：`src/main/library/tagMutationStateSignalRuntime.ts`第52～75、87、120～126行。

去重键只含scope、mutationKind、updatedAt和前80个changedIds；不含dbPath/rootPath，目录只记录“是否有knownTags”，不比较具体内容。

**实测反例**：

1. 两个不同共享根，相同时间/操作、空changedIds：应广播2次，实际1次。
2. 两个批次前80个ID相同，第81个分别为a/b，时间/操作相同：应广播2次，实际1次。

**发生条件**：必须产生碰撞键；不宣称日常每次操作都会漏。漏掉的信号不执行revision、查询缓存清理或广播，页面可能等待其他刷新才收敛。

**修复验收**：使用跨daemon/worker双通道稳定一致的mutation identity，包含存储域；如果采用摘要须包含完整ID/目录语义。确保真正重复通知仍只应用一次，同时不同根/目录/第81项不同的操作不被吞。

### F-05 · P2（可观测性）· 现有日志不是每次用户操作都能贯穿到底的关联链

**位置**：`src/main/ipc/ipcTraceRuntime.ts`第236～284行；`fontWriteQueueRuntime.ts`；`tagMutationStateSignalRuntime.ts`；`useFontTagStateSignalEventRuntime.ts`。

日志存在：IPC按channel记录开始/耗时/结果，renderer有查询序号，Rust某些结果含jobId，标签日志有scope、数量和revision。但UI意图→队列批次→IPC→Rust提交→信号→页面应用之间没有统一可传递的operation/mutation ID。部分start仅在详细日志开启时记录；不能依靠时间和changed数量唯一还原同字体的连续操作。

建议按字段记录意图代次、批次、后端任务/提交身份、广播revision、页面接受/拒绝及原因，并保留现有采样/容量控制。只记录必要ID与状态摘要，不靠全量字体对象/路径或无界逐帧日志实现追踪。这是诊断能力缺口，不把它单独当作已证明的数据丢失。

## 全链路覆盖表

| 链路 | 关键审查位置 | 结论/边界 |
| --- | --- | --- |
| 启动、主进程组合 | main bootstrap compositions、mainProcessLifecycleRuntime、library load入口 | 原组合与compiler/runtime门保持；原生启动未重测 |
| UI选择/详情/输入/视图 | App、两个交互组合、controller、app-root-view门 | D-09/D-10接线/生命周期门通过；F-01/F-02位于后续状态合并，不是组件拆分本身 |
| 本地标签写入 | dialog tag actions→fontWriteQueue→fontTagIpcHandlers→localFontTagsRuntime→Rust/Node | F-01/F-02/F-04；Node真实SQLite回滚门通过不能代替Rust |
| 收藏/保护/共享标签 | queue四字段→fontSystem/fontTag handlers→sharedMetadataMutationRuntime及Rust state_machine | 字段隔离和失败域重试门通过；共享metadata存在F-04同类提交后风险；实机冲突未测 |
| 信号/查询/计数/页面 | tag mutation write protocol/signal/barrier、databaseDerivedState、useRendererDatabasePageRuntime | F-01/F-03；旧requestSeq与意图revision拒绝逻辑存在，不能保证每类新并发组合都覆盖 |
| 激活/停用/安装/删除 | fontSystemIpcHandlers、fontActivationActionRuntime、main activation transaction/batch、path gates | 既有事务、补偿、批量缺项、路径/lease门通过；Windows字体资源与权限仍需实机 |
| 目录监听/扫描 | folderWatcherRuntime、watchedFolderIndexRuntime、index change事件 | generation、失败重读、删除证据与用户字段保持门通过；实际watch/NAS事件丢失未复现 |
| 预览读取/生成/发布 | preview handlers/scheduler、storage facade、routing/index/batch、Rust preview_cache write | D-02提交失效及generation门通过；Rust commit后meta仍需F-04专项测试 |
| IPC/窗口/字体协议 | 六handler注册器、ipcTrace、sender validation、appSecurity、windowRuntime | URL与统一sender门、预览输入/路径授权门通过；不宣称完成渗透测试或全参数模糊测试 |
| 库自动保存/关闭 | useLibraryAutosave、useAppFlushOnUnload、windowRuntime、main lifecycle | 写队列flush→库保存→关闭确认→临时激活清理顺序存在；未替代真实崩溃/断电/窗口交互 |
| 维护/备份/任务/许可 | maintenance/security handlers、applicationDatabaseMaintenanceRuntime及既有门 | 入口与既有维护串行/能力门审查；未执行真实恢复、签名发布或许可攻击测试 |
| Rust传输/超时/日志 | rustCoreDaemonRuntime、submitted-write boundary、IPC/logger | 提交后错误阻断跨后端fallback仍在；不能将transport保护等同数据库原子性；F-05 |

## 可重复观察与验收结果

```sh
node docs/audits/observe-chain-audit.cjs
npm run verify
```

观察脚本直接调用真实TS authority、signal、revision barrier，仅替换Electron广播sink。当前F-01a/b、F-02、F-03a/b的`reproduced`均为true，分别输出标签与广播次数。**它是审计观察器，不加入verify，不把错误现状冻结成期望；修复后reproduced应变为false，并另写正确性回归门。**

本轮完整verify退出0，104/104。没有更改测试fixture来让观察通过。Rust F-04未运行原生测试，SQL顺序的SQLite重建不能替代后续Rust故障注入。Windows/NAS/GUI缺口沿用D-11。

## 后续最小修复顺序

1. F-04：Rust本地标签事务（绑定+目录+必要metadata），再分别审查共享/预览的commit后失败；每域独立提交和原生故障门。
2. F-01/F-02：统一“未确认意图→确认→允许外部状态”的字段级生命周期，两者可以共用设计，但需分别保留反例。
3. F-03：完整mutation身份与去重，保留跨通道去重测试。
4. F-05：贯穿必要操作身份的有限日志，再用Windows操作回执校验全链路实际时序。

在上述问题修复并补足实机回执前，专项不标记“全链路完全通过”。本报告仅陈述本次发现，不承诺覆盖所有可能缺陷。

工具记录：Mermaid已记录真实断点链；Create State返回Context Captured同时提示No active world model，未确认本项目级保存。Git及本报告为权威证据。此次只读代码审查未引入新第三方API，未触发Context7。


## Windows反馈专项审计：停用、同步与预览

日期2026-09-17；代码基线`9edd6abee966095a61d9266c85add9448df06df1`，分支`stage/09-preview-tags-app`。本节独立于上文7e0e6d7原审计，不覆盖历史发现，也不将R-07/D-11原生与Windows矩阵全部关项。

输入`startup-2026-09-17_06-18-48-939-33208.log`共1404行，覆盖06:18:48.940Z～06:19:54.533Z；SHA-256为`d003b2efbd390f0768d0c793011f0a4417fa4b92710a078916adcb68be27a630`。下列时间均按日志UTC，行号为该原文件行号。日志标记3.0.0、开发模式、Windows，未记录Git SHA，故本基线的源码复现与用户运行日志分别列证据，不断言二者二进制完全相同。原日志不入库。

只读观察器：`node docs/audits/observe-runtime-feedback.cjs`。复用现有TS加载器，生产模块不变，替换Windows命令、安装状态持久化、计时器及IPC等外部端口；不访问用户数据、不执行Windows命令。输出reproduced是观察结果而非通过条件，不加入默认verify、不给缺陷冻结快照。修复后应按正确业务期待新增回归门并使对应观察为false。

| 编号 | 结论 | 严重性与证据等级 |
| --- | --- | --- |
| W-01 | 停用成功与查询可见安装状态之间存在不一致窗口 | P1；源码、真实查询/保存队列受控复现、日志三方一致；视觉闪回未证实 |
| W-02 | 单字体安装状态变更仍走根目录全量同步 | P2；日志与源码确认；真实队列/validation路由复现 |
| W-03 | 前台预览I/O选队列会触发同步Windows探测 | P2；阻塞机制已复现；本次首屏1.7秒的精确归因未完成 |
| W-04 | 预览批查在途/未命中状态随controller渲染重建 | P2；真实队列及batch loader复现同请求重复发起；不等于重复原生渲染 |

### W-01：停用后的旧安装状态仍可重新进入查询

日志：1114～1121行，06:19:41.040资源移除成功、.042注册表删除成功、.048安装状态进入异步保存；1122～1131行，.115请求已激活页面、.119仍返回1项。1145～1166行，.568读取持久化状态、.586保存、.753同步完成；1396行06:19:53.130下一次已激活查询返回0。不能用两个查询之间的12秒推定页面一直错误12秒，也不能把主进程total=1当成用户肉眼已看到闪回。

调用链及所有者：
- `activation/runtime/fontActivationSessionRuntime.ts:42`移除资源/登记记录后，调用`fontActivationInstallStatusRuntime.ts:154`；名为save的函数仅调用schedule并立即返回。批量`fontDeactivationBatchRuntime.ts`也使用同一队列。
- `activation/activationInstallStatusSaveQueue.ts:43/92`默认延迟500ms；schedule不清查询缓存，不向查询层暴露已成功的最新状态；174行在持久化和索引同步之后才清缓存。
- `library/fontQueryWorkerRouteRuntime.ts`将active筛选排除出Rust分页，走`fontMemoryQueryRuntime.ts:18`；命中内存缓存直接返回，还会刷新缓存时间。未命中时经`fontQueryFacadeRuntime.ts:235`读取安装状态，并以`item.active || by===managed || by===both`赋active。
- `windows/runtime/temporaryActiveFontsStoreRuntime.ts`写活动记录文件不清上述查询缓存；临时登记文件已更新不能自动覆盖旧安装状态查询。renderer现有用户意图保护可能挡住旧结果，所以这里是后端查询一致性缺陷，不能直接宣称既有前端保护失效。

受控结果：先查询1项；模拟OS停用成功后进入真实保存队列，热缓存仍1项；主动清内存缓存后再查仍1项（持久化managed旧值重新补回）；真实flush在受控持久化端口完成后为0项。flush前队列触发的invalidations=0。这不是Windows原生移除测试，但证明仅提早clear cache不能消除窗口。

修复边界：由既有激活状态所有者统一提供成功操作后、持久化前的查询权威结果或明确查询屏障；不另建无生命周期的第二store。覆盖单个/批量、无记录、部分失败、同字体快速激活→停用→激活、保存失败重试及关闭flush；防止旧批次完成覆盖新操作。保留收藏/本地与共享标签/保护字段，不用延长TTL或延迟页面刷新遮掩。

验收：热/冷查询、旧查询在操作前开始后完成、批量部分失败、保存重试未完成时都不能把已成功停用字体重新查为active；新激活同样立即可见。使用生产session/queue/query贯通测试，另取Windows操作回执、查询/视觉/DB分开证明。

### W-02：具体字体在同步边界被收缩为根目录

日志674～680及1160～1166：各保存1个字体后，`fullSnapshot=true, rows=1499`；两次根同步整体158ms与166ms，Rust部分134ms与133ms。`changed=0`在fullSnapshot模式不能解释为没有写入，日志write=79/80ms。收藏六次则为`changed=1, rows=1, fullSnapshot=false`，已走增量，不能把它和激活混为同一问题。

源码：`activationInstallStatusSaveQueue.ts:159`持有affectedItems但只将affectedRoots传给`syncMergedIndexAfterInstallStatusRefresh`；`indexing/merged-page/mergedIndexValidationRuntime.ts:132`逐根调用snapshot同步；`mergedIndexSyncRuntime.ts:238`明确发送fullSnapshot=true。此前“未变化跳过保存”仅优化相同状态，不解决真实变更的整根开销。受控真实队列与validation中，1字体恰触发1个root snapshot调用；Rust/SQLite输出端口被替换，1499行实耗来自用户日志而非该复现。

修复边界：在现有增量同步owner内保留受影响字体/业务身份，正确应用本机安装状态；不要直接套收藏路径而丢失安装状态语义。保留根/签名变化必须重建的回退、跨根分组、未建立索引、删除/缺失字体、失败恢复及合批。不能为了少同步而不更新索引。

验收：单字体不读写全根，N个实际变更只同步必要行；无变化0同步；多根只触及实际根；并发合批/失败重试无丢行；1万字体与真实NAS下同时对比索引最终内容及工作量，而非单看耗时。

### W-03：首个前台预览的同步存储探测

日志139～144：06:18:51.089第一条renderPreviewImage进入主进程，下一条主进程请求直到52.342，间隔1253ms；208～243多条预览最终端到端1580～1693ms。第一条主进程I/O计时1590ms，不能全当原生渲染耗时。193行52.587才记录helper可用；这不是helper初始化独占全部等待的证据。

源码链：`preview/previewRuntime.ts:351`→`performance/globalIoRuntime.ts:123`→`ioScheduler.ts:85/95`，resolveLane同步调用storageProfileForPath；`storageProfileRuntime.ts:43`首次同步`net use`，74行同步PowerShell Get-Partition/Get-Disk/Get-PhysicalDisk。111行在构造getStorageProfile参数时就求值driveInfo，因此即使已经识别为映射网络盘也先探测本地介质。首次探测结果被缓存，所以暖态可能明显快于首屏。

受控执行真实storage profile模块，Win32端口给出O映射盘：第一次函数返回前调用顺序net→powershell.exe，最终profile=network；第二次相同路径无命令。没有在Linux伪造Windows耗时。证实前台同步阻塞机制，日志1.253秒空窗与该机制相符，但当前缺少探测起止/队列等待/读取/原生绘制分段日志，不能将1.69秒精确归因于PowerShell或排除其他I/O开销。

同链边界：`path/pathCanonicalizer.ts`另有同步net use，但现有证据不足以归因本次空窗，修复时应核对首次路径解析是否仍引入同类阻塞。`globalIoRuntime`只在拥塞时打印start，不能用缺少start日志推断未排队。

修复边界：将探测移出前台同步调用、合并同盘并发探测；冷态采用现有保守限流并在结果就绪后更新分类，映射盘跳过无意义本地介质探测。不能简单提高并发压垮NAS，也不能关闭文件校验/超时或绕过Rust准入。维持媒体分类与路径规范化职责分离。

验收：受控慢探测时主进程心跳/其他IPC继续运行，同盘并发仅一次探测，异常/超时/映射变化有恢复，网络限流保持。Windows冷启动分别记录探测、排队、缓存/文件读取、Rust绘制耗时；不能以暖启动快替代冷启动修复。

### W-04：共享队列与局部防重状态生命周期不一致

日志149～151附近同毫秒三条批查具有相同参数摘要；119条成功IPC完成记录中批量预览缓存查询40条。摘要只含数量/首项，不能由日志单独断言整个批次完全相同，更不能把40次全部算冗余。

源码：`renderer/src/runtime/app/usePreviewController.ts:52`每次render创建queueRuntime。queue/queuedIds/activeLoads/loadingFonts用useRef跨render保存，但`fontVisiblePreviewQueueRuntime.ts:24`的cachedPreviewBatchInFlight、checked/miss集合和调度标记，以及`fontPreviewLoadRuntime.ts:58`的miss集合都是factory局部变量。新render获得共享队列却丢失旧批查在途标记；旧Promise也仍持有旧runtime回调。batch查缓存期间尚未进入ensurePreviewFont，loadingFonts保护并不能覆盖这个窗口。

受控真实visible queue与batch loader：同一实例连续process两次只发1次IPC（正常控制组）；第一批未返回时，以同一refs/同一文本字号重建runtime再process，发出第2次完全相同字体批查。这里模拟controller源码明确存在的重建，不声称执行了React GUI。未走WebFont fallback/字体绘制，相关浏览器端口未参与结论。

下游已有保护：`previewRequestSchedulerRuntime.ts`按参数和字体签名合并pending group，但group派发后已移出pending；`previewRuntime.ts:363`对原生渲染requestKey有inflight Promise，且有图片内存缓存。因此重复renderer批查不必然等量增加底层读库或重复绘图，不能删掉现有下游合并。

修复边界：在既有preview controller中让批查状态与共享队列生命周期一致，并确保读取最新options；不要只useMemo([])冻结旧文本/选择/字体参数。覆盖文本/字号token变化、滚动、页面切换、删除字体、卸载、失败重试及旧Promise完成；旧请求不能清除新一代在途标记或消费新队列。miss缓存有界且有正确失效，不以永久记miss抑制新缓存。

验收：受控Hook rerender期间同token/同字体在途批查只一次；不同文本/字号仍各自请求；旧代结果拒绝且不污染新队列；失败后可重试；卸载不留timer/idle回调；保留现有主进程batch/prefetch取消与渲染去重门。增加跨controller-render覆盖，不只测单次factory。

### 回归覆盖、限制与处理次序

- 新观察器运行退出0，W-01～W-04全部reproduced=true；表示成功观察到缺陷路径，不是修复完成。无源码变换、没有把缺陷断言为必须保持。
- 原`check-activation-save-queue-durability.cjs`、`check-active-view-consistency.cjs`、`check-preview-batch-read.cjs`均退出0。分别侧重保存重试/退出、renderer意图结算、主进程批量读取；未覆盖本次查询读旧DB窗口、1字体同步工作量、冷态同步媒体探测、controller重建期间的批查防重。
- 本轮仅文档与观察器，没有执行全量verify/构建或Rust故障测试；R-07的113/113为前次证据。没有正式DB改写、窗口操作、网络/OS实测，不声称本次已修复或完成R-07。
- 优先W-01（状态正确性），随后W-02（同链工作量）；W-03冷态阻塞与W-04请求生命周期分别处理，避免一次改动同时改变调度/缓存/一致性导致无法定位回归。
- 本次6次收藏/取消均92～123ms且1行增量；10个mutation摘要new/duplicate成对；2个本地意图有post-ack-read-confirmed；已激活字体Rust文件预览路径有实际日志；关闭flush保存成功。这些仅覆盖日志中操作，不替代故障/多根/NAS断连验收。
- shared tag ops replay的3个冲突是已有6条操作的回放结果（changed=0），没有对应冲突样本，独立保留待查，不加入本次四项修复范围。首个收藏视觉延迟也未被本次日志证明完全消失。


## Windows反馈四项修复结果

2026-09-17，修复基线`c352c81c1cf9d1511db967821a7dc1d4fa212d09`，原分支`stage/09-preview-tags-app`。上一节保留修复前历史证据；本节说明当前行为，不能把旧观察器的true当成修复后结果。

| 问题 | 已实现的修复 | 当前受控验证 |
| --- | --- | --- |
| W-01 停用后查询旧状态 | 原激活保存队列保留待写入及在途结果；查询经组合根使用它们，新pending优先于旧in-flight。入队、覆盖释放时失效缓存，跨generation的active分页/内存查询重读；有持久化结果时不再以旧item.active覆盖它 | 热/冷查询在保存前均返回0；快速反向操作以最新成功结果为准；写入失败保留覆盖、恢复后释放；旧DB读晚于释放仍返回新状态；收藏/本地标签/共享标签/保护字段保持 |
| W-02 单字体全根同步 | affectedItems经原组合根和validation保留到增量owner；仅目标根安装签名变化允许增量，继续传installDbPath。未提供items的全局安装刷新仍走原snapshot | 单字体发送一个relativePath、fullSnapshot=false；重复根去重；索引签名、其他根签名及根集合变化仍要求重建；原未变化跳过写入/同步门保留 |
| W-03 前台同步探测 | 原storage profile owner以execFile异步合并net与介质探测；分类未完成使用原network限流配置；已知映射盘直接返回network，跳过本地PowerShell | 首次返回前无同步子进程；探测挂起期间事件循环继续；同盘请求合并；介质失败5秒后可重试；映射过期刷新、环境覆盖保留 |
| W-04 render重建防重状态 | 原preview controller用两个ref维持同一runtime及最新options；visible queue和load generation随reset/dispose失效；旧Promise不能清新代在途/加载标记，timer/idle清理；IPC失败不记永久miss | 实际Hook受控rerender只发一个在途批查；新文本重新请求；旧结果被拒绝；批查失败延迟重试；cleanup/setup可恢复；卸载不写图片；单字体缓存/URL/WebFont晚到不继续旧回退 |

生命周期：没有第二个激活业务store，in-flight是原待持久化批次的只读结果快照；成功结算释放，失败合回原pending，正常退出沿用原flush/重试。preview仍保留原40个controller状态初值；新增两个ref只持有runtime和端口，未向App暴露队列。每字体miss表沿用800上限；visible checked/miss集合在批查/加载完成时清除已离队字体，reset/dispose清空。storage按单一映射缓存、26个盘符媒体缓存/在途集合持有结果，无按文件路径增长的缓存；映射成功缓存30秒、介质成功5分钟、失败5秒，按需刷新，无新增轮询计时器。

默认门`diagnostics:runtime-feedback`复用现有TS加载器，加载真实queue、facade、memory/page cache、validation/incremental、storage profile及preview controller/queue/load；仅替换OS、持久化、IPC与React挂载端口。LF/CRLF正常路径通过；将最新状态优先级反转、移除安装增量准入、移除映射盘短路、恢复每render创建runtime，8个退化运行均在对应业务断言失败，不以语法/编译错误代替反例。可选`--case=<activation|incremental|storage|preview> --baseline=c352c81`替换该链的历史目标模块，四项均退出1，分别命中热查询旧active、单字体重建、同步命令、重复批查断言。它们不是Windows实机测试。

当前只读观察器复用修复门四条链，成功才报告reproduced=false；异常报告null及错误，不把任意运行失败都算旧缺陷重现。修复前原脚本仍可由`git show c352c81:docs/audits/observe-runtime-feedback.cjs`查阅，不另外保存副本。

既有冻结契约仅迁移真实冲突：原“未变化不清缓存”调整为覆盖进入/释放清缓存但仍不写DB/同步；原内存generation结构从return items改为重读并加强原调用者结果断言；preview inventory只新增两个runtime ref/tokenHash、三个受影响preview源码摘要及dispose/resume/effect端口。原基线摘要迁移前逐一核对；40字段初值、其他controller、metrics/分页隔离与原变异断言未删除。

验证结果：`npm run verify`退出0，TypeScript与114/114诊断通过；最终改动另行复跑typecheck。`electron-vite build`成功，main/preload/renderer模块数366/1/196，随后混淆3/3成功；公钥同步成功。没有运行需要Cargo的完整`npm run build`或安装包构建。四项只读观察reproduced=false，旧版本四项业务断言失败，修复版LF/CRLF和8个退化检查通过。Linux、Node24.19.0/npm11.9.0；输出记录/tmp/hfm-feedback-verify-final.log、/tmp/hfm-feedback-regression.log、/tmp/hfm-feedback-observer-final.json，Git中保存测试入口与结论，不提交机器日志。

保留限制：
- 当前Linux无Cargo、Windows GUI/NAS；没有执行真实Rust工作进程、COMMIT故障或Windows视觉验收。原生源码、DB schema、IPC、依赖和两套preload均未修改，R-07既有原生/实机待验项不因此关闭。
- W-02的单根单字体变更已有增量工作量证据；多根同时改安装签名时保守重建仍可发生。故不承诺所有批量场景均只读N行；未索引、外部变化、恢复重建保留原正确性路径。
- W-03仅消除storage profile中的同步net/PowerShell。路径规范化的独立同步net use尚在；它涉及路径身份语义，本次没有证据将其与首屏间隙等同，不混改。冷启动的队列等待、读取和真实绘制耗时仍需分段复验，不能把此前1.69秒全部归因或宣称已经减少固定时长。
- W-04不能撤销已提交到主进程的原生任务；本轮阻止旧结果/后续回退污染及重复发起，保留主进程现有合批/渲染去重。React调度由受控Hook模拟，不能代替真实Electron滚动与长期内存观测。

Windows回执：拉取修复提交后运行`npm run verify`和`npm run dev`，保留Git SHA。分别检查停用后立即切已激活页面、快速激活/停用反向操作、单字体同步日志的changed/rows/fullSnapshot、冷启动首屏、修改预览文本/字号及快速滚动切页；GUI、IPC与持久化结果分别记录。正常运行无需安装包命令。故障和NAS断开操作仅在隔离测试根执行。
