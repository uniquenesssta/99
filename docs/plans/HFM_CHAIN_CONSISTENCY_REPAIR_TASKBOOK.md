# HFM 全链路一致性修复任务书

## 0. 状态与执行入口

- 文档版本1.8；日期2026-09-17；软件3.0.0；仓库uniquenesssta/99。
- 建立基线：`58a3f25e632a2af1d49587ab065e0469da4bf330`；执行分支沿用`stage/09-preview-tags-app`。开工时重新核对远端、HEAD与工作树，不默认为本基线一直最新。
- 当前R-01日志实施与自动验证通过，待原生/实机回执；R-02自动验证通过待实机（原生测试未执行）；R-03自动验证通过待实机（原生测试未执行）；R-04自动验证通过待实机（原生测试未执行）；R-05自动验证通过待实机，见§20；R-06自动验证通过待实机，见§21；R-07自动验证通过待实机，见§22。Windows/Rust原生证据单列，不宣称全部修复完成。
- 证据：[全链路审计](../audits/HFM_FULL_CHAIN_AUDIT.md)、[只读观察器](../audits/observe-chain-audit.cjs)。F-01/F-02/F-03已有真实TS受控反例；F-04为源码与SQLite顺序重建证据，R-02～R-04已补原生Rust故障测试但本环境尚未执行；F-05为跨层日志关联缺口。
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
- R-01的operation-chain门已接入默认verify；R-02/R-03/R-04已有默认约束门和独立原生验收入口；R-05的tag-intent-lifecycle已注册默认verify，最终结果见§20；R-06的tag-mutation-identity已注册默认verify，原生入口单列，见§21。

## 12. 状态登记

| 任务 | 状态 | 执行基线/提交 | 自动/原生/实机结果 |
| --- | --- | --- | --- |
| R-01 日志前置 | 自动验证通过待实机 | 2cf2986起，本R-01独立提交 | TypeScript、105/105；Cargo退出127；Windows待验 |
| R-02 本地标签事务 | 自动验证通过待实机 | cee7970 | 106/106；无Cargo，原生及Windows待验 |
| R-03 共享事务 | 自动验证通过待实机 | cee7970起，本R-03独立提交 | 107/107及12个TS场景；Cargo缺失，原生/Windows待验 |
| R-04 预览事务 | 自动验证通过待实机 | 8b60ee7起，本R-04独立提交 | 108/108及16个客户端场景；Cargo缺失，原生/Windows待验 |
| R-05 标签确认生命周期 | 自动验证通过待实机 | b7f68e1起，本R-05独立提交 | TypeScript、111/111、三端构建；§20，Windows待验 |
| R-06 信号去重 | 自动验证通过待实机 | eded4db起，本R-06独立提交 | TypeScript、112/112、三端构建；§21，Cargo/Windows待验 |
| R-07 总验收 | 自动验证通过待实机 | 5406f74起，本R-07独立提交 | TypeScript、113/113；§22；六个原生入口因Cargo缺失未执行，Windows/NAS待验 |

建书时的文档交付：新任务书及README/总任务书/原专项/审计报告入口更新；不启动R-01。下一条“开始R-01”进入日志实施。

文档验证记录：本轮仅5份Markdown变更；链接目标与任务编号已核对，git diff --check通过，未重复运行未变化生产代码的verify。Create State返回Context Captured同时提示No active world model，未确认项目级保存；Git文档保留完整约束。

## 13. R-01 执行卡

- 状态：自动验证通过待实机。实际基线2cf29864e12a2977d93f68412c3e986ccba5453f，stage/09-preview-tags-app；fetch后远端一致，开工工作树干净。
- 继承缺口：没有Cargo，Windows GUI/NAS未执行；不将原生关联视为已验证。
- 最小传播：renderer队列条目的WeakMap只保留诊断身份（不进入字体数据）；每次dispatch单独attempt，合批逐成员记录batch关系。preload六个写方法增加可选末尾trace参数，两种preload保持一致；IPC剥离可选末尾诊断信封后用AsyncLocalStorage隔离当前异步操作；临时Rust输入增加可选trace；Rust同一执行作用域在真实commit后输出证据，信号携带trace，主进程去重/广播与renderer接收记录决策。无trace旧调用标记unlinked，不冒充UI意图。
- 新模块：共享operationTrace仅协议/有界编码；renderer/fontOperationTrace仅WeakMap诊断身份和既有日志出口；main/logging/operationTraceContext仅异步诊断作用域，不建立领域store；Rustoperation_trace仅命令作用域日志，不改事务。
- 日志限额：单事件最多8192 UTF-8字节，信封最多16成员；全批成员通过逐成员dispatch记录batchId，截断计数显式可见。renderer最多256在途日志调用，超出计入dropped，下次成功发送报告；WeakMap不持有条目强引用，不新增定时器或监听器。主进程复用startup日志80ms/64KiB缓冲，新增日志仅详细模式持久化；文件保留沿用现状（没有自动删除，不新增删日志策略），本轮新增关联输出每会话最多16MiB，超额明确计数。业务flush/关闭顺序保持。
- 准确新增门：build/diagnostics/check-operation-chain.cjs，npm run diagnostics:operation-chain，接入默认verify。Rust用例独立cargo test --manifest-path native-src/hfm-core-worker/Cargo.toml operation_trace；未运行不算通过。
- 精确生产白名单：
  - src/shared/operationTrace.ts
  - src/renderer/src/fontOperationTrace.ts
  - src/renderer/src/fontWriteQueue.ts
  - src/renderer/src/fontWriteQueueRuntime.ts
  - src/preload/index.ts
  - src/main/preload/runtimePreloadSource.ts
  - src/main/logging/operationTraceContext.ts
  - src/main/ipc/ipcTraceRuntime.ts
  - src/main/performance/rendererInteractionRuntime.ts
  - src/main/library/tagMutationStateSignalRuntime.ts
  - src/shared/types/scanTypes.ts
  - src/renderer/src/runtime/app/effects/useFontTagStateSignalEventRuntime.ts
  - src/main/rust-core/rustCoreWorkerTransportRuntime.ts
  - src/main/rust-core/rustCoreDaemonRuntime.ts
  - src/main/library/runtime/localFontTagNodePersistenceRuntime.ts
  - native-src/hfm-core-worker/src/main.rs
  - native-src/hfm-core-worker/src/operation_trace.rs
  - native-src/hfm-core-worker/src/local_tags/state_machine.rs
  - native-src/hfm-core-worker/src/local_tags/types.rs
  - native-src/hfm-core-worker/src/shared_metadata/state_machine.rs
  - native-src/hfm-core-worker/src/shared_metadata/types.rs
  - native-src/hfm-core-worker/src/preview_cache/write.rs
- 精确诊断/文档白名单：build/diagnostics/check-operation-chain.cjs；package.json；README.md；本任务书。既有隔离加载器如因新import失败，先逐个登记再补接线，不批量重录hash。

### R-01 接线补充（实施中）

- 真实Node链已出现先前缺失的queued→dispatch→IPC→SQLite commit→signal→view-apply→queue-settled；同一队列条目两次SQL触发器失败后第三次成功，前两次第二连接回读0行，第三次1行。去掉preload实际传播的变异被拒绝；不是源码关键字门。
- 首次旧门失败为隔离加载器不认识新增日志import，非产品结果差异。登记追加白名单：build/diagnostics/check-decomposition-baseline.cjs（加载真实日志模块，保留原算法mock边界）；docs/audits/operation-chain-samples.json（实际Node验收输出，原生待验）。
- 传播审计发现本地/共享signal归一化会复制字段，需保留可选trace才能关联daemon与worker同一span；登记追加src/main/library/runtime/localFontTagsRuntime.ts（仅类型字段）、src/main/library/runtime/localFontTagMutationEffectsRuntime.ts、src/main/indexing/shared-metadata/sharedMetadataMutationSignalRuntime.ts、src/main/rust-core/rustCoreWorkerContracts.ts（仅类型字段）。
- Node共享metadata实际COMMIT也需证据，追加src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts，仅在已有BEGIN/COMMIT/错误位置记录，不改事务或回退。

- 基线迁移追加build/diagnostics/fixtures/decomposition-baseline.fixture.json：仅localFontTagsRuntime新增可选trace类型成员的tokenHash。将旧/新源转译成JavaScript逐字比较必须一致，其他inventory字段和fixture项不动。

- 同一fixture再精确迁移两项：localFontTagNodePersistenceRuntime（仅日志调用），localFontTagMutationEffectsRuntime（仅可选trace透传）。迁移前移除本轮日志/trace语句后tokenHash经AST打印规范化后必须等于HEAD原文件；其余exports/owner/surface均保持。不整体重录fixture。

- 新增原生真实入口验收白名单：native-src/hfm-core-worker/tests/operation_trace.rs（启动实际worker、临时SQLite、第二连接回读；当前环境无法运行）。追加build/diagnostics/check-font-write-queue-durability.cjs，仅为其独立加载器接入真实fontOperationTrace，原断言不删。

- 非队列重命名/删除需要独立意图，追加src/renderer/src/fontDialogRuntime.ts：只在三个真实hfm调用点记录直接操作，不改变先flush检查、确认或回调顺序；对应两种preload的renameSharedTag/deleteLocalTag/deleteSharedTag增加可选末尾trace，旧调用不附加信封。该协议共9个可选参数入口。

- 日志非干扰包装将IPC的日志参数从runtime.appendLog换为安全append；sender校验仍严格第一条语句。追加build/diagnostics/check-ipc-sender-validation.cjs，仅更新该准确参数断言；原不可信sender反例保持。
- 追加精确冻结迁移：build/diagnostics/fixtures/react-composition-domain-controllers.fixture.json中fontWriteQueueRuntime一项；build/diagnostics/fixtures/app-interaction-composition.fixture.json中fontDialogRuntime一项。只迁移日志追踪接线，保留42状态/Hook顺序、关闭flush和重命名/删除真实行为门。

- 追加build/diagnostics/fixtures/local-tag-node-persistence.fixture.json，仅emitLocalTagsMutationStateSignal一函数的可选trace透传hash；3个SQL事务body hash全部不变。
- 追加build/diagnostics/helpers/rustWorkerTransportHarness.cjs，仅允许新增Node内置async_hooks依赖；仍加载真实日志模块，45命令/生命周期行为基线不重录。
- native日志增加backendSequence，signal携commitSequence；两条进程管道的接收先后不当作提交因果顺序。daemon-submit记录实际jobId，取消/超时明确unknown；不推断数据库已回滚。

- 追加build/diagnostics/check-rust-worker-transport.cjs：early-file-cleanup变异的准确锚点随traceRustInput包装更新，仍要求“提前删除临时输入”失败；不改原用例预期。

- 追加build/diagnostics/fixtures/local-tag-rust-adapter.fixture.json中同一emitLocalTagsMutationStateSignal函数hash；这是同一透传函数的第二个旧门，保持9函数其他项及三种回退策略反例。

- 追加build/diagnostics/check-orchestration-contracts.cjs，仅让独立加载器加载真实operationTraceContext；保留原Rust输入输出类型、命令及回退矩阵。传输回归实际数量为369个命令场景、7组序列、28文件作用域、10个变异，不是此前导航文字中的45。

- 最后一项类型冻结迁移追加build/diagnostics/fixtures/rust-worker-contracts.fixture.json，仅RustSharedMetadataMutationStateSignal可选trace字段的shapeHash；原45门面方法、38命令路由、115业务注册、7 app/2 process生命周期保持。


### R-01 验收边界与使用方法

本轮为关联日志，未修F-01～F-04；只读观察器仍复现F-01a/b、F-02和F-03，这是保留后续修复反例。信号日志的view-apply表示既有状态应用函数与commitLibraryUpdate已返回，不代表浏览器已绘制、查询已刷新或已修好旧ack问题；当前没有拒绝逻辑的地方不伪造view-reject。R-05增加实际拒绝决策时必须接入本日志。

覆盖的用户入口：四域队列写入，以及重命名共享标签、删除本地/共享标签；9个preload方法可选末尾trace保持老参数调用兼容。系统扫描/自动任务/无trace旧调用保留unlinked，不能据此宣称整个软件每个入口都已关联。Rust预览apply/delete提交点已具备输入trace诊断能力，但独立预览请求没有renderer根意图时仍未关联，R-04验证该路径前须补齐其具体调用链与验收。

测试加载真实队列、两种preload、中央IPC、Node本地标签SQLite持久化、revision/signal、renderer signal hook；替换Electron/React挂载端口与外部日志出口。SQLite使用临时DB+第二连接。Rust传输测试使用真实Node子进程模拟协议，仅证明临时输入、one-shot错误stderr、daemon分块stderr与jobId传播；**不能代替Rust执行**。原生集成测试启动实际worker，覆盖成功、写入触发器失败、catalog失败后的DB真实状态与日志相符、legacy无trace；命令已尝试但无Cargo退出127。

默认门`npm run diagnostics:operation-chain`已注册到verify。涵盖连续意图与域身份、部分成功只重试失败项、40成员合批/16成员信封截断、256在途上限、16MiB会话容量/显式丢弃计数、不同会话与并发AsyncLocalStorage隔离、旧daemon禁止错误继承、日志抛错、unmount监听清理、关闭旧门；7个日志/传播/因果变异被拒绝。正常模式不持久化新增详细日志，验收模式不作性能采样。新增状态只有诊断WeakMap/计数及异步作用域，无业务store或新增定时器。

