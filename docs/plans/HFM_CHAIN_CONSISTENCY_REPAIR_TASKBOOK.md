# HFM 全链路一致性修复任务书

## 0. 状态与执行入口

- 文档版本1.0；日期2026-09-16；软件3.0.0；仓库uniquenesssta/99。
- 建立基线：`58a3f25e632a2af1d49587ab065e0469da4bf330`；执行分支沿用`stage/09-preview-tags-app`。开工时重新核对远端、HEAD与工作树，不默认为本基线一直最新。
- 当前仅完成任务规划，R-01～R-07全部未开始。本次只提交文档，不实施修复或日志功能。
- 证据：[全链路审计](../audits/HFM_FULL_CHAIN_AUDIT.md)、[只读观察器](../audits/observe-chain-audit.cjs)。F-01/F-02/F-03已有真实TS受控反例；F-04为源码与SQLite顺序重建证据，尚无原生Rust故障测试；F-05为跨层日志关联缺口。
- 承接[原拆分任务书](HFM_PREVIEW_TAG_APP_DECOMPOSITION_TASKBOOK.md)的C-01～C-07、X-01～X-13与Windows待验项。本书是新增五项审计问题的执行入口，不重启D阶段，不宣称D-11完整关闭。
- 用户要求：**日志最先实施并验收，后续修改须利用该日志验证真实链路。** 用户使用`npm run dev`，不要求build:win、安装包或重新安装。

## 1. 执行顺序和准入

| 任务 | 对应发现 | 交付范围 | 前置条件 |
| --- | --- | --- | --- |
| R-01 | F-05 | 全链路关联日志与日志验收器 | 确认基线及既有复现 |
| R-02 | F-04 | Rust本地标签绑定/目录/必要metadata原子提交 | R-01日志门通过，能读取其阶段证据 |
| R-03 | F-04同类 | Rust共享metadata提交后失败语义 | R-02自动验证；原生缺口如实登记 |
| R-04 | F-04同类 | Rust预览缓存commit后metadata边界 | R-03自动验证；原生缺口如实登记 |
| R-05 | F-01、F-02 | 标签意图、确认、失败重试生命周期 | R-01日志；R-02～R-04按顺序完成可执行验证 |
| R-06 | F-03 | 完整变更身份与跨通道去重 | R-05自动验证；R-01关联链可用 |
| R-07 | 全部 | 全链路回归、日志对照、Windows验收与收尾 | R-01～R-06已交付；禁止缺证据关项 |

同一时间仅一个任务“实施中”。R-01可以包含必要的trace字段跨层传递，但禁止先混入业务修复；R-02～R-06各自保持独立提交。R-05两个发现统一设计、分别保留反例和完成状态。

状态仅用：未开始、实施中、自动验证通过待实机、完成、阻塞。Linux验证不能代替Windows/Rust原生结果。后续任务若继承环境缺口，执行卡须明确列出；自动门失败或日志链断裂时不得以此为已验证基线继续。R-07必须有全部必需实机与原生证据才可“完成”。

## 2. 不可破坏约束

1. 本地标签、共享标签、收藏、删除保护独立；重试仅重试未成功字段/目标，旧快照不得覆盖其他域的新值。
2. 不改变字体id/sourceId/路径规范化和历史持久化身份，不改变空标签保留与显式删除语义。
3. Rust已提交任务失败不允许偷偷转Node或one-shot再次写入；原有显式兼容回退策略保持。
4. 数据库格式、schema、缓存键、IPC名称、preload方法名称、UI/CSS、依赖版本不变。不引入新全局store、第二写队列、原始可变Map外泄或通用日志框架。
5. R-01允许为了跨层关联而增加**内部、可选、向后兼容的trace元数据**，必须先列出精确协议/调用方清单、缺字段兼容和序列化测试；它不是业务幂等或去重键。其他公开协议/数据格式扩展需另行评估，不用日志名义绕过边界。
6. 七controller所有权、Hook顺序、effects清理与写队列flush→库保存→关闭确认顺序不变。数据库借用句柄不关闭，自有句柄finally关闭。
7. 不能以增加TTL、延迟刷新、全局串行或屏蔽外部更新代替一致性修复；不能把异常全部吞掉制造成功。
8. 不复制大接口、不新增any/ts-ignore/万能上下文；既有SQLite any不在本专项顺手重构。
9. 每项先旧实现失败、再同用例新实现通过，并至少一个退化变异被拒绝；不整体重录hash/snapshot、不删失败门、不把日志文本存在当作事务成功。
10. 修复、纯搬迁、无关清理和依赖升级不得混入同一提交。本书只允许修复与必要接线，不继续拆大文件。

