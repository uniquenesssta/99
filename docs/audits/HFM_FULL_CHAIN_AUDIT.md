# HFM 全链路审计

日期：2026-09-16。代码基线：`7e0e6d74b4a7f06abf06edae92c3b587970a96c6`，分支 `stage/09-preview-tags-app`。本轮为审计，不修改生产代码或冻结测试期望。

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