[两份实际Node路径脱敏样例](../audits/operation-chain-samples.json)：success、retry（两次SQL失败后成功）。每成员dispatch日志用operationId关联意图、用batchId/attemptId关联后端；目标为非业务用的有界ID摘要。原生跨stdout/stderr不依赖接收时序，使用spanId和backendSequence/commitSequence。日志有dropped/omitted或缺关键阶段时判证据不完整；不能从日志缺失推断数据库失败。无确认前只记unknown，不伪造rollback；commit仅指该实际事务，metadata若仍在其后失败记committed-error。

Windows开发验收（无依赖升级，无需npm ci或安装包）：

```bat
git pull --ff-only origin stage/09-preview-tags-app
cargo test --manifest-path native-src/hfm-core-worker/Cargo.toml operation_trace
set HFM_LOG_DETAIL=debug
npm run dev
```

测试连续两次标签编辑、收藏/保护跨域交错、共享重命名/删除、立即关闭重开。沿用已有startup日志文件，搜索`operation-chain:`；同操作重试operationId保持、attemptId改变，不能把committed-error当成功或回滚。验收结束使用`set HFM_LOG_DETAIL=`关闭详细模式。实机回执需提交号、操作顺序、肉眼反馈及日志；未收到前状态为自动验证通过待实机。

Context7已核对Node 24 AsyncLocalStorage.run并发作用域与异常恢复语义；实际链路Mermaid已更新。未修改SQL、schema、依赖锁文件、业务去重键、七controller所有权、UI/CSS或关闭flush顺序。独立revert本R-01提交即可回滚，旧调用不带trace仍可工作。


### R-01 自动验证收尾

- Node v24.19.0/npm 11.9.0；npm run verify退出0，105/105（原104项保留，新日志门1项）。最终日志位于本次执行环境/tmp/r01-final-verify.log；可复现实证保留在默认诊断与样例文件。
- Electron/Vite三端生产构建通过，364/1/196模块；混淆3/3。没有运行Windows打包。Cargo真实测试尝试退出127（command not found），原生测试文件存在不等于通过。
- sender仍首条校验、既有SQL事务体hash未变；旧类型/算法冻结仅登记的精确trace接线迁移。最后no-change信号补日志后，operation-chain和local-tag-rust-adapter定向重验通过。
- 行为证据：独立字体字段回读、失败无SQL残留、合批部分成功、实际preload传播变异、并发/会话/监听清理、日志抛错/容量、两个子进程传输模式；旧关闭flush和日志耐久门通过。没有Windows GUI/NAS结果。
- R-02准入：TS/Node日志验收可用，原生观测接口已实现但待Cargo验证。后续必须继承此缺口，不能把本轮标为Rust已验收；原生实际日志若断链须先补R-01，不开始混合业务修复。

- Create State返回Context Captured但同时No active world model，未确认HFM项目级保存；未选择无关model。Git、README、任务书与样例是权威交接。

## 14. R-02 执行卡

任务/状态：R-02，自动验证通过待实机（原生必需门未执行，非完整关闭）；实际基线934139b238ad0967068fecde8766ea38de51c37e，stage/09-preview-tags-app；fetch后与origin一致，开工工作树干净。
前置：R-01默认日志门可运行；继承无Cargo/Windows原生回执缺口，不能判原生闭环。
精确白名单：
- native-src/hfm-core-worker/src/local_tags/state_machine.rs
- native-src/hfm-core-worker/src/local_tags/atomicity_tests.rs
- native-src/hfm-core-worker/tests/local_tags_atomicity.rs
- build/diagnostics/check-local-tag-rust-atomicity.cjs
- package.json
- README.md
- docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md

范围：只修本地Rust标签事务；同文件连接函数供实际命令调用和SQLite提交失败测试共用，不新增业务所有者。绑定/目录/必要更新时间及其前后读取在Immediate事务中；身份、目录保留、返回结构、显式回退不变。共享/预览事务留R-03/R-04。
旧证据：基线set/delete均在save_known_tags、localTagsUpdatedAt之前commit，目录读取也在事务前；原生旧失败/新通过暂待工具链，不用SQL重建冒充。
测试计划：真实worker临时数据库+第二连接覆盖第N行/目录/meta失败、成功/空输入/重复身份/删除；同一生产连接函数用延迟外键故障强制commit失败。默认新增门仅证明结构、退化变异与既有日志接口，不等同Rust执行；原生测试独立必需。

### R-02 变更与验证边界

- set/delete均在Immediate事务开始后读取原目录和绑定身份，统一写绑定、app_state.localTags、meta.localTagsUpdatedAt，再commit。空delete原来仍写目录/meta，现在也有一次真实事务和commit日志；结果字段及上层空参数准入不变。
- 私有set_on_connection/delete_on_connection由原命令入口调用；原生提交失败测试调用同一函数，只在测试DB上启用延迟外键并注入触发器，所有业务算法仍是生产实现。schema初始化保留事务外，schemaVersion/cacheArchitecture初始化常量不属于本次标签变更；未变更数据库格式。
- 提交后只保留原有best-effort checkpoint、内存结果构造/JSON编码及诊断。结果由字符串/数字/布尔/数组组成，无自定义可失败序列化器；日志IO错误已忽略且不改变结果。进程中断/输出管道失败仍可能产生“已提交但确认未知”，R-01记committed-error/unknown，既有Rust适配器禁止异常后跨后端再写；本轮不宣称解决所有传输不确定性。
- 原生集成4个测试（Windows3个，/dev/full日志IO故障仅Unix）覆盖第N行、目录、meta失败、重复身份/无变化/空输入/显式删除/空目录、第二连接回读与其他域哨兵不变。模块内另1个测试覆盖set/delete真实commit延迟外键失败。所有原生项目前待执行，不能把测试文件数当通过数。
- 默认结构门为独立可执行约束，不声称原生行为通过：LF/CRLF和5种退化（目录出事务、meta出事务、弱化锁、事务外读取、提前commit日志）必须拒绝；旧基线结构反例已被拒绝，原生旧失败待执行。
- `--native`强制先执行真实Cargo测试，再启动实际worker，把其stateSignal送入真实TS信号处理器并复用R-01 validateNativeStages；最后在隔离源码目录编译旧基线及目录移到commit后的变异，要求两者都在“catalog leaked partial writes”数据库断言失败。编译错误不算变异被捕获。原工作树不受变异修改。
- Context7返回rusqlite当前文档，未提供0.32.1专页；已确认项目锁定0.32.1并沿用Transaction的Immediate/默认Drop回滚API，最终版本兼容仍需原生编译。Mermaid已按实际代码更新。

原生必需命令（包含R-01日志因果、旧实现反例及退化变异；无需安装包）：

```bat
node build/diagnostics/check-local-tag-rust-atomicity.cjs --native
cargo test --manifest-path native-src/hfm-core-worker/Cargo.toml operation_trace
set HFM_LOG_DETAIL=debug
npm run dev
```

Windows复验：连续改单个/批量本地标签，清空后目录保留，显式删除后目录消失；收藏/共享标签/保护不受影响。记录真实反馈与operation-chain日志；不把F-01/F-02旧ack/TTL残留问题算本事务修复已解决。

### R-02 自动验证回执

- Node v24.19.0/npm11.9.0：R-01 operation-chain前置门退出0；npm run verify退出0，106/106，包含新增结构门及既有本地标签五方法/回退、提交后日志/信号、字段隔离、关闭门。日志/tmp/r02-verify.log。
- 真实尝试cargo test ... local_tags_atomicity退出127（无Cargo）；原生runner退出1（spawnSync cargo ENOENT），未启动Rust，原生旧失败/新通过/变异、R-01原生因果及Windows GUI均待验。没有重跑与本轮无关的Electron三端构建，也不把TypeScript通过计为Rust编译成功。
- 修改仅7个白名单文件；未改schema、依赖版本/锁、共享/预览事务、信号去重/意图TTL、UI或controller所有权。无fixture重录；回滚使用本R-02原子提交的revert，R-01独立保留。

- Create State再次返回Context Captured同时提示No active world model，项目级保存未确认；Git/README/任务书为权威记录。

## 15. R-03 执行卡

- 状态：自动验证通过待实机，原生必需门未执行，非完整关闭。实际HEAD cee79701ca72e63a4d829fdcccf93b099d449886；stage/09-preview-tags-app；fetch后与origin一致，开工工作树干净。
- 前置：R-02默认106项通过记录；本轮重验R-01日志门和R-02结构门。继承无Cargo/Windows回执缺口，不把原生文件存在算验收。
- 精确白名单：
  - native-src/hfm-core-worker/src/shared_metadata/state_machine.rs
  - native-src/hfm-core-worker/src/shared_metadata/signature.rs
  - native-src/hfm-core-worker/src/shared_metadata/atomicity_tests.rs
  - native-src/hfm-core-worker/tests/shared_metadata_atomicity.rs
  - build/diagnostics/check-shared-metadata-rust-atomicity.cjs
  - package.json
  - README.md
  - docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md
- 实现范围：apply/remove-tag的行、ops、events、updatedAt/writerHost/rootPath、signature读纳入同一Immediate事务；删除目标读取在锁内。signature缺少meta记录仍兼容空值，真实SQL错误不再吞掉。空tag无数据库写入、无目标不更新metadata的旧语义保留。
- 状态所有者：仍为原Rust命令；同文件私有连接函数供真实入口及commit故障测试共用，无新store/队列。lease、冲突合并、归档回放、Node路径、信号身份、UI及schema不改。
- 旧证据：两个入口均先commit再写meta/读signature；本轮建立真实worker触发器和第二连接回读用例。原生旧失败/新通过如无法执行必须保持待验。
- 测试计划：apply/delete的第N行、ops/events第N项、每项meta、signature错误、commit失败；字段隔离、旧base合并、空输入/无变化/删除；R-01日志和真实回读对照、原生退化与默认结构门分别报告。

### R-03 接线范围补充

追加精确白名单：src/main/indexing/shared-metadata/sharedMetadataMutationRuntime.ts。已确认Rust成功结果之后3处普通appendStartupLog可抛入外层catch，rename/remove会把已提交root加入failed；属于本轮提交后失败语义。仅让这些成功分支的日志非干扰，保留真实写入错误和原显式回退政策。新增诊断同文件加载实际TS运行时，注入Rust结果/异常、日志和信号故障，验证不重放、不误报。


### R-03 实现与证据边界

- Rust apply/remove采用Immediate事务，行、revision、ops/events、updatedAt/writerHost/rootPath及结果signature一致提交；删除目标在锁内读取，避免读取后其他写者修改导致使用旧revision/旧标签集。无目标分支释放未写事务，不生成commit日志；空tag仍不创建数据库。
- 新strict signature函数以Transaction引用为参数，缺少updatedAt记录返回原空值；SQL/类型错误传播并使写事务回滚。普通只读signature保留旧容错语义，计算格式metadata-v2及计数/最大revision算法未改。
- 提交后仅保留原checkpoint（best effort）、内存结构序列化、日志与结果输出。返回对象由现有primitive/Vec/JSON Value组成，无新增自定义可失败Serialize；进程中断/输出管道故障仍是确认未知，不承诺绝对一次传输。R-01仍区分committed-error/unknown，不伪造rollback。主进程对3处Rust成功日志局部保护，真实写入异常保持失败且不进入Node回退。
- 默认新诊断加载真实sharedMetadataMutationRuntime及其状态/匹配/信号模块；只替换Rust调用、文件缓存、数据库读取、锁和日志/通知外部端口。3方法×成功/原生异常/根离线/lease拒绝共12场景：成功后日志/通知抛错仍确认成功；原生异常保持失败；成功/原生异常每场景1次Rust调用；根离线和lease拒绝0次调用；全部0次Node写入、读取句柄关闭。恢复旧日志调用的行为变异被拒绝；此证据不代替RustSQLite。
- 默认结构/算法门检查两写路径同一事务、严格signature、锁内目标读取、日志晚于commit、LF/CRLF；7种结构退化被拒绝，find_targets之后合并/字段保护/revision-op-ID/信号函数与基线hash一致，无fixture重录。
- 原生新增4个集成测试（Windows3个，/dev/full仅Unix）和2个同生产连接函数测试：apply/delete各8种触发器故障（行/ops/events/3项meta/signature聚合/signature的meta类型）；延迟外键强制commit失败；第二连接回读行、ops、events、meta及本地域哨兵；陈旧base标签合并、收藏/保护字段隔离、无变化/空输入/删除、signature真实读命令对照及日志故障。原生测试尚未执行，不能把这些数量报告成通过数。
- 独立--native入口先跑实际Cargo测试，再把真实worker回执送入生产共享signal运行时和R-01 validateNativeStages；隔离源码目录编译旧实现及updatedAt移出事务的变异，必须在“updatedAt leaked partial writes”数据库断言失败，编译失败不能算捕获。不会改工作树或正式字体库。
- Context7确认OptionalExtension只把QueryReturnedNoRows转None、其他错误传播；返回的是当前文档，未提供0.32.1专页，真实版本兼容仍需Cargo编译。Mermaid已按实际事务边界更新；原lease/冲突/ops归档回放源码未改。

Windows原生与开发态验收（不要求安装包）：

```bat
git pull --ff-only origin stage/09-preview-tags-app
node build/diagnostics/check-shared-metadata-rust-atomicity.cjs --native
set HFM_LOG_DETAIL=debug
npm run dev
```

检查共享标签添加/重命名/删除与收藏、保护交错操作，关闭重开及共享根离线恢复。回执包含提交、操作顺序、实际反馈和operation-chain日志；F-01/F-02旧ack/TTL、F-03去重仍留后续任务，不以本轮事务修复宣称全部解决。