## 3. 强制执行卡与范围白名单

每项开工前写入本书执行记录：

```text
任务/状态：
实际HEAD/分支/远端/工作树：
前置任务与继承缺口：
精确允许文件路径（含每个诊断、fixture、调用方和文档）：
新增模块职责/唯一状态所有者/调用方（无则写无）：
问题证据、旧失败输出、触发条件：
变更分类及不可改变契约：
测试加载的真实模块/替换的外部端口/未覆盖范围：
日志样例：operationId、attemptId、阶段序列、关联结果：
验证命令、环境、退出码、实际用例数、退化变异：
Windows/Rust回执或待验原因：
差异审查、README/任务状态、回滚提交定位：
插件结果与失败记录：
```

以下各节列出的文件是**审计导航，不是无限授权白名单**。实施者必须先补齐精确允许路径；禁止“相关runtime”“必要其他文件”等兜底项。范围内必要直接接线可登记证据后按既有授权继续；数据格式、无关领域或新增功能扩展暂停该扩展，不影响已授权范围的定位。

每项验证后原子提交并按长期授权直接推送当前分支，不重复询问。禁止强推、修改main、覆盖用户改动。README是唯一变更记录；任务书保存执行证据，审计报告保留原始发现并链接修复结果。

## 4. R-01：首先建立可验证的关联日志

### 4.1 目标与源码导航

用户操作必须能够从renderer意图、队列、IPC、Rust执行/提交、信号直到页面接受/拒绝关联起来。复用既有startup logger、renderer trace与Rust daemon事件；审查入口：

- `src/renderer/src/rendererPerformance.ts`、`fontWriteQueueRuntime.ts`、`fontTagStateAuthorityRuntime.ts`、`runtime/app/effects/useFontTagStateSignalEventRuntime.ts`。
- `src/preload/index.ts`、`src/shared/types.ts`及实际协议类型模块（开工核对，不能猜测所有类型都在此文件）。
- `src/main/ipc/ipcTraceRuntime.ts`、`src/main/library/tagMutationStateSignalRuntime.ts`、`src/main/rust-core/rustCoreDaemonRuntime.ts`、`src/main/logging/startupLog.ts`。
- Rust实际命令payload/result、daemon事件及`native-src/hfm-core-worker/src/mutation_protocol.rs`（开工核对定义位置）。

先冻结各边界真实字段与生产日志出口，确定最小传播方式。**不得只记录IPC起止就宣布全链路日志完成。** 原生Rust关联无法执行时标记待原生验证，不能用Node假任务伪装。

### 4.2 最小日志契约

| 字段/概念 | 必须满足的语义 |
| --- | --- |
| sessionId / operationId | 区分应用会话；一次用户意图固定身份，多次连续点击不能共用同一个身份 |
| attemptId / batchId / parent | 重试复用operationId、每次尝试不同；合批能追到每个成员意图；拆批/删除等必须可关联 |
| domain / target | localTags/sharedTags/favorite/protection等字段域分离；目标ID或有界摘要，必要时记录数量 |
| stage / outcome | queued、dispatch、backend-start、commit/rollback、signal、view-apply/view-reject、retry/cancel等，明确失败/未知/已提交 |
| revision / generation | 后端revision、renderer意图代次、查询序号分别命名，不混为一个可比较数字 |
| reason / timing | 拒绝旧结果、失败重试、目录过滤、去重命中等原因；跨进程时间只作辅助，顺序靠身份与阶段 |
| backend / transport | Node/Rust、daemon/one-shot及实际job身份，能区分回退、重试和重复事件 |

