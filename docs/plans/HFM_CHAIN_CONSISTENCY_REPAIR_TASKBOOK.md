# HFM 全链路一致性修复任务书

## 0. 状态与执行入口

- 文档版本1.5；日期2026-09-16；软件3.0.0；仓库uniquenesssta/99。
- 建立基线：`58a3f25e632a2af1d49587ab065e0469da4bf330`；执行分支沿用`stage/09-preview-tags-app`。开工时重新核对远端、HEAD与工作树，不默认为本基线一直最新。
- 当前R-01日志实施与自动验证通过，待原生/实机回执；R-02自动验证通过待实机（原生测试未执行）；R-03自动验证通过待实机（原生测试未执行）；R-04自动验证通过待实机（原生测试未执行）；R-05～R-07未开始。Windows/Rust原生证据单列，不宣称全部修复完成。
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
- R-01的operation-chain门已接入默认verify；R-02/R-03/R-04已有默认约束门和独立原生验收入口；R-05/R-06业务修复门尚未创建，不能将文档存在等同于约束已经被CI执行。

## 12. 状态登记

| 任务 | 状态 | 执行基线/提交 | 自动/原生/实机结果 |
| --- | --- | --- | --- |
| R-01 日志前置 | 自动验证通过待实机 | 2cf2986起，本R-01独立提交 | TypeScript、105/105；Cargo退出127；Windows待验 |
| R-02 本地标签事务 | 自动验证通过待实机 | cee7970 | 106/106；无Cargo，原生及Windows待验 |
| R-03 共享事务 | 自动验证通过待实机 | cee7970起，本R-03独立提交 | 107/107及12个TS场景；Cargo缺失，原生/Windows待验 |
| R-04 预览事务 | 自动验证通过待实机 | 8b60ee7起，本R-04独立提交 | 108/108及16个客户端场景；Cargo缺失，原生/Windows待验 |
| R-05 标签确认生命周期 | 未开始 | — | — |
| R-06 信号去重 | 未开始 | — | — |
| R-07 总验收 | 未开始 | — | — |

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