### R-03 验证收尾

- R-01日志门与R-02结构门前置重验退出0。完整npm run verify退出0，107/107，包含共享冲突/字段合并/ops回放/归档/回退/关闭原门；随后补充根离线/lease拒绝的定向门退出0，共12个真实TS场景、7个结构变异及1个日志行为变异。全量日志/tmp/r03-final-verify.log。
- Electron/Vite生产构建退出0，364/1/196模块；main 1,164.33 kB；混淆退出0，原始输出3/4（一份旧renderer资源已带标记而跳过），本次三个真实入口均已核对安全标记。无安装包构建。
- --native真实尝试退出1，spawnSync cargo ENOENT；尚未启动Rust。原生旧失败/新通过、真实SQLite及commit故障、原生日志因果、Windows/NAS回执全部待验；不可用TS或源码冻结替代。任务状态保留自动验证通过待实机。
- 差异仅9个白名单文件；无依赖/锁/schema、预览事务、本地标签事务、IPC/preload、UI/CSS、业务ID变化。发生写入时结果序列化/通知均在成功commit之后，旧无trace消息仍兼容。revert本R-03提交即可回滚，不需撤销R-01/R-02。

- Create State返回Context Captured但仍提示No active world model；HFM项目级保存未确认，Git/README/任务书保存完整交接。

## 16. R-04 执行卡

状态：自动验证通过待实机。基线8b60ee798b8e5fd4c10fcecc5633dbbc08981c01，stage/09-preview-tags-app，开工工作树干净；继承R-01～R-03无Cargo/Windows原生回执缺口。
精确白名单：
- native-src/hfm-core-worker/src/preview_cache/write.rs
- native-src/hfm-core-worker/src/preview_cache/atomicity_tests.rs
- native-src/hfm-core-worker/tests/preview_cache_atomicity.rs
- src/main/logging/previewCacheMutationTrace.ts
- src/main/rust-core/clients/rustPreviewClientRuntime.ts
- build/diagnostics/check-preview-cache-rust-atomicity.cjs
- build/diagnostics/fixtures/rust-worker-clients.fixture.json
- package.json
- README.md
- docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md

边界：updatedAt是apply原有成功要求，放入行事务；保留第一输入行时间来源、空输入与无效行跳过语义，delete没有更新时间输入且原本不写meta，不扩展协议。修复Rust apply/delete提交后异常返回null触发Node回退，记录结果未知，保留命令不可用时null兼容。补R-01预览系统操作trace：起点为实际Rust客户端操作，不虚称来自用户点击；复用既有日志作用域、容量和临时输入，不加业务store/队列。
只迁移rust-worker-clients fixture中runRustPreviewCacheInputCommand这一函数hash；先用实际客户端故障行为验证，再精确更新，其他方法/接口不变。测试使用真实Rust命令+第二连接回读、真实客户端及既有D-02迟到/代次/句柄门；无Cargo时原生测试仍独立待验。

追加白名单build/diagnostics/check-operation-chain.cjs：新增预览原生阶段验收函数，预览没有标签signal，不伪造signal；检查系统dispatch、backend-start/commit/backend-result和client-result关联及序号。

追加精确白名单build/diagnostics/fixtures/rust-worker-transport.fixture.json：仅apply/delete的18个场景，迁移新增临时输入trace及提交后错误由null变error的预期。每项与基线客户端实际运行对比，去除诊断trace和其span UUID记录后I/O轨迹必须相同；其余351场景与7组序列保持原fixture。

追加白名单build/diagnostics/check-orchestration-contracts.cjs：既有隔离加载器不解析新增日志模块；仅登记精确import并加载真实模块，不替换业务算法或放宽契约。


### R-04 实现及验证边界

- Rust apply把原updatedAt写入移到同一个行事务内；空输入不写updatedAt，仍提交空事务；第一输入行无效时仍按原语义取该行时间。delete仍只删行，没有新增timestamp参数或metadata写入。schema初始化常量保持原位置，不改变schema/缓存key/行合并/status/fail_count规则。
- 客户端apply/delete进入调度调用后，执行错误、ok=false、无效JSON或缺少合法written/deleted回执均抛错，不再转换null。此时无法证明是否提交，日志记unknown，不宣称rollback。worker不可用/能力不支持保留null；实际执行前的临时输入失败仍保留原兼容。
- 成功写入后的普通日志/临时输入清理失败不改变业务结果；只读/渲染/其他预览命令保持原异常行为。清理仍在finally实际执行一次；未新增调用重试。原D-02实际结算后失效generation、超时不取消底层工作、本地借用句柄不关和共享句柄finally关闭未改。
- 新日志模块是进程内系统操作诊断所有者：session+单调operation序号，apply/delete各自独立attempt，复用R-01 AsyncLocalStorage、日志容量和临时输入trace传播。无Map/监听器/定时器/业务状态；不写数据库trace，不虚构renderer意图、标签signal或已绘制页面。客户端returned不是commit证据，必须与原生commit及数据库回读对应。
- 默认新门：16个实际客户端场景（apply/delete各成功、执行错误、非法计数、损坏JSON、ok=false、日志异常、清理异常、不可用）。旧基线客户端实际执行错误返回null的反例已被拒绝；恢复吞错、移除trace和2种事务结构变异被拒绝。预览原生阶段验收器另以明确合成数据验证缺commit、错误顺序、跨attempt3个反例，此部分不计原生执行。
- 原生交付：3个集成测试（Windows2个，/dev/full日志IO故障仅Unix）及1个模块测试；覆盖第N行/第N次删除/meta触发器故障、apply/delete延迟外键commit失败、第二连接回读、空输入/无效行/failed/missing/pending及COALESCE/MAX语义、写删交错、日志故障。当前没有Cargo，所有原生项目仍待运行。
- --native先运行真实Rust测试，再调用真实TS客户端/真实traceRustInput，将实际worker stderr和客户端日志交给R-01新增预览验收器，并用SQLite第二连接核对结果；外部调度/临时文件端口由测试提供，不冒充完整daemon路径。最后隔离编译旧Rust事务实现及metadata移出事务变异，要求“metadata leaked partial writes”数据库断言失败，编译失败不算捕获。
- 精确fixture迁移：1个客户端函数hash；18个apply/delete传输场景与旧源实际执行对照，去除新增trace/span UUID后I/O轨迹一致，4类已执行失败由null变error。其余351场景、7组序列、28文件作用域和原10变异保持；没有整体重录。

Windows原生及开发验收：

```bat
git pull --ff-only origin stage/09-preview-tags-app
node build/diagnostics/check-preview-cache-rust-atomicity.cjs --native
set HFM_LOG_DETAIL=debug
npm run dev
```

重点共享预览生成、清理后重新生成、不可达根恢复、快速滚动和请求超时后的晚完成；本地预览仍走原Node借用连接。检查startup的operation-chain，区分客户端结果与Rust commit。此轮未修R-05旧ack/TTL和R-06去重。


### R-04 验证收尾

- 完整 npm run verify 退出0，108/108；日志 /tmp/r04-final-verify.log。新门16个客户端场景及故障变异通过；传输门369场景、7组生命周期、28个临时文件作用域通过。原D-02代次/迟到/句柄边界及编排契约继续通过。
- Electron/Vite生产构建退出0，365/1/196模块；混淆3/4（一份旧renderer资源已标记），本次main/preload/renderer三入口标记已核对。没有生成安装包。
- 原生入口实际尝试退出1：spawnSync cargo ENOENT。Rust编译、实际数据库故障/commit回滚、真实worker日志、Windows交互均待验；不以默认门替代原生验收。
- 变更限13个白名单文件；无依赖锁、schema、缓存key、IPC/preload、UI/CSS变化。独立revert本R-04提交可回滚；不需撤销R-01～R-03。
- Create State返回Context Captured同时提示No active world model，HFM项目级保存未确认；Git、README和本任务书保留交接。


### R-04 Windows 换行兼容修正

用户实机在默认门反例断言报 Missing expected exception。根因为多行变异锚点写死LF，CRLF源码未被修改；此前CRLF只检查正确源码，未覆盖变异生成。修正限本诊断脚本、README和本任务书：所有源码变异统一LF并断言锚点命中及内容确实变化，Rust反例覆盖LF/CRLF；原生metadata移出事务反例也使用同一检查。

实际把Rust write.rs与TS客户端转成CRLF，旧门复现同样错误，新门通过16个客户端场景及反例；随后恢复原文件字节，生产源码无差异。Rust/Cargo实机验收仍待回执，本修正不宣称原生验收通过。

验证：定向LF/CRLF退出0；--native通过默认门后因cargo ENOENT退出1。全量verify运行至Rust诊断期间容器连接中断，最终状态未确认，不计作108项通过。已通过定向验证的修复按相同替换规则从远端基线恢复并提交；未重复构建未修改的生产源码。Create State提示No active world model，项目级保存未确认。


## 17. 操作刷新放大修复执行卡（F-06）

状态：自动验证通过待实机。基线3fac7e7，stage/09-preview-tags-app，工作树已与远端对齐；恢复容器后读取上一轮完整日志，CRLF修正verify实际108/108通过。继承无Cargo/Windows原生验收缺口。用户授权修复本次日志暴露的刷新问题，不替代R-05/R-06。

证据：收藏5次均incremental-rebuild且安装数量295/1204不变；普通目录复查1事件1499upserts。实际根因包括全统计清空、共享元数据reason漏掉收藏/保护，以及未变化条目亦发送。正常事件只发送差异，显式恢复仍必须重发，禁止删除恢复机制。统计保留最后成功值直到新权威结果替换，保持请求序号/意图校验，不关闭必要的聚合查询、不猜算安装状态。

精确白名单：
- src/renderer/src/databaseDerivedStateRuntime.ts
- src/renderer/src/runtime/database/useRendererDatabasePageRuntime.ts
- src/main/indexing/merged-page/mergedIndexSourceChangeRuntime.ts
- src/main/indexing/merged-page/mergedIndexSyncRuntime.ts
- src/main/watcher/folderWatcherRuntime.ts
- src/main/watcher/watchedFolderIndexRuntime.ts
- src/main/watcher/watched-folder-index/watchedFolderIndexTypes.ts
- build/diagnostics/check-operation-refresh-scope.cjs
- build/diagnostics/check-watcher-index-consistency.cjs
- build/diagnostics/check-watcher-activation-baseline.cjs
- build/diagnostics/fixtures/react-composition-domain-controllers.fixture.json
- package.json
- README.md
- docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md

无新业务状态所有者。新增门加载真实刷新、索引分流和监听实现，外部SQLite/Rust/文件系统由端口夹具替代，仍须Windows日志确认实际性能。仅迁移刷新函数所属文件冻结hash及失效后统计应保留的旧断言，不整体重录。启动等待、文件夹计数波动、维护缺文件继续定位，未确认根因不写成已修。PowerShell详细日志使用 $env:HFM_LOG_DETAIL = "debug"。

追加精确白名单：build/diagnostics/fixtures/watcher-activation-baseline.fixture.json，仅folderWatcherRuntime.ts源码hash随可选replayUnchanged端口更新；函数及导出列表不变，恢复重试/重启/代次/失败门继续执行。


### F-06 实施证据

- 旧实现实测失败：刷新门得到null而不是原统计对象；shared-favorite-set仅metadata变化却重建；监听旧接线没有传恢复标记。新实现统计门、60种真实sync分流（含安装签名/其他根变化反例）及LF/CRLF、3个退化变异通过。指标查询失败仍输出db-metrics-error并保留最后成功快照。
- 正常监听目录复查/单文件无变化时不广播，真正变化和删除保持；恢复路径通过可选replayUnchanged标记重发，恢复快照同步与有限重试保持。既有W门补充正常/恢复正反场景及2个变异，8个变异全通过；A-01旧统计乱序、停用失败回滚及10变异、A-02四变异均通过。
- 仅迁移databaseDerivedStateRuntime与folderWatcherRuntime两个冻结hash；原导出/函数列表保持，激活门保留结算后的统计后再验证旧响应不得覆盖新结果，未关闭竞态断言。
- 不修改IPC、Rust、依赖、schema、UI/CSS、业务身份、R-05旧ack/TTL或R-06业务去重。聚合metrics仍包含安装数；修复的是清空后回退部分前端统计和重复索引广播，不宣称所有安装数量查询已消除。列表仍按旧规则失效，避免把已删除项当新快照。
- Electron/Vite构建365/1/196通过，main 1,166.15 kB，混淆3/3。Mermaid已同步真实实现，原生代码未改；Windows显示/共享盘行为待用户验收。
- 待查：34.85秒查询与5ms worker之间的等待来源、目录计数219/174变化、hash/metrics健康检查缺文件。当前证据不能确认根因；本轮减少多余重建/广播可能改善渲染负载，但不据此宣称这些问题全修复。

Windows PowerShell验收（无依赖变更，不需npm ci）：

```powershell
git pull --ff-only origin stage/09-preview-tags-app
$env:HFM_LOG_DETAIL = "debug"
npm run dev
```

连续收藏/取消收藏、激活/停用、本地/共享标签及保护操作；核对安装数不闪成部分统计，目标根纯metadata变化日志走incremental-rust或snapshot-rust，普通无变化监听upserts=0；实际增删字体和故障恢复继续可见。记录启动和目录计数异常，随新日志继续追查。