Trace ID只用于诊断；不能驱动业务去重、授权、持久化主键或改变执行顺序。没有关联字段的旧消息标记unlinked/legacy，不虚造完整上游链。只读查询可通过causedBy关联触发它的变更；失败前没有commit的操作不能输出commit成功。提交失败/确认未知必须分别记录。

### 4.3 非干扰与容量要求

- 日志失败、目录不可写、编码异常、队列已满不改变业务返回值/事务结果，不引入未处理拒绝；字段编码必须有界且不可因循环对象阻断业务。
- 不增加同步磁盘I/O到卡片/滚动/输入热路径，不新增数据库/业务队列实例。优先沿用现有缓冲、flush和采样。
- 在执行卡中固定事件最大字节数、关联列表上限、缓存容量、过期/清理策略与日志保留策略的具体值，并说明依据。溢出必须有截断/丢弃计数，不能静默把部分链说成完整链。
- 后续修复的关键commit/rollback、意图确认/拒绝、去重决策在验收模式下不可被普通性能采样抹掉；详细模式明确启停，生产默认策略保留。
- 不记录许可证、密钥、完整字体对象、预览base64或无必要绝对路径；trace元数据不写入字体业务表、共享标签内容或持久化用户配置。
- reload/重开、重复挂载/卸载后无多余监听器、计时器、关联表泄漏；关闭先完成原业务flush，再尽力flush日志，日志失败不阻止退出。

### 4.4 必过测试与交付

1. 两次同字体同域连续编辑，日志能区分操作；跨域交错不混线。
2. 两次失败后成功：一个operation、多个attempt，只有真实提交时出现commit；后端已提交但确认未知不得记rollback。
3. 多目标批次部分失败，成功成员不重试，日志保留成员对应关系；截断时有计数和可追溯摘要。
4. Rust daemon与worker重复事件仍能关联同一提交；旧消息缺trace字段兼容。
5. 日志出口抛错/磁盘失败/满容量时，原返回值、事务、状态更新及关闭顺序保持。
6. 事件数与缓存大小有界；重复挂载、重开会话、并发读写不会复用错误身份。
7. 退化变异：去掉一次关键跨层传播必须使日志验收器失败；把不同attempt合成一项或伪造commit顺序也必须被拒绝。

新增日志验收器必须在实际执行路径上收集事件、检查关联与阶段关系，不只搜索源码字符串。提供两份脱敏可读样例：成功链、失败/重试链。日志输出本身不能代替数据库回读和UI状态断言。

R-01完成判据：关联协议/类型检查、非干扰/容量/清理门、真实路径样例、全量verify均通过；Rust/Windows未执行的部分单列待验。后续每个R任务必须用本验收器验证其路径；若实现阶段发现缺少必要日志，先补R-01能力与验证，再继续该修复，不绕开前置要求。

## 5. R-02：Rust本地标签事务完整性

导航：`native-src/hfm-core-worker/src/local_tags/state_machine.rs`、`catalog.rs`、`schema.rs`及同域测试；Node对照`src/main/library/runtime/localFontTagNodePersistenceRuntime.ts`。

步骤：

1. 使用真实Rust入口、隔离临时SQLite建立旧失败反例：绑定事务提交后目录或localTagsUpdatedAt失败，返回失败但绑定残留。
2. 让绑定、目录、必要metadata在同一事务里完成；目录所依赖的前后绑定集/目录读取必须属于同一一致性范围，避免并发读改写丢更新。不得逐项提交假装批量原子。
3. 只在commit成功后产生成功结果/通知；提交后日志、序列化或通知失败的处理语义逐项审查，不能伪造回滚，也不能盲目重放不可确认写入。
4. 保留单项/批量/删除五方法相关契约、updatedIds、空目录、重复身份及原兼容准入。

必过：第N项失败、目录触发器失败、metadata失败、commit失败；第二连接回读绑定/目录/其他字段；单项/批量/显式删除/空输入/无变化；提交后日志故障；无跨后端重放；退化“把目录移回事务外”必须失败。验证日志中commit/rollback与真实回读一致。不能用Python SQL顺序重建或Node SQLite测试代替本项Rust测试。

## 6. R-03：共享metadata提交完整性