F-06收尾：npm run verify退出0（109/109），日志/tmp/f06-verify.log；新增门补全60场景及CRLF后独立复验退出0。15个白名单文件，git diff --check通过。原生源码未改、Cargo不可用；Windows验收待回执。Create State再次提示No active world model，HFM项目级保存未确认，Git/README/任务书完整保存交接。回滚本次独立F-06提交即可恢复基线行为。

## 18. 日志四项问题修复执行卡（F-07）

状态：自动验证通过待实机。实际基线878fc285268a98de9fcdcde567cd8966a1ebba64；stage/09-preview-tags-app，fetch后与origin一致，工作树干净。用户明确授权修复四项日志发现，作为F-06后续；R-05/R-06未启动，继承无Cargo/Windows原生验证缺口。

证据：19:10日志目录节点173→14、统计项174→15且字体1499不变；激活/停用分别同步1499行但changed=0；metrics文件未创建导致维护ok=false；active名称预览status=14后文件渲染成功。首个收藏统计延迟和单次1.36秒预览仅登记，不混入四项修复。

成功标准：增量字体更新不能删除未加载目录，真实物理树替换/显式目录删除仍生效；激活状态与持久化安装状态一致时不重写、不全根同步，缺失/变化/读取失败仍保存并同步；缺失可选metrics不报损坏，已存在但损坏/必需库缺失必须失败；active有效文件直接进入Rust文件预览，普通系统字体和源文件离线时保留名称路径，授权、缓存身份、输入验证和兼容回退策略不变。

精确生产白名单：
- src/renderer/src/library-normalize/libraryIndexChangeRuntime.ts
- src/main/activation/activationInstallStatusSaveQueue.ts
- src/main/activation/mainActivationInstallStatusSaveRuntime.ts
- src/main/bootstrap/mainMutationCompositionRuntime.ts
- src/main/maintenance/databaseMaintenance.ts
- src/main/preview/previewRuntime.ts

验证/文档白名单：
- build/diagnostics/check-log-regression-followup.cjs
- build/diagnostics/check-activation-save-queue-durability.cjs
- package.json
- README.md
- docs/plans/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md

无新增业务模块/状态所有者、schema、IPC/preload、依赖、UI/CSS变化。新门加载真实TS入口，替换磁盘/Rust/窗口和数据库外部端口，先对基线逐项复现，再对新代码验收并执行LF/CRLF退化变异。队列的实际持久化结果读取在flush内进行，保留失败重试/新意图覆盖旧失败/关闭顺序。Rust渲染实机效果必须由Windows日志补证；mock结果不作原生验收。


### F-07 实施与验证记录

- 四项旧实现均实际失败：目录173→1；未变化安装状态仍save/sync/clear；缺失metrics使维护false；active渲染先失败名称查询再成功文件路径（2次调用）。基线门命令`node build/diagnostics/check-log-regression-followup.cjs --baseline=878fc28`退出1；初次预览夹具import.meta加载错误修正为替换helper发现端口后，单独复跑预览得到业务断言2!==1，未计夹具错误为产品反例。
- 目录：规范路径合并增量目录，现有未加载/空目录与createdAt保留，大小写/斜杠不重复；字体删除继续删除字体，但不代表物理目录删除。权威物理树替换仍能移除已删除目录。此前已经持久化的缩水树可用现有根目录右键刷新恢复，不执行磁盘字体删除或数据迁移。
- 激活：唯一保存队列flush内读取持久化、签名已校验的安装状态；installed/by/matches均一致且非missing才跳过。混合批次仅保存变化行，读取失败/缺失继续原保存同步。新增状态在比较期间入队仍在flush后继续排空；原失败重试及新值覆盖旧失败门继续通过。真实安装变化仍同步受影响根，不宣称完全禁止全根同步。
- 健康：本地metrics快照保存原本为no-op，实际统计来自共享根索引。沿用preview的可选缓存语义加入metrics，只有stat确认ENOENT才视为未创建；EACCES/EIO、已存在但损坏、必需库缺失不能当成功。Rust与Node路径共14场景；Node检查不因验证而创建可选空库。不修改Rust健康协议、SQLite schema或备份布局。
- 预览：仅reason=active且源文件可用时跳过名称查询，直接使用既有Rust文件渲染；普通系统字体、active离线继续原名称路径，名称失败仍可文件回退；实际渲染失败仍标记failed。缓存键/身份、授权、输入检查、Node兼容策略不变，没有启用PowerShell兼容回退。
- 新诊断四组真实TS入口通过；5个退化变异在LF和CRLF下共10次均被拒绝，全部CRLF正例通过；队列并发新意图/混合批次/by及matches差异、健康权限/I/O错误均有行为断言。新增readInstallStatusIndex端口为内部队列必需依赖，复用Mutation既有依赖，不扩展IPC；类型检查确认实际生产接线。
- 全量`npm run verify`退出0，110/110，日志/tmp/f07-verify.log。补充权限/I/O及队列并发门后目标门与maintenance/activation既有门退出0，类型检查复跑通过；没有更新冻结hash、快照或放宽既有断言。
- Electron/Vite生产构建365/1/196模块通过，main 1,167.87 kB，日志/tmp/f07-build.log；安全混淆实际报告3/6（输出目录含既有产物，3个当前产物完成处理）。本轮原生源码未改；Cargo及Windows GUI未执行，不计原生验收通过。
- Mermaid Chart已更新四项真实链路；未使用陌生/新增框架或系统API，不需Context7。Create State返回Context Captured但同时提示No active world model，HFM项目级保存未确认。README为变更记录；本节保存执行证据，独立revert F-07提交可回滚全部本轮改动。

Windows开发模式复验（无依赖变化）：

```powershell
git pull --ff-only origin stage/09-preview-tags-app
$env:HFM_LOG_DETAIL = "debug"
npm run dev
```

若旧目录已缩水，先右键监听根目录刷新一次，记录library:save的folderNodes和metrics的folderKeys。连续收藏/取消收藏、标签、字体增删后目录不应退成当前分页的目录集；物理刷新仍能移除实际删除的目录。连续激活/停用，状态未变时预期`activation install status async save skipped: ... unchanged=1, syncRoots=0`，真实安装变化仍保存后同步。健康检查仅缺metrics时记录`database health optional cache absent: label=metrics`且不因此使maintenance=false。新的active预览缓存缺失且文件可用时记录`active font preview file route`，不先出现family status=14；缓存已命中则无渲染日志。字体文件离线和真实预览失败继续保留原诊断，不伪造成功。

范围外仍待处理：首个收藏0→1的统计显示延迟、旧日志多根启动长等待，以及单次预览1.36秒等待。F-07不以四项自动门替代这些问题的测量，也不提前完成R-05/R-06/R-07。

F-07最终收尾：补充边界后的完整`npm run verify`再次退出0（110/110），日志/tmp/f07-final-verify.log；git diff --check通过，11个精确白名单文件，无构建产物、日志、依赖目录或用户数据入库。提交前再次fetch确认远端仍与878fc28一致，按授权直接快进推送stage/09-preview-tags-app。

F-07推送阻塞：实际git push被自动审批拒绝，理由为本次11个源码/诊断/文档文件将外发到公开仓库uniquenesssta/99，审查要求对本次载荷和目的地的具体用户授权，未接受此前长期授权。未换通道重试；只读ls-remote确认远端仍为878fc285268a98de9fcdcde567cd8966a1ebba64。代码和全部验证已完成、本地提交保留，待具体授权后仅快进当前阶段分支。


## 19. F-07 Windows 新日志复核与判读纠正（2026-09-16）

证据：startup-2026-09-16_19-38-09-711-18052.log，共1746行，19:38:09.711–19:39:05.176 UTC。F-07已在用户具体授权后发布为 b7f68e120788930a23e9aaf8c9ceafb3d5550554；原普通Git推送缺凭据，连接器发布的树与本地已验证树34ff14033beaea14f28b2844b9e72177862c929f一致。§18的推送阻塞已解除。本日志只支持部分实机验收，不得继续称四项全部修复。

| 项目 | 实际证据 | 结论与后续 |
|---|---|---|
| 可选metrics数据库健康检查 | 177/186行将缺失标记为optional cache absent；192/193行维护ok=true、preview errors=0 | 本项实机通过；真实I/O/损坏错误仍须报错 |
| 目录清单 | 87行原持久化folderNodes=14；253行变37；metrics folderKeys从15到38并保持；字体总数1499 | 本次未再缩减，但历史完整173目录未恢复；无物理树刷新请求，不能宣称恢复完成，亦不能据此认定字体丢失 |
| 激活状态索引 | 39.710秒known1/missing0，仍写1项、fullSnapshot1499、144ms；flush unchanged0/syncRoots1/206ms。停止时known0/missing1、fullSnapshot1499/139ms、flush191ms | 正常激活/停止仍全根同步，F-07相同比较不足，待独立按字体增量同步修复 |
| 激活字体预览 | 无active font preview file route；39–44秒激活窗口内无renderPreviewImage请求 | 路由修复未被实际执行；旧status14未出现不能算验收通过 |

关键纠正：Rust merged_index/sync.rs的changed取payload.relative_paths.len()，不是数据库实际变化行数。因此fullSnapshot=true/changed=0不能证明“无变化仍写入”。激活实际写installed=true/by=managed，停止写false/by=none，相等比较不会跳过真实变化。停止时missing可能涉及包含managedInstallPath/managedRegistryName的签名变化，但日志不足以确定具体原因。此前门禁只覆盖人为相同状态，未覆盖真实激活链；记录覆盖缺口，不改写通过记录为真实链已修复。

其他观察：8次收藏（4添加/4取消）全部成功108–176ms，走metadata incremental accepted；2次本地标签15/17ms成功；2次共享标签280/281ms成功但各全根1499项同步135/138ms，仍有优化空间。一次预览主进程1.389秒/renderer1.398秒，其余350/401/453ms。19:38:43单秒有21次getCachedPreviewImages启动，摘要长度6/首字体相同不能证明全部参数重复。一次metrics renderer567ms而worker34ms，等待发生在worker之外。user-intent-changed查询拒绝属于正常竞态保护。operation-chain中committed17、ack12、returned34，无失败；末尾关闭pending=false/inFlight=false。

保留待查：首收藏0→1延迟、激活全根同步、目录历史清单恢复、激活文件预览实机覆盖、预览请求密度及耗时、共享标签全根同步、启动等待。本轮R-05仅处理标签意图/确认/重试，不混入这些性能修复。用户以开发模式验收，后续提供npm run dev，不要求build:win。

## 20. R-05 执行卡

状态：自动验证通过待实机；未将Windows/NAS或前置Rust缺口计为完成。

基线b7f68e120788930a23e9aaf8c9ceafb3d5550554，stage/09-preview-tags-app；开始时工作树干净。本轮先补§19日志复核。继承无Cargo/Windows原生验证缺口。仅修F-01/F-02，R-06去重不动。

精确白名单：README.md、本任务书；src/renderer/src/fontTagStateAuthorityRuntime.ts、fontTagMutationRuntime.ts、fontDialogTagActionsRuntime.ts、fontDialogRuntime.ts、fontWriteQueue.ts、runtime/app/effects/useFontTagStateSignalEventRuntime.ts；build/diagnostics/check-tag-intent-lifecycle.cjs、check-tag-consistency.cjs、check-decomposition-baseline.cjs、fixtures/app-interaction-composition.fixture.json；package.json。若既有隔离加载器缺少新依赖，先登记对应文件再补真实模块加载，禁止伪造业务mock或批量刷新fixture。

| 当前状态 | 输入 | 下一状态/约束 |
|---|---|---|
| 未提交 | 原队列派发 | 发送中；字段内代次与对象身份不变 |
| 发送中 | 本次IPC失败/部分失败成员 | 可重试失败；同token进原重试队列，无时间到期 |
| 发送中 | 本次IPC成功成员 | 已提交待确认；回执只结算持有的token，不能触及较新token |
| 已提交待确认 | 真实读取匹配目标 | 已确认；后续真实外部修改可接管 |
| 任意旧代次 | 新用户编辑 | 新token替代；旧回执仅结算旧对象，旧失败不得覆盖新队列 |
| 任意pending | 普通/缺revision广播、别字体旧目录 | 不确认；保护本字段意图，继续刷新权威查询 |
| 已确认 | 外部显式空目录/修改 | 应用权威结果；不永久保留乐观值 |
| 会话结束/reload | JSON或IPC往返 | Symbol意图不持久化；原关闭flush失败提示继续生效 |

本轮复用FontItem会话Symbol持有每字段token，队列与界面必须引用同一token，不引入第二store/队列。代次仅本地编辑序号；后端revision只与同域后端revision比较；时间不作确认依据，trace只用于日志。共享rename/本地共享delete是目录级直接IPC，无原队列表示；延后界面目录变更至权威广播/查询，失败保留原视图并明确提示重试，不制造未入队的乐观token，也不将目录删除错误重试为保留空目录的逐字体解绑。队列标签批次仍逐成员结算；其他字段不回滚。

白名单补充：build/diagnostics/check-font-write-queue-durability.cjs仅补新依赖的真实模块加载。旧check-tag-consistency移除复制的TTL/无条件确认算法，改跑生产模块，原14项契约保留，确认测试改为广播不确认。app-interaction-composition.fixture仅更新本轮有意变更的fontDialogRuntime与fontDialogTagActionsRuntime两个摘要；其他输入、Hook顺序、算法哈希不变，新R-05真实交互门替代这两项旧行为冻结。

白名单补充（确认生命周期完整性）：src/renderer/src/runtime/database/useRendererDatabasePageRuntime.ts在查询开始捕获已成功写入的token，只有通过既有requestSeq/用户意图门的结果才确认同一代次；允许成功后的外部删除先于匹配读取、以及结果为空时结束保护。src/renderer/src/library-normalize/libraryNormalizeStateRuntime.ts将未结算标签意图列入既有LRU保留集合，避免队列仍在重试而UI所有者被逐出。二者均复用既有所有者，不新增缓存/队列。

续接复核（2026-09-17）：16项未提交改动完整保留，HEAD与远端仍为b7f68e1。复现新边界：旧空目录→新增标签→写入成功→真实查询返回新标签，确认先解除保护导致新标签再次被旧目录过滤为空。修复限制在上述authority/page模块与新增生命周期门；同时检查空分页、确认后的外部删除及本地/共享两域，不扩大到R-06或性能专项。成功读取与目录信息需按来源协调，不能把旧空目录当新删除证据。

日志验证补充白名单：src/renderer/src/fontOperationTrace.ts仅提供已有WeakMap的单条目诊断身份读取；build/diagnostics/check-operation-chain.cjs增加可选真实乐观编辑入口。发现此前token记录的是整批trace，无法区分批内同代次字体；改为单成员身份，生命周期阶段与原dispatch/queue-settled区分。业务确认仍仅使用token身份，不依赖trace。复用R-01真实preload/IPC/Node SQLite/第二连接回读验收成功与两次失败后重试；不替代Rust实机证据。

文档收尾白名单：docs/plans/HFM_REMEDIATION_MASTER_TASKBOOK.md仅同步本修复入口状态；docs/audits/HFM_FULL_CHAIN_AUDIT.md仅新增F-01/F-02修复证据链接，保留原始审计事实。

### R-05 实现与验收边界

- UI复制与原队列持有相同的逐字体/逐字段Symbol token；成功/失败只结算原条目，新编辑不会被旧ack或旧失败改写。pending保护依赖queued/sending/retry/committed状态，无TTL；JSON/structuredClone不携带会话身份。字体id/sourceId、原数据库结构、IPC/preload和依赖版本不变。
- 广播只更新目录权威状态，不清除任意pending。目录单独以同域后端revision拒绝已知旧信号；旧消息缺revision仍兼容并保留pending，不把Date.now当因果版本。批内每个token的诊断使用原条目operationId/attemptId，intent-dispatch/intent-committed/intent-retry不重复记为原dispatch阶段。
- 成功后匹配回读可确认；分页开始捕获已经成功的token，只有通过原requestSeq/用户意图门的结果才能确认。查询开始之前未ack、查询途中出现的新编辑都不能确认；空分页也发布新对象以更新派生视图。未结算token加入原LRU保留集合，不建立第二状态表或队列。
- 续接复现并补修：成功新增标签不得被更早空目录过滤；回读结果的标签目录证据保留在原token，后来的权威目录广播清除该证据并允许外部显式删除。分页没有返回某字体本身不等于该字体标签已删除；如果ack后收到新目录，则空页确认沿用该新目录。旧draft目录不永久污染权威目录。
- 本地重命名/兼容逐字体路径只对实际变更字体生成token，全部新token必须入原队列，即便查询提供的受影响ID不全。选中字体动作从当前库读取，并只合并目标字段，防止旧弹窗快照覆盖其他域。
- 共享重命名和目录显式删除依赖已有直接IPC，先flush；不生成没有队列所有者的乐观token。失败保留现有视图并提示重试，禁止把失败的目录删除改成逐字体解绑重试；批次成功成员不重放。后端部分结果由权威广播/回读收敛。

### 可复现自动证据

| 检查 | 结果与边界 |
| --- | --- |
| `node build/diagnostics/check-tag-intent-lifecycle.cjs --baseline=b7f68e1` | 退出1，F-01a、F-01b均丢new变空；F-02到期变old。分别加载真实旧authority，不把编译/加载错误计作反例 |
| `npm run diagnostics:tag-intent-lifecycle` | 当前通过；同字体旧ack、其他字体旧目录、缺revision、20秒/10分钟、两个字段反向确认、增删、批量部分成功/失败重试、缺接口、关闭失败、reload、弹窗共享身份、直接删除失败、空页/旧页、LRU、成功回读与旧目录冲突 |
| 退化检查 | 5种变异分别在LF/CRLF执行，共10次被业务断言拒绝：恢复TTL、广播确认、未提交即确认、查询提前捕获未ack、丢弃成功回读目录证据 |
| R-01真实链复用 | 两种preload，成功及两次SQLite故障后成功；真实队列→IPC→Node SQLite→广播→回读确认，第二连接验证失败无残留/成功有绑定，operation/attempt/确认身份一致、监听卸载清理。首轮未开启debug导致日志断言失败，启用测试所需debug后复验，不计为产品故障 |
| `node docs/audits/observe-chain-audit.cjs` | F-01a/b、F-02均reproduced=false；F-03a/b仍true，明确留R-06，未混修 |
| 原门迁移 | 14项tag-consistency改用真实authority；只迁移2个有意变更的弹窗文件hash，其他Hook/视图/性能/算法冻结保持。两个隔离加载器仅接入真实新依赖 |

执行环境Node v24.19.0/npm11.9.0/Linux。最终`npm run verify`退出0，TypeScript与111/111诊断通过，日志`/tmp/hfm-r05-final-verify.log`；Electron/Vite三端构建365/1/196模块退出0，安全混淆3/3退出0。没有运行完整npm run build，因为本环境无Cargo；本项没有原生源码变更，继承R-01～R-04原生和Windows待验缺口，不将Node SQLite成功替代Rust/NAS/GUI验收。

Mermaid已记录真实R-05链路；无新增或陌生第三方API，不触发Context7。Create State仅返回Context Captured并提示No active world model，账户中没有HFM模型，未写入markdown/足球模型；项目级保存未确认，以Git/README/本执行卡为准。

### Windows开发模式复验（待用户回执）

```powershell
git pull --ff-only origin stage/09-preview-tags-app
$env:HFM_LOG_DETAIL = "debug"
npm run dev
```

同字体连续添加/移除本地与共享标签，交错收藏/保护，快速切页/详情；确认新标签不被旧广播清空，其他字段不变。删除最后绑定后保留空目录，显式删目录后消失；共享标签重命名/删除失败后应提示且不伪装成功。测试库共享根离线后等待超过20秒，恢复后检查最后编辑保存；编辑后正常关闭重开，失败时保留未保存提示。记录提交号、操作顺序、肉眼反馈和startup operation-chain日志；验收后移除HFM_LOG_DETAIL。无依赖变化，无需npm ci或安装包。

本R-05保持独立原子提交，可用`git log -1 --format=%H -- build/diagnostics/check-tag-intent-lifecycle.cjs`定位后revert；无需数据库迁移或回滚前置任务。下一项为R-06，但本轮不启动。

最终差异复核：20个登记文件（含新增诊断），git diff --check通过；依赖锁、Rust源码、数据库schema、样式、R-06信号去重均无变更。两次全量回归均退出0，最终一次包含本轮续接补修；构建日志/tmp/hfm-r05-build.log。远端仍为b7f68e1，沿原阶段分支快进发布本R-05独立提交。

## 21. R-06 执行卡

状态：自动验证通过待实机。基线eded4dbbd40567486241adc9ee552bf05118ae91，stage/09-preview-tags-app，起始工作树干净且与远端一致。R-05前置生命周期门通过；原只读observer确认F-03a/b各仅1次广播（应2次），F-01/F-02不再复现。继承R-01～R-05 Rust/Windows/NAS/GUI待验缺口。

精确白名单：
- src/main/library/tagMutationStateSignalRuntime.ts；新增src/main/library/tagMutationSignalIdentityRuntime.ts：通知端与唯一去重表所有者，完整存储域/提交身份/语义摘要，固定容量与过期。
- src/main/library/runtime/localFontTagMutationEffectsRuntime.ts、localFontTagsRuntime.ts；src/main/indexing/shared-metadata/sharedMetadataMutationSignalRuntime.ts；src/main/rust-core/rustCoreWorkerContracts.ts：已提交信号生产/适配，透传可选mutationId。
- native-src/hfm-core-worker/src/mutation_protocol.rs、local_tags/types.rs、local_tags/state_machine.rs、shared_metadata/types.rs、shared_metadata/state_machine.rs：提交后生成一次独立于trace的mutationId，两通道从同一结果复制。
- native-src/hfm-core-worker/tests/local_tags_atomicity.rs、shared_metadata_atomicity.rs：真实命令回执与协议身份相等/不同提交不同身份的原生断言。
- 新增build/diagnostics/check-tag-mutation-identity.cjs；package.json：真实生产模块的完整R-06门及注册。
- README.md、本任务书、docs/plans/HFM_REMEDIATION_MASTER_TASKBOOK.md、docs/audits/HFM_FULL_CHAIN_AUDIT.md：结果与原审计修复入口。

设计：现有updatedAt由调用方提供，shared signature为统计摘要，均不保证逐提交唯一。仅新增内部stateSignal.mutationId可选字段，Rust在事务提交后的signal构造点生成一次，Node仅为自身已提交信号生成UUID；旧Rust无字段不由适配器伪造身份。传输、daemon事件与worker响应复用同一字段，不修改数据库主键/schema、IPC通道/方法签名、preload或renderer广播；原回执mutationProtocol.stateSignal透传可选字段。生产端mutationId不参与数据库写入/重放，不从R-01trace/attempt计算。

新去重键包含scope、原始db/root存储域、mutationId、完整排序去重ID集合、完整目录（缺失不同于空）、signature、操作类型与时间及dirty语义的SHA-256。路径不新增归一化规则。新消息执行revision→清缓存→广播；同提交完整消息双通道只执行一次。旧版本或身份/存储域缺失时保守接受刷新；不能证明相同提交则不抑制。缓存只保留固定长度摘要，60秒保留窗口不延长，最多2048项；过期/容量淘汰后重放允许额外刷新，不保证永久exactly-once，不以时间判断提交先后。乱序不同提交均可触发权威重查，重复旧提交在窗口内不回灌目录。

必过：不同根同时间空IDs、相同前80不同81、相同IDs不同目录、完整双通道正反顺序、同trace不同提交及同提交不同trace、缺字段/旧消息、无变化、乱序、容量/过期、日志失败。先用真实旧模块验证业务断言失败，再验证现实现；存储域丢失/截断IDs/attempt去重退化及LF/CRLF必须失败。日志仅打印有界摘要与accept/dedupe/legacy理由，不输出ID列表。复用原真实Node SQLite链与R-05门；原生断言未执行不得计通过。回滚为本R-06单提交revert，旧消费者忽略新字段，无数据迁移。

白名单补充：build/diagnostics/check-decomposition-baseline.cjs仅接入新增真实identity模块（observer和既有适配门共用该加载器）；build/diagnostics/check-local-tag-rust-adapter.cjs将旧无身份重复压制断言改为带完整提交身份，同时由新门保留旧消息保守刷新的兼容验收，不修改observer。没有扩大业务修改范围。

全量门发现类型冻结变动：补充build/diagnostics/fixtures/decomposition-baseline.fixture.json，仅迁移localFontTagsRuntime.ts新增可选mutationId的tokenHash；先断言删除该类型行后与旧摘要完全相同，其他函数/导出/所有者/算法摘要不更新。新门补独立`--native`入口，真实Cargo测试和daemon输出进原生产适配/去重链，当前环境无Cargo明确待执行。

同一fixture第二项迁移：localFontTagMutationEffectsRuntime.ts仅新增crypto导入与mutationId生成/透传行；移除这两行后必须与旧冻结条目完全一致，再只更新该tokenHash。其余冻结条目不变；新真实适配测试替代该两行的旧无身份行为。

白名单补充build/diagnostics/fixtures/local-tag-rust-adapter.fixture.json与local-tag-node-persistence.fixture.json：仅emitLocalTagsMutationStateSignal函数新增mutationId一行所引起的body hash迁移；移除该行后验证原hash一致。二者均冻结同一emit函数，分别以原hash核对；其余持久化函数与事务摘要保持不动。

白名单补充build/diagnostics/check-operation-chain.cjs：原R-01去重场景使用无提交身份的合成消息，与本轮旧消息保守刷新策略冲突；只给真正重复的场景补mutationId并保留已有dbPath并保留其1次广播断言，去重日志reason改为有界摘要格式。R-01队列/IPC/SQLite/trace及其他拒绝路径断言不改。新门另已验证8个真实Rust client/transport解析场景（4命令×daemon/oneshot）保留身份、清临时文件并接通实际通知适配。


### R-06 实现与兼容边界

原信号模块仅负责无变化判定、版本/缓存/广播顺序；新增identity模块接管原唯一去重表，不增加第二store或队列。存储域原字符串不折叠大小写/路径分隔符；完整ID集合及目录排序只用于摘要，不改广播顺序、字体id/sourceId或数据库键。只有固定64字符SHA-256及时间留存，容量2048、60秒从首次接收起算；副本不延长期限。两通道都读取Rust一次构造的stateSignal，客户端normalizer和两域适配保留mutationId。Node仅在自身成功写入后生成node UUID，旧Rust无signal或无mutationId均不补造身份。