导航：`native-src/hfm-core-worker/src/shared_metadata/state_machine.rs`、`signature.rs`及必要同域测试；主进程`src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts`。

冻结lease/revision冲突、ops/events归档/回放、last-writer合并及三个字段隔离语义。把共同决定提交结果的状态/metadata纳入一致事务，检查signature读取/序列化的提交后错误边界；不改变冲突算法。

必过：apply与deleteTag中metadata、ops/events第N项、commit失败；数据行/事件/metadata由第二连接回读一致；冲突与离线分支不能覆盖其他字段；已提交后故障不误报已回滚/跨后端再写。原shared-tag-conflicts/replay/archive门继续通过；新故障路径以R-01日志证明落在哪个阶段。

## 7. R-04：预览缓存提交完整性

导航：`native-src/hfm-core-worker/src/preview_cache/write.rs`、`schema.rs`及必要测试；`src/main/preview/runtime/previewIndexAccessRuntime.ts`。

先界定updatedAt是否属于命令成功的必要状态；必要则并入事务，非必要则显式定义已提交结果与诊断，不允许随意吞错。保留缓存key、行字段、missing/failed语义、句柄边界和D-02实际结算后的generation失效。

必过：行第N项失败、meta失败、空输入/跳过无效行、commit失败；写/删交错、超时后底层晚完成及新一代读取；本地借用句柄不关闭、共享句柄finally关闭。原preview-index-commit/owner/batch/generation门保持；新事务测试需真实Rust/SQLite。日志不得将“调用超时”写成“事务已回滚”。

## 8. R-05：标签意图与确认生命周期（F-01、F-02）

导航：`src/renderer/src/fontTagStateAuthorityRuntime.ts`、`fontTagMutationRuntime.ts`、`fontDialogTagActionsRuntime.ts`、`fontWriteQueue.ts`、`fontWriteQueueRuntime.ts`、`runtime/app/effects/useFontTagStateSignalEventRuntime.ts`及直接查询合并调用方。

先写状态转移表：未提交→发送中→可重试失败→已提交待确认→已确认/取消，并明确新意图覆盖旧意图、旧ack到达、外部更新、reload和关闭行为。复用原队列/所有者；不要建立与队列相互同步的第二领域store。

核心要求：

- 按字体与字段区分编辑代次，明确ack对应哪次写入；trace ID可以关联日志，但不能未经契约设计直接当业务确认依据。
- 旧ack不得清除新dirty；其他字体的knownTags目录更新不得过滤仍pending的新增标签。
- 未成功写入不能仅因20秒到期失去保护；同时已确认意图须允许后续真实外部修改/删除，不得永久覆盖后端状态。
- 不用Date.now和后端revision混成同一因果序列。旧/缺字段广播的兼容路径必须明确，不能无条件确认。
- 成功、失败、取消、旧操作被替代、批次部分成功与关闭flush均需正确结算；每条日志指出接受/拒绝的代次与理由。

必过矩阵：同字体第二次编辑先于第一次ack、其他字体ack携旧目录、跨域反向完成、新增后删除/删除后新增、空目录显式删除、20秒和数分钟重试、成功后外部删除、部分失败重试、缺revision消息、reload不恢复会话pending、关闭失败保留待保存提示。F-01a/b、F-02观察变为不复现，并转入必过诊断；移除代次判定/恢复TTL清除的变异必须失败。收藏、共享标签、保护其他字段逐项快照不变。

## 9. R-06：信号去重身份（F-03）

导航：`src/main/library/tagMutationStateSignalRuntime.ts`、`tagMutationWriteProtocolRuntime.ts`、共享signal适配以及实际Rust协议生产点。

先设计业务mutation identity：存储域（db/root）、完整操作语义/提交身份、跨daemon和worker同一提交的身份一致性；R-01trace仅作诊断。优先使用现有可靠提交身份；若必须加内部字段，列出精确兼容范围，不能为去重改数据库主键。

必过：两个根同时间/空IDs；同前80个ID第81项不同；目录内容变化但IDs相同；同提交双通道重复；乱序/缺字段/无变化；容量上限及过期。新操作必须revision→清缓存→广播，真正重复仅一次。日志记录接受/去重原因与关联身份，避免输出无界ID列表；删存储域/截断ID/错误地按attempt去重的变异必须失败。