Rust使用现有std RandomState/BuildHasher的随机键哈希加AtomicU64序号，和用户时间/trace完全独立；新字段只在本地/共享stateSignal与原嵌套mutationProtocol中可选出现。无变化信号不生成身份；失败事务不产生成功signal。无依赖、DB schema/主键、IPC通道/方法签名、preload/renderer广播字段或写协议队列变化；原IPC回执内嵌stateSignal仅透传可选mutationId；tagMutationWriteProtocolRuntime既有start/commit版本屏障不变。

| 验证 | 证据与边界 |
| --- | --- |
| 旧版本反例 | `node build/diagnostics/check-tag-mutation-identity.cjs --baseline=eded4db`退出1，三个独立原故障均expected=2/actual=1；真实旧模块可加载，非编译错误冒充失败 |
| 新默认门 | 根/db隔离、完整第81项、目录内容/缺失/显式空、操作/签名/dirty区别、集合乱序与重复项、双通道正反顺序、相同attempt不同提交及同提交不同attempt、乱序旧副本、旧消息/缺字段、无变化、2048容量/60秒到期、日志抛错；实际revision→cache→broadcast顺序 |
| 退化检查 | 丢存储域、截断80项、错误按attempt去重、去掉容量上限、扩大过期窗口；各在LF/CRLF执行，共10次业务断言拒绝，正向两种换行均通过 |
| 传输/适配链 | 4个真实metadata client命令×oneshot/daemon共8场景，外部进程端口给定结果；真实JSON/协议解析、临时文件清理、适配与双通道去重。Rust进程执行由下面原生入口独立验证 |
| R-01/R-05关联链 | 原两种preload×成功/两次失败重试，真实队列→IPC→Node SQLite→signal→回读确认，第二连接验证实际数据库；未替换业务算法，不视为Rust执行 |
| 原只读observer | 未修改observer；F-03a/b均2次广播、reproduced=false，F-01a/b与F-02继续false |
| 原生 | 新Rust并发唯一性、跨进程同输入及同attempt不同提交、协议/结果身份一致断言；`--native`还执行真实daemon领域事件与job_finished回执、两通道先后顺序、第二SQLite连接。实际入口退出1，spawnSync cargo ENOENT；尚未编译/执行，不能视为通过 |

真实受控日志样本（非用户数据）：

```text
tag mutation identity: scope=local, decision=new, identity=dcc2897097b179ebae4ba909c891b08b063ed26671d555ece5213e6003cafbe6
tag mutation identity: scope=local, decision=duplicate, identity=dcc2897097b179ebae4ba909c891b08b063ed26671d555ece5213e6003cafbe6
tag mutation identity: scope=local, decision=legacy, identity=unavailable
```

原operation-chain的signal/signal-reject同时携带new/legacy/dedupe及有界摘要，trace仍仅诊断。旧消息保守刷新可能产生额外通知；保留窗口之外或容量淘汰后的副本也允许刷新。不提供跨重启永久去重，不从ID或客户端updatedAt推断提交先后；不同提交即便乱序仍触发权威查询。

Electron/Vite构建退出0（366/1/196模块），混淆3/3退出0，日志/tmp/hfm-r06-build.log。最终npm run verify退出0：TypeScript与112/112通过，日志/tmp/hfm-r06-final-verify.log；环境Node24.19.0/npm11.9.0/Linux。未执行完整npm run build，不把无Cargo、Windows/NAS或GUI环境当通过。

Context7已核对Rust std RandomState/BuildHasher官方文档（Rust 2021项目，Cargo未设置rust-version且本机无工具链；未推断实际编译版本），无新依赖。Mermaid已展示真实提交→双通道→摘要→版本/缓存/广播链。Create State返回Context Captured但No active world model，仅显示无关Markdown/足球模型；未写入这些模型，HFM项目级保存未确认，以Git/README/本执行卡为准。

### 原生与Windows开发模式待验

```powershell
git pull --ff-only origin stage/09-preview-tags-app
node build/diagnostics/check-tag-mutation-identity.cjs --native
$env:HFM_LOG_DETAIL = "debug"
npm run dev
```

原生入口需要既有Rust工具链；开发环境须重建当前sidecar以得到mutationId（`node build/rust/build-core-worker.cjs --required`），无npm依赖更新，不要求安装包。旧sidecar仍可读取，但decision=legacy不能证明新Rust去重已验收。两个共享根目录执行标签删除/重命名，批量至少81项且尾部不同，连续目录变化及同字体快速增删；检查新提交摘要不同，同一提交双通道仅一次signal，UI最后输入/目录/查询收敛。附startup日志、sidecar构建结果和操作顺序；Windows实机回执之前保持待验。

本R-06可按`git log -1 --format=%H -- build/diagnostics/check-tag-mutation-identity.cjs`定位并单独revert；无数据迁移。R-07未启动，前置R-01～R-05及历史性能问题保留各自待验/待查结论。

契约冻结补充白名单：build/diagnostics/fixtures/rust-worker-contracts.fixture.json仅迁移RustLocalTagsMutationStateSignal与RustSharedMetadataMutationStateSignal两个类型摘要；分别删mutationId可选行后验证原hash一致。依赖集合、导出集合、其他类型、必填字段拒绝及LF/CRLF检查保持原门。

R-03算法冻结补充白名单：build/diagnostics/check-shared-metadata-rust-atomicity.cjs仅更新受本轮signal构造新增mutation_id一行影响的摘要。先去除该行验证旧fcf08cda摘要完全一致，合并、revision/op_id、事务顺序与原8个退化检查保持原状；摘要说明更新为R-06通知契约，不再声称signal字节未变。

最终复核：27个白名单文件；git diff --check通过。只迁移4个fixture中的6项受影响摘要及R-03单条算法摘要，每项迁移前均证实移除本轮新增行即匹配旧值；不改其他冻结契约。无依赖锁、DB schema、UI/CSS、IPC频道、预加载入口或构建产物入库；远端发布前复核仍为eded4db，沿原分支提交本R-06。

## 22. R-07 执行卡

状态：自动验证通过待实机。基线5406f74c247e7a9dfd5d67b2fc7926453b6f7dbf，stage/09-preview-tags-app，起始工作树干净；R-01～R-06已交付，继承Cargo、Windows/NAS/GUI未验缺口。执行全量verify，保留原性能/引用门；整理F-01～F-05及X-01～X-13证据，缺失必需原生/实机证据不得关项。

精确白名单：README.md；本任务书；docs/plans/HFM_PREVIEW_TAG_APP_DECOMPOSITION_TASKBOOK.md；docs/plans/HFM_REMEDIATION_MASTER_TASKBOOK.md；docs/audits/HFM_FULL_CHAIN_AUDIT.md；build/diagnostics/check-local-tag-rust-atomicity.cjs；build/diagnostics/check-shared-metadata-rust-atomicity.cjs；新增build/diagnostics/helpers/nativeTagMutationFixture.cjs与build/diagnostics/check-native-tag-mutation-fixtures.cjs；package.json。

已发现验收阻断：R-02/R-03的--native把修复前state_machine.rs复制到当前crate，而当前signal struct新增mutation_id: Option<String>，历史构造器缺字段；原生反例会先编译失败，无法到达必须的数据库断言。无Cargo时此为源码结构确认，不能声称运行得到Rust编译错误。仅测试夹具新增mutation_id: None，不回填当前业务算法或改变历史事务顺序；必须证明移除兼容行后字节等于原始历史源码。两脚本复用同一夹具适配所有者；不改生产代码、Rust类型/业务、数据库schema、依赖、IPC或既有反例期待。新默认门覆盖两域历史输入、LF/CRLF、重复迁移/锚点缺失拒绝及编译错误不可当SQL反例通过；真正Rust编译/SQL失败仍由--native确认。容量与生命周期、公开API另按原生产门及源码审查登记。

回滚为本R-07独立提交revert；不会回滚R-01～R-06生产修复。无用户字体库/NAS写入。原生入口和D-03定向命令逐个尝试，记录真实退出码；Windows缺口按§10保持待验，提供可复制命令和回执表。

### R-07 夹具修正与自动总验收

只在历史测试源的signal构造器补`mutation_id: None`，不生成假提交身份、不修改任何历史SQL/事务/trace语句。当前源码构造器兼容检查纳入默认verify，不要求历史Git对象；另用`--history`实际读取934139b本地旧源及cee7970共享旧源，LF/CRLF各自验证删除兼容行后字节完全相等。已有字段、丢锚点、多构造器及未知域一律拒绝。原生失败验收增加进程退出、Rust test FAILED及panic/数据库断言联合检查，8种启动失败/编译错误/无关失败/仅匹配文本的假回执被拒绝；这些是验收器单元输入，不能计作Rust执行。

实际命令与结果：

| 命令 | 退出/数量 | 范围 |
| --- | --- | --- |
| `npm run verify` | 0；TypeScript与113/113 | 原112门不删、不改fixture，新夹具门1项 |
| `node build/diagnostics/check-native-tag-mutation-fixtures.cjs --history` | 0；2域×LF/CRLF | 真实旧源适配字节保持、8种错误证据拒绝；无Cargo |
| `node docs/audits/observe-chain-audit.cjs` | 0；F-01a/b、F-02、F-03a/b全部false | 只读观察器原样运行，不改结果期待 |
| R-01实际Node链额外取样 | 成功及两次失败后成功 | 原生产队列/两层IPC/SQLite/通知/回读确认；第二连接验证0→0→1行 |
| R-02 `check-local-tag-rust-atomicity.cjs --native` | 1；Cargo ENOENT；原生执行0 | 默认结构门通过后原生启动阻塞 |
| R-03 `check-shared-metadata-rust-atomicity.cjs --native` | 1；Cargo ENOENT；原生执行0 | 默认结构/12个TS场景后阻塞 |
| R-04 `check-preview-cache-rust-atomicity.cjs --native` | 1；Cargo ENOENT；原生执行0 | 默认客户端/变异门后阻塞 |
| R-06 `check-tag-mutation-identity.cjs --native` | 1；Cargo ENOENT；原生执行0 | 包含全crate测试和真实daemon双通道入口，未运行 |
| `cargo test --manifest-path native-src/hfm-core-worker/Cargo.toml local_tags::read_state::tests` | 进程未启动ENOENT；无退出码；执行0 | D-03两个定向测试没有新回执 |
| `cargo test --manifest-path native-src/hfm-core-worker/Cargo.toml --test operation_trace` | 进程未启动ENOENT；无退出码；执行0 | R-01真实Rust关联未验 |

执行环境Linux、Node v24.19.0、npm11.9.0。实际日志/tmp/hfm-r07-verify.log、/tmp/hfm-r07-native-results.json与各/tmp/hfm-r07-*-native.log，观察/tmp/hfm-r07-observer.json。不把包装脚本的1与Cargo实际测试失败混淆；没有原生已执行用例数。生产源码、Rust源码、依赖锁与所有fixture相对5406f74逐字无差异；沿用该提交的366/1/196构建和混淆3/3证据，本轮未重复构建，不宣称执行完整npm run build。

原性能门保留原阈值：1万字体、6查询、500次布局、500项可见选择影响、万项shift选择、详情开关/卡片回调引用。实测search18.2ms、scroll2.2ms/500、shift selection0.5ms、最多60卡；原预算2500/500/500ms、虚拟卡上限80未修改。这是受控Linux测试，不是Windows实机帧率结论。

### F-01～F-05证据登记

| 发现 | 原反例/修复提交 | 当前自动证据 | 原生/实机状态及限制 |
| --- | --- | --- | --- |
| F-01a/b旧确认与其他字体旧目录清除新输入 | b7f68e1反例；R-05 eded4db | tag-intent-lifecycle、原observer均通过；意图按字段/成员结算、成功后权威查询确认 | Windows快速跨页/详情与真实广播回执待验 |
| F-02失败超过20秒丢失保护 | b7f68e1反例；R-05 eded4db | 20秒/数分钟失败保护、重试、关闭、reload及TTL退化被拒绝 | 真实NAS离线恢复、正常关闭重开待验 |
| F-03去重遗漏存储域/完整IDs/目录 | eded4db三反例；R-06 5406f74 | tag-mutation-identity、8客户端场景、LF/CRLF变异、容量/过期及observer通过 | Rust实际mutationId/双通道、Windows多根批量待验 |
| F-04本地绑定/目录原子性 | 修复前934139b；R-02 cee7970 | 默认原子结构门、Node真SQLite失败回读、回退准入及夹具适配通过 | 原始Rust SQL反例/修复/退化三者均未执行；不能只凭日志关项 |
| F-04共享metadata同类边界 | 修复前cee7970；R-03 8b60ee7 | 默认结构/12个TS边界、合并契约不变、夹具适配通过 | 原生事务/COMMIT故障与NAS多机待验 |
| F-04预览metadata同类边界 | 修复前8b60ee7；R-04 1b39bb2，CRLF门3fac7e7 | 16客户端路径、未知结果不跨后端重放、预览索引和回滚结构门通过 | 原生COMMIT/元数据故障与Windows共享缓存待验 |
| F-05关联日志不足 | 原审计7e0e6d7；R-01 934139b及R-04预览关联补充 | 真实Node链、两个preload、重试/部分成功、容量/日志错误/监听清理及因果退化通过 | Rust actual worker与Windows界面/DB三方对应仍待验；缺日志只记证据不足 |

修复提交均沿stage/09-preview-tags-app保留，R-07不重写其历史。F-04已有原生测试代码，不再沿用建书时“尚无原生测试”的描述；有测试文件不等于已执行。

### 当前真实关联样本

2026-09-17本次临时SQLite取样（非用户数据，完整事件在/tmp/hfm-r07-chain-evidence.json）：
- 成功operationId=`renderer-mu52yspk-75c9382t085:1`，attemptId=`renderer-mu52yspk-75c9382t085:3`，batchId同前缀`:2`；阶段dispatch→ipc-start→backend-start→commit→signal→view-reject/view-apply→ipc-result→intent-committed→queue-settled→post-ack-read-confirmed。实际commit1，确认保留原operationId。
- 重试operationId=`renderer-mu52ysv8-wo7fw39jyvh:1`不变，三个attempt同前缀`:3`/`:5`/`:7`，batch分别`:2`/`:4`/`:6`；前两次backend-result→intent-retry→retry且commit0，第三次commit1后确认原operationId；原验证器的独立连接逐次确认失败无行、成功有绑定。
- `view-reject`表示广播不直接确认pending意图，后续`view-apply`允许目录和库更新；两者并存不是一次操作同时成功/失败。最后确认日志的reason为`local-g1-post-ack-read-confirmed`；并不声称已在真实Electron窗口绘制。

### 所有权、资源与兼容审查

- 业务状态仍归原七controller和原写队列；R-05字段Symbol token随字体对象/队列条目生命周期，不建立全局业务Map、不持久化会话意图、不新增TTL timer。查询只确认开始前已ack且仍为同一token的结果；旧分页由原序号门拒绝。
- R-06唯一去重表位于每个signal runtime的identity闭包，固定2048条64字符十六进制摘要，60秒由接收时清理；没有新增轮询或全局状态副本。未确认意图的LRU保留沿用原归一化owner。
- R-01诊断身份WeakMap不强持有队列条目；renderer在途日志最多256，单事件最多8192字节、信封成员16，主进程operation-chain每会话16MiB并有dropped/omitted。AsyncLocalStorage隔离请求；清理与并发已由原门运行。
- renderer signal effect返回原dispose；R-01～R-06新增能力没有额外全局监听或业务计时器。当前全量生命周期门验证原7 app/2 process注册和关闭flush→save→确认链，没有把受控挂载卸载当长期GUI泄漏实测。
- 上述16MiB是operation-chain额度，不是整个startup文件硬限。原startup logger的64KiB是刷盘触发阈值、80ms为延迟；日志文件按启动分开，当前没有新增自动清理/保留天数策略。普通startup日志与慢磁盘队列并无此次证明的总硬上限；用户验收后应关闭debug，不宣称全软件日志容量已闭环。
- IPC通道、方法/旧调用参数、DB schema/业务键、两套preload、依赖锁及UI全部未改；R-01/R-06先前新增的可选trace/mutationId兼容含义不变。R-07仅测试夹具/验证器/文档变更，未增加生产模块或更改退出顺序。

### X矩阵与Windows回执入口

下表自动门均在本轮113/113内执行；原生与Windows列全部待验。沿用原拆分任务书§27操作顺序，原104/104为历史证据，不覆盖成本轮结果。

| 矩阵 | 本轮自动证据（diagnostics名称） | 仍需的原生/Windows证据 |
| --- | --- | --- |
| X-01 本地标签 | decomposition-baseline、tag-intent-lifecycle | A改标签，A的收藏/共享/保护与B/C状态保持 |
| X-02 收藏 | user-intent-consistency、active-view-consistency | 收藏新增/取消及全部/收藏/详情和计数一致 |
| X-03 共享标签 | shared-tag-conflicts、shared-tag-ops-replay | 测试共享根修改、其他字段保持及冲突反馈 |
| X-04 快速跨域操作 | tag-intent-lifecycle、app-interaction-composition | 同字体连续改本地/共享/收藏，最后各字段意图保留 |
| X-05 反向结果 | decomposition-baseline、tag-intent-lifecycle | 快速反向操作和跨页/详情，不被迟到结果覆盖 |
| X-06 部分失败 | font-write-queue-durability、operation-chain | 隔离故障环境中本地失败/收藏成功，仅失败域重试 |
| X-07 NAS | shared-tag-conflicts、shared-tag-ops-replay | 独立测试共享根离线/恢复、多机冲突，其他字段不丢 |
| X-08 原子性 | local-tag-node-persistence、三类rust-atomicity默认门 | R-02/R-03真实SQL和COMMIT故障回读；不能以默认源码门替代 |
| X-09 空目录 | tag-consistency、local-tag-node-persistence、local-tag-rust-adapter | 最后解绑保留空标签；显式删除才从目录/菜单移除 |
| X-10 关闭重开 | window-close-flush、library-persistence-order、font-write-queue-durability | 编辑立即正常关闭重开，四字段保持、临时激活清理 |
| X-11 页面身份 | local-tag-hydration、app-interaction-composition、react-render-performance | 切筛选/目录、快速滚动/详情、多选，旧查询不覆盖新页面 |
| X-12 预览竞态 | preview-index-commit、preview-index-owner、preview-cache-generation | R-04原生提交/metadata故障；测试根写/删/读generation交错 |
| X-13 回退准入 | state-fallback、local-tag-rust-adapter、local-tag-hydration | D-03真实身份读取；允许/禁止回退，无重复写入/身份读 |
| 监听/激活补充 | watcher-index-consistency、watcher-activation-baseline、active-view-consistency | 测试目录增删/改名、折叠侧栏、激活/停用与跨页字段保持 |

X-06/08/12/13故障仅由隔离诊断临时库或专用测试根制造，不破坏正式字体库/NAS。GUI的视觉结果、IPC回执与数据库提交须分别记录；同一operationId串联它们，日志缺失只记证据不足。

在已有Windows开发环境、Rust工具链及对应编译环境中，逐行执行以下命令，任一失败停止并保留输出；不需要安装包或build:win。先确认工作树无自己的未提交改动。

```powershell
git pull --ff-only origin stage/09-preview-tags-app
if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
git rev-parse HEAD
npm run verify
if ($LASTEXITCODE -ne 0) { throw "verify failed" }
cargo test --manifest-path native-src/hfm-core-worker/Cargo.toml local_tags::read_state::tests
if ($LASTEXITCODE -ne 0) { throw "D-03 native failed" }
cargo test --manifest-path native-src/hfm-core-worker/Cargo.toml --test operation_trace
if ($LASTEXITCODE -ne 0) { throw "R-01 native failed" }
node build/diagnostics/check-local-tag-rust-atomicity.cjs --native
if ($LASTEXITCODE -ne 0) { throw "R-02 native failed" }
node build/diagnostics/check-shared-metadata-rust-atomicity.cjs --native
if ($LASTEXITCODE -ne 0) { throw "R-03 native failed" }
node build/diagnostics/check-preview-cache-rust-atomicity.cjs --native
if ($LASTEXITCODE -ne 0) { throw "R-04 native failed" }
node build/diagnostics/check-tag-mutation-identity.cjs --native
if ($LASTEXITCODE -ne 0) { throw "R-06 native failed" }
node build/rust/build-core-worker.cjs --required
if ($LASTEXITCODE -ne 0) { throw "sidecar build failed" }
$env:HFM_LOG_DETAIL = "debug"
try { npm run dev } finally { Remove-Item Env:HFM_LOG_DETAIL }
```

原子性入口须分别得到旧实现真实SQL断言失败、修复实现通过、退化实现被拒绝；编译失败不能冒充旧实现失败。R-06入口包含当前crate测试及真实daemon；新sidecar重建成功后再操作GUI，旧sidecar的legacy信号不能验收mutationId。GUI使用独立测试字体A/B及共享根C，按本表与原书§27完成操作，补至少81项尾部不同和两个根目录的通知隔离场景。

回执模板：

| 必填项 | 记录内容 |
| --- | --- |
| 版本/环境 | git完整SHA、Node/npm/Cargo版本、Windows版本、sidecar重建结果 |
| 原生门 | 命令、真实退出码、通过/失败/忽略用例数、原始输出；未运行明确写未运行 |
| 操作 | X编号、字体/测试根代号、初始四字段、操作顺序与时间 |
| 结果 | 预期与肉眼实际（闪回/延迟/目录/计数/跨页）；数据库独立回读、IPC回执分别列 |
| 关联 | operationId、attemptId、日志文件与具体行号/时间范围、提交/信号/回读确认阶段 |
| 结论 | 通过/失败/证据不足；附最小复现，不以缺日志推定未提交或成功 |

### 收尾与保留项

R-07自动部分通过；原生子项阻塞、Windows/NAS待验，F-01～F-05及D-11不作全部关闭。继承§19的首个收藏0→1显示延迟、激活全根同步、历史目录恢复、已激活字体文件预览实机、预览请求密度/耗时及共享标签全根同步/启动等待等待查或待复验项；本轮未扩展修复。

本轮仅10个白名单文件，新增模块是历史夹具适配/失败证据验证的唯一所有者，两个原生入口复用；没有生产状态所有者变动。差异复核覆盖公开API、依赖、数据库、监听/计时器及日志容量边界，git diff --check通过；src、native-src、依赖锁和既有fixtures相对5406f74无变化。以`git log -1 --format=%H -- build/diagnostics/check-native-tag-mutation-fixtures.cjs`定位R-07独立提交，单独revert不影响R-01～R-06生产修复。

插件回执：Mermaid Chart已展示真实队列→IPC→事务→通知→意图确认/查询链；未新增陌生框架或系统API，未触发Context7。Create State返回Context Captured但Project为`.`且No active world model；仅列无关Markdown/足球模型，未关联它们，HFM项目级保存未确认，以Git/README/本执行卡为准。

## 23. Windows反馈四项专项审计执行卡

状态：完成（仅四项审计，不含修复）；基线9edd6abee966095a61d9266c85add9448df06df1，stage/09-preview-tags-app，开工工作树干净。输入startup-2026-09-17_06-18-48-939-33208.log；仅审计停用旧状态、单字体全根同步、首屏预览延迟、缓存批查密度四项。日志没有Git SHA，不能仅以版本3.0.0认定用户源码与本基线逐字一致。

精确白名单：README.md；docs/audits/HFM_FULL_CHAIN_AUDIT.md；本任务书；新增docs/audits/observe-runtime-feedback.cjs（只读受控观察器，不纳入通过门，不冻结缺陷为正确行为）。生产源码、依赖、fixtures与正式数据不改。核对真实调用链，使用真实模块与受控外部端口复现，记录疑点和确定证据的边界；审计文档独立提交原分支。