## 10. R-07：闭环验收

- 完整`npm run verify`，记录实际数量/版本/退出码；原10k查询、500次布局、500项选择、详情开关与卡片引用门不放宽。
- 运行R-02～R-04真实Rust故障测试及D-03遗留身份读取测试，记录命令、用例数、结果。没有Cargo写阻塞/待验，禁止以TypeScript通过替代。
- Windows拉取后`npm run dev`，按原X-01～X-13以及D-11第27节执行；重点快速连续标签/收藏/激活跨页、目录监听、NAS恢复、立即关闭重开。不要求安装包。
- 每条关键实机回执包含提交、操作顺序、肉眼实际反馈、对应operation/attempt与日志位置；同时数据库/返回值/界面断言通过。日志缺失只能记证据缺口，不能反推操作失败或成功。
- F-01～F-05逐项登记：旧反例、修复提交、自动证据、原生证据、实机证据、剩余限制。任何必需项缺失不标全修复完成。
- 审查diff/状态所有权/新增监听器和计时器/日志容量/不变的公开API；同步README、审计报告修复链接、原任务书及总入口。

## 11. 通用测试、回滚与暂停规则

- 异步测试使用可控Promise/时钟；SQL使用隔离临时DB及第二连接；禁止操作正式字体库或破坏用户NAS。LF/CRLF兼容继续覆盖。
- 日志验收与业务断言分开：日志声称commit不等于已落库；只有SQL回读/真实返回/状态验证一致才能通过。
- 新门必须通过真实生产路径；mock只代替明确外部依赖/故障点，记录边界。不得替换核心算法后声称覆盖。
- 暂停收尾条件：必过门失败、未解释的用户改动、trace跨层断裂、出现跨域覆盖/重复写入、事务部分提交、需要未授权schema/公开API改变、原生用例缺失却要求标完成。可以继续当前授权范围定位，不重复要求推送许可。
- 每任务独立revert，公开历史不重写；回滚带trace字段时验证老消息可读取。修复日志和业务提交分别可定位，回滚业务不强迫删除已验证日志能力。数据库schema不变；如发现必须迁移，另立任务。
- AGENTS协议沿用：新/不熟悉API先查真实版本与Context7；跨模块实现更新真实Mermaid图，不绘制计划为已实现；里程碑Create State记录真实结果，插件失败不阻止可完成代码但须披露。Git/README/任务书是权威记录。

### 自动约束必须实际落地

- R-01开工登记日志诊断的准确命令/路径，接入现有diagnostics与默认npm run verify；不能只写任务书或提供手工观察脚本。
- R-02～R-06相应修复落地时，已修复反例转为必过门。真实Rust测试提供独立必需命令并作为完成条件；若verify本身不执行Cargo，必须明确分开报告，不能将其遗漏解释为通过。
- 新增/迁移owner、协议输入与trace边界必须有结构/类型门；日志关联、字段隔离、事务和异步正确性另用真实行为门证明。所有权/类型/行为检查缺项不得判完成。
- 本文定义的是未来实施要求，当前尚未创建这些新自动门，不能将文档存在等同于约束已经被CI执行。

## 12. 状态登记

| 任务 | 状态 | 执行基线/提交 | 自动/原生/实机结果 |
| --- | --- | --- | --- |
| R-01 日志前置 | 未开始 | — | — |
| R-02 本地标签事务 | 未开始 | — | — |
| R-03 共享事务 | 未开始 | — | — |
| R-04 预览事务 | 未开始 | — | — |
| R-05 标签确认生命周期 | 未开始 | — | — |
| R-06 信号去重 | 未开始 | — | — |
| R-07 总验收 | 未开始 | — | — |

本次文档交付：新任务书及README/总任务书/原专项/审计报告入口更新；不启动R-01。下一条“开始R-01”进入日志实施。

文档验证记录：本轮仅5份Markdown变更；链接目标与任务编号已核对，git diff --check通过，未重复运行未变化生产代码的verify。Create State返回Context Captured同时提示No active world model，未确认项目级保存；Git文档保留完整约束。