审计结果：见[审计报告专项章节](../audits/HFM_FULL_CHAIN_AUDIT.md#windows反馈专项审计停用同步与预览)。W-01热/冷查询在真实异步保存队列flush前仍返回旧active，flush后收敛；W-02单字体到根snapshot路由；W-03同步net/PowerShell探测；W-04同ref队列跨runtime重建重复批查，四条受控观察reproduced=true。三项相关原诊断退出0，未跑全量或构建。原生/GUI与精确延迟归因限制单列；原R-07仍自动验证通过待实机。仅4个白名单文件，后续依次处理W-01、W-02，再分别修W-03/W-04。

插件：Mermaid已展示真实状态与预览调用链；没有新增/陌生API，不需Context7。Create State返回Context Captured，但No active world model，HFM项目级保存未确认；未关联无关模型。差异复核git diff --check通过，生产/依赖/fixture无变更，沿原分支独立提交审计。

## 24. Windows反馈四项修复执行卡

状态：四项生产修复及自动验收完成，Windows待复验；基线c352c81c1cf9d1511db967821a7dc1d4fa212d09，沿stage/09-preview-tags-app，工作树干净。W-01由原激活保存队列提供pending/in-flight结果覆盖，schedule及释放时失效缓存，查询跨generation重读；不新增第二业务store。W-02保留实际字体至原增量同步，非安装签名变化仍重建。W-03原storage profile owner异步合并探测并保守限流，路径规范化不改。W-04原preview controller跨render保持一个runtime，通过同一options对象读取最新值，reset/dispose保护旧批查与计时回调。

精确白名单：README.md；本任务书；docs/audits/HFM_FULL_CHAIN_AUDIT.md；docs/audits/observe-runtime-feedback.cjs；package.json；src/main/activation/activationInstallStatusSaveQueue.ts；src/main/activation/mainActivationInstallStatusSaveRuntime.ts；src/main/bootstrap/mainCompositionFeedback.ts；src/main/bootstrap/mainDataCompositionRuntime.ts；src/main/bootstrap/mainDataQueryCompositionRuntime.ts；src/main/bootstrap/mainMutationCompositionRuntime.ts；src/main/index.ts；src/main/library/fontQueryFacadeRuntime.ts；src/main/library/fontMemoryQueryRuntime.ts；src/main/library/fontPageQueryCacheRuntime.ts；src/main/indexing/mergedIndexPageRuntime.ts；src/main/indexing/merged-page/mergedIndexValidationRuntime.ts；src/main/indexing/merged-page/mergedIndexSyncRuntime.ts；src/main/performance/storageProfileRuntime.ts；src/renderer/src/runtime/app/usePreviewController.ts；src/renderer/src/runtime/preview/fontPreviewQueueRuntime.ts；src/renderer/src/runtime/preview/queue/fontVisiblePreviewQueueRuntime.ts；src/renderer/src/runtime/preview/queue/fontPreviewLoadRuntime.ts；src/renderer/src/runtime/preview/queue/fontPreviewQueueTypes.ts；新增build/diagnostics/check-runtime-feedback.cjs。必要既有门契约迁移须先登记具体证据，禁止整体重录。无DB schema、依赖、用户数据、IPC/UI变化。

验收：原四项反例转为正确断言，涵盖延迟读/保存失败/新旧批次、多根与签名回退、异步慢探测/失败恢复/网络限流、真实Hook rerender及旧token/卸载。全量verify与构建；Windows冷启动分段耗时和真实视觉回执继续待验，不冒称Linux替代。

白名单补充：build/diagnostics/check-log-regression-followup.cjs仅迁移activation缓存失效时机断言（新pending权威状态进入/释放必须失效，未变化仍禁止写DB/同步）；build/diagnostics/fixtures/decomposition-baseline.fixture.json仅迁移usePreviewController两个runtime生命周期ref与对应tokenHash；build/diagnostics/check-react-composition-controllers.cjs及其fixtures/react-composition-controllers.fixture.json仅适配preview新dispose/resume端口并迁移受本次生命周期修复影响的preview文件摘要，原40字段初值、其他controller及行为变异门保留。迁移前核对原基线摘要；新增真实Hook/延迟队列门替代这些变更片段的旧字节冻结。

白名单补充：build/diagnostics/check-query-cache-invalidation-generation.cjs。完整verify实报原内存generation断言要求晚到结果仍return items，已与W-01跨generation重读冲突；仅将该结构断言迁移为重读，并加强行为断言为旧调用者也收到新结果。原分页在途隔离、metrics与缓存不污染断言保留，不删除诊断。


实现记录：W-01组合根通过原mutation feedback将队列查询覆盖注入data query；W-02可选items贯穿save→validation→incremental，保留旧全局刷新调用；W-03探测按需异步合并、未知时保守限流，路径身份owner未改；W-04固定runtime、最新options、generation及reset/dispose/resume，额外覆盖单字体回退await后的旧请求失效和visible集合离队清理。生产改动均留在既有责任模块，新增文件仅为四项运行反馈的诊断门。

原冻结摘要核验后定向迁移：decomposition仅usePreviewController的owners追加runtimeOptionsRef/queueRuntimeRef和tokenHash；react-composition仅fontPreviewQueueRuntime、fontPreviewLoadRuntime、fontVisiblePreviewQueueRuntime三项sourceHashes；旧40字段初值与函数摘要不变。preview创建顺序断言同步匹配实际保留实例调用，并要求调用确实存在，避免旧文本不存在时以-1误通过。

验证：npm run verify退出0，TypeScript、114/114默认诊断通过；最终改动复跑typecheck，Electron/Vite构建366/1/196、混淆3/3通过。四链观察均false；4个历史模块反例各在对应业务断言失败；当前LF/CRLF及8个因果退化断言全部通过。最初verify的owner冻结、后续旧generation文本契约均定向迁移；相关缓存失效旧断言也经实际运行失败后迁移，无绕过门禁。最终结果与未验证边界见审计报告“Windows反馈四项修复结果”。无新增依赖/锁、数据格式、schema或IPC；持久化/关闭接口兼容，无数据迁移。回滚按本轮独立fix提交整体revert，避免只回滚端口一端。


最终范围为30个白名单文件（含README、审计报告、执行卡及唯一新增诊断文件）；依赖锁、native-src、两套preload、UI结构均未改。W-02多根同时签名变化仍保守重建；W-03独立路径规范化的同步net use未改；已有原生/Windows/NAS待验项仍保留。首屏减时不作定量承诺，原四问题的Windows实际回执按审计修复节采集。

插件：Context7核对Node24 execFile异步回调、timeout及windowsHide；Mermaid Chart已展示真实保存/查询覆盖/增量及预览生命周期与异步探测链。Create State返回Context Captured，但Project为`.`、No active world model；HFM项目级保存未确认，未关联无关模型。Git、README与本执行卡为续接依据。

## 25. 标签目录、停用核对与本地收藏修复执行卡

状态：修复与自动验证完成，Windows/NAS实机待验；基线398eabb875cc0df00ec3b8c96355c5bd80c1b7c6。用户明确授权完整修复并将收藏改成本机独立保存。输入两份09-17日志：10:51删除共享标签成功但通知没有knownTags；停用3项无临时记录而查询仍3项；收藏写入共享metadata。

方案与验收：共享修改串行事务结束后发布完整跨根目录（包括空数组），保留较新标签意图，覆盖零绑定/最后标签/重命名/部分失败；停用单个及批量重新比较系统安装，查询有本机安装快照时不得OR共享active，缺快照不得宣称共享激活为本机激活；收藏新增app.sqlite本地表，初次仅从已有本机merged快照迁移，保留共享历史列以兼容旧客户端，不再读写它作为当前收藏。分页、排序、ID查询、完整载入及统计均读取本地收藏。迁移与写入事务化、重启幂等、旧共享更新不能覆盖、取消收藏不能复活；不清除共享数据库的历史数据。回滚整体revert代码，本地新增表可保留；本地新收藏不会反向写回旧共享收藏。

精确白名单（生产）：src/main/library/sharedFontMetadataMutations.ts；src/main/library/sharedKnownTagsRuntime.ts；src/main/library/tagMutationStateSignalRuntime.ts；src/main/library/tagMutationWriteProtocolRuntime.ts；src/main/library/runtime/libraryPersistenceRuntime.ts；src/main/library/runtime/librarySchemaRuntime.ts；新增src/main/library/runtime/localFontFavoritesRuntime.ts；src/main/bootstrap/mainDataStorageCompositionRuntime.ts；src/main/bootstrap/mainDataQueryCompositionRuntime.ts；src/main/bootstrap/mainDataCompositionRuntime.ts；src/main/bootstrap/mainMutationCompositionRuntime.ts；src/main/bootstrap/mainCompositionContracts.ts；src/main/index.ts；src/main/ipc/ipcHandlerTypes.ts；src/main/ipc/handlers/fontSystemIpcHandlers.ts；src/main/library/fontQueryFacadeRuntime.ts；src/main/library/fontMetricsRuntime.ts；src/main/activation/runtime/fontActivationInstallStatusRuntime.ts；src/main/activation/runtime/fontActivationSessionRuntime.ts；src/main/activation/runtime/fontDeactivationBatchRuntime.ts；src/main/indexing/root-query/rootIndexQuerySharedSql.ts；src/main/indexing/root-query/mergedIndexPageQuerySql.ts；src/main/indexing/rootIndexCoordinator.ts；src/main/indexing/merged-page/mergedIndexPageQueryRuntime.ts；src/main/library/query-sql/fontQueryOrderRuntime.ts；src/main/library/query-sql/fontQueryClausesRuntime.ts。文档/验证：README.md；本任务书；package.json；新增build/diagnostics/check-local-user-state.cjs。必要关联路径或旧诊断契约迁移，在有证据后追加具体文件，不整体重录冻结夹具。

验证要求：实际模块+SQLite复现原错误，覆盖多根/空目录/永久安装/系统读取失败/本机A与B隔离/历史迁移/重启/共享刷新/分页计数；原有完整verify、TypeScript、Electron/Vite构建与差异白名单复核。Windows字体资源与NAS真实交互单列待验，不以受控端口替代实机结论。

白名单补充（已定位链路）：src/main/bootstrap/mainTagCompositionRuntime.ts负责把串行提交后的完整目录送入既有通知owner；src/renderer/src/runtime/app/effects/useFontTagStateSignalEventRuntime.ts原监听每个通知都把旧目录saveLibrary回写，移除此反向写入，避免事务中的无目录通知复活已删标签；src/main/indexing/root-query/rootIndexPageQuerySql.ts需本地收藏筛选与排序；src/main/library/runtime/libraryLoadRuntime.ts与src/main/library/libraryRuntime.ts完整库读取同样需本地收藏覆盖。

白名单补充：src/main/bootstrap/mainApplicationRuntime.ts为收藏能力的现有注册转发；src/main/activation/runtime/fontActivationCleanupRuntime.ts退出/启动清理也须把已成功清除记录核对后送入原状态保存队列，防止重启继续显示旧active。src/main/library/fontMetricsRequestCoalescerRuntime.ts旧在途metrics失效后虽不缓存仍返回旧值，需与分页一样重读当前代结果，防止停用/收藏后计数回跳。

诊断迁移证据：完整115项独立跑完发现旧断言要求共享favorite mergePolicy、标签通知后saveLibrary、停用无记录不保存，以及隔离loader没有新的现有status模块/系统端口。精确补充build/diagnostics/check-tag-consistency.cjs、check-library-persistence-order.cjs、check-shared-metadata-field-merge.cjs、check-shared-tag-conflicts.cjs、check-font-activation-transaction.cjs、check-watcher-activation-baseline.cjs、check-active-view-consistency.cjs；仅迁移上述冲突与真实依赖，保留失败边界及变异检查。已有IPC注册能力名称继续兼容，底层实现改成本地收藏，避免无关接口改名。

夹具补充：build/diagnostics/fixtures/main-composition-runtime.fixture.json仅新增一个localFavorites owner、首次授权读库前initialize调用及schemaAudit.openLibraryDb由直传转包装；main-operations-composition.fixture.json仅sharedTagsStartup读库前initialize调用。先用398eabb的全部改动生产模块覆盖回放，已确认原两个夹具逐值相等；新观察的全部差异只有这4处，禁止整份重录。

白名单补充：src/main/activation/runtime/fontDeactivationSettlementRuntime.ts既有路径key仅小写，补齐斜杠规范化并供单个停用复用，防止同一路径不同写法漏掉本机临时记录。

后续门证据：main-operations夹具startup.schemaAudit同一openLibraryDb包装端口标识变化（顺序/其他值不变），追加该字段迁移；build/diagnostics/fixtures/watcher-activation-baseline.fixture.json仅fontActivationSessionRuntime源码sha256变化，原exports/functions不变。更新前核对398eabb对应源码hash，既有W-01行为与变异门继续执行。

白名单补充：src/renderer/src/sharedMetadataSyncRuntime.ts仅移除共享同步提示中的“收藏”，与本地保存语义一致。

最终关联检查补充：src/main/library/fontPageQueryCacheRuntime.ts原generation重读仅覆盖active，收藏/智能排序页在写入后仍可返回旧total，改为所有已失效分页拒绝旧结果。build/diagnostics/check-query-cache-invalidation-generation.cjs调整旧调用者的等待顺序并断言收到新代结果；原测试先await旧metrics再释放新gate，会在无event-loop句柄时退出0而未完成，补beforeExit完成哨兵，保留全部原隔离断言。新增门同步覆盖收藏分页、ID及统计的在途失效。

完整verify实报AT-6.4冻结sharedMetadataSyncRuntime源码摘要因提示文字变化失败：补充build/diagnostics/fixtures/react-composition-domain-controllers.fixture.json，仅该文件sourceHashes一项；先用398eabb源文核对旧hash，再计算新hash。控制器生命周期与42项状态等其他冻结值不动。

性能边界复核：收藏仅失效查询缓存，不清空NAS字体缓存。两项本机计数优先在既有本地merged快照关联app.sqlite读取，叠加原激活保存队列；快照行数/根范围不符才使用既有字体载入回退，避免每次metrics都重新遍历共享目录。逻辑归属既有fontMetricsRuntime，组合根只接线；不新增统计store或Rust协议。

完整库IPC读取补齐：mainDataComposition.loadLibrary在原storage载入后复用query安装状态水合，与分页一致，不再直接返回共享font_json的active。build/diagnostics/check-main-composition-runtime.cjs原“载入函数引用等于storage函数”定向改为验证storage载入→query水合及字段保留；helpers/mainCompositionHarness.cjs为该行为提供受控库快照端口。IPC签名和数据库句柄唯一所有者不变。

最终W-01冻结迁移：核对398eabb的fontActivationInstallStatusRuntime旧源码摘要后，仅更新该文件sha256与新增reconcileDeactivatedInstallStatus函数名；其余导出及另外9个未修改生产文件冻结值不动。此前sessionRuntime的单项摘要迁移保留；原行为回归与10项变异检查继续执行。

### 本轮完成与验证边界

- 共享标签：串行提交后发送完整全局knownTags（包括空数组），零绑定目录同样更新；失败根保留目录，回读失败明确反馈，不制造空目录。渲染通知不再saveLibrary回写旧目录；标签pending意图保护继续保留。
- 停用：单个、批量、启动/退出清理复用安装状态owner，核对新系统列表，分离临时/永久安装；无记录仍核对，系统读取失败不虚报成功。分页、完整库、ID、统计与在途查询统一本机状态及原待保存覆盖。
- 收藏：唯一权威为app.sqlite.local_font_favorites；一次性事务迁移已有本机merged快照，新机器不导入NAS收藏。取消保存false并清理身份别名；收藏变更只失效查询缓存，保留NAS缓存。本地标签/共享标签/保护字段与既有IPC能力名不变。
- npm run verify通过：TypeScript + 115/115诊断；新增门包含实际SQLite、A/B隔离、迁移/重启/回滚、标签目录和实际渲染通知、单个/批量停用与真实安装比较器、分页/ID/统计失效，LF/CRLF及4个旧代码反例、4个退化反例。
- Electron/Vite构建367/1/196模块，混淆3/3通过；git diff --check通过。未执行依赖Cargo的完整npm run build或Windows打包，未声称Windows字体资源/NAS实机验收通过；Rust源码未变。
- 最终46个文件均属于本节白名单及明确补充；未实际修改的预列候选文件不纳入提交。旧冻结夹具只迁移已证实的组合接线/源码摘要差异，不整体重录。
- 实机回执：删除最后一个共享标签并重启；取消激活后核对侧栏计数和列表（永久安装仍保留）；A机收藏/取消并重启，B机不随A变化，期间共享标签和保护不变。开发方式仍使用npm run dev。
