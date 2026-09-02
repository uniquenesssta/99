# HanFontManager Stage 1：激活与停用事务任务书

## 0. 文档状态

- 文档版本：1.2
- 建立日期：2026-09-01
- Stage 分支：`stage/01-activation-transactions`
- 起始提交：`d35ba6f89b7966427a8a671ff0016bff3d7f5d9c`
- 当前 Atomic Task：AT-1.1 至 AT-1.3 已完成；AT-1.4 待启动
- 前置阶段：Stage 0 已完成；事务观察 A1-A8 和编排公开契约均已固化
- 上级任务书：[`HFM_REMEDIATION_MASTER_TASKBOOK.md`](HFM_REMEDIATION_MASTER_TASKBOOK.md)

本文档只维护 Stage 1 的执行细节、逐项门禁和实际结果。总体顺序、跨阶段停止条件与三大编排文件拆分标准以总任务书为准。

## 1. 阶段目标与边界

Stage 1 只修复临时字体激活、停用和托管安装的事务正确性，不同时处理路径授权、跨卷移动、依赖升级或三大编排文件搬迁。

必须达成：

1. 底层资源 helper 的逐项失败不再被解释为成功。
2. 批量停用按字体逐项结算，失败项保留可重试状态。
3. 单项激活任一步骤失败时执行逆序补偿，补偿失败有持久清理入口。
4. 批量激活复用单项事务语义，取消和部分失败不产生假成功。
5. Stage 0 的 A1-A8 观察逐步反转为长期正确性门禁，并最终完整纳入 `diagnostics:all`。

明确不做：

- 不修改 `hfm-font://`、预览数据或物理文件操作的路径授权；这些属于 Stage 2。
- 不处理跨卷移动和原生预览尺寸上限；这些属于 Stage 3。
- 不拆分 `src/main/index.ts`、`rustCoreWorkerRuntime.ts` 或 `App.tsx`；Stage 1 只运行其公开契约门禁并记录新增耦合，正式拆分分别属于 Stage 4/5/6。
- 不升级 Electron、electron-builder 或其他依赖；这些属于 Stage 7。

## 2. 事务不变量

| 编号 | 不变量 | 可验证结果 |
| --- | --- | --- |
| T1 | `null`/`undefined` 才表示 Rust 路径不可用 | 只有这种情况允许尝试 native fallback |
| T2 | 非空 helper 结果是该次执行的权威结果 | `ok:false` 或缺少目标条目必须失败，不能换 helper 重做 |
| T3 | 失败原因不丢失 | 上层异常包含 helper 返回的 `message`；无消息时使用可定位的保底原因 |
| T4 | 只有明确成功才能推进事务 | 失败时不得更新通知时间、会话状态、安装状态或删除后续资产 |
| T5 | 持久状态描述可重试事实 | 资源仍活动或补偿未完成的记录不能被删除 |
| T6 | 补偿顺序与提交顺序相反 | resource -> registry -> copied file；状态提交始终最后发生 |
| T7 | 批量只做调度与汇总 | 不另写一套与单项不同的事务算法 |
| T8 | 取消不撤销已提交项，也不启动未开始项 | 结果明确区分已提交、失败、取消和未开始 |

## 3. Atomic Task 清单

### AT-1.1 字体资源单项结果传播

状态：已完成。

允许修改：

- `src/main/windows/runtime/fontResourceSessionRuntime.ts`
- `build/diagnostics/check-font-activation-transaction.cjs`
- `package.json`
- 两级任务书与 README

实现要求：

- [x] 单项 add/remove 收到非空 Rust 结果后检查目标条目存在且 `ok:true`。
- [x] Rust 条目 `ok:false` 时以原始消息失败，不进入 native fallback。
- [x] Rust 结果缺少目标条目时视为协议失败，不进入 native fallback。
- [x] Rust 明确不可用时才尝试 native helper。
- [x] native 条目同样要求存在且 `ok:true`；失败消息原样向上返回。
- [x] 所有 helper 均不可用时 remove 必须失败，不能静默返回。
- [x] 只有明确成功且请求 notify 时才能更新 `lastBroadcastAt`。
- [x] 将 A1 从 `KNOWN_DEFECT` 反转为 `CORRECTNESS_LOCK` 并纳入 `diagnostics:all`。
- [x] 保留 A2/A4-A8 的阶段性观察能力，避免未修复任务伪装成绿色门禁。

定向故障矩阵：

| 场景 | 期望异常 | native 调用 | notify 状态 |
| --- | --- | --- | --- |
| Rust remove `ok:false` | 原始 Rust message | 0 | 不变 |
| Rust remove 返回空结果 | 缺失条目错误 | 0 | 不变 |
| Rust 不可用、native remove `ok:false` | 原始 native message | 1 | 不变 |
| Rust 与 native 均不可用 | 无安全 fallback 错误 | 1 | 不变 |
| Rust remove `ok:true` | 无 | 0 | notify 时更新 |
| Rust add `ok:false` | 原始 Rust message | 0 | 不变 |

提交：`fix: 传播字体资源单项失败结果`

硬门禁：

```bash
npm run diagnostics:font-resource-session-result
npm run typecheck
npm run diagnostics:all
```

### AT-1.2 批量停用逐项结算

状态：已完成。

实际范围：

- `src/main/activation/runtime/fontDeactivationBatchRuntime.ts`
- `src/main/activation/runtime/fontDeactivationSettlementRuntime.ts`
- `src/main/activation/runtime/fontActivationCleanupRuntime.ts`
- `src/main/activation/runtime/fontActivationTypes.ts`
- `src/main/activation/temporaryFontDeleteQueue.ts`
- `src/main/windows/runtime/fontResourceSessionRuntime.ts`
- `build/diagnostics/check-font-activation-transaction.cjs`
- `package.json`
- 两级任务书与 README

完成项：

- [x] 建立大小写不敏感的 `installPath -> resource result` 逐项映射；缺失条目按失败处理。
- [x] 对每条临时激活记录分别结算 resource、registry、file queue 三阶段结果。
- [x] 资源移除失败时不推进注册表、文件队列或持久状态，并返回原始逐项原因。
- [x] 注册表按唯一 value 单独调用并结算；单个删除失败不阻塞其他成功项，但失败项不排队删除文件且保留持久会话记录。
- [x] 文件只有写入持久删除队列后才视为该记录提交成功；队列拒绝或保存失败时状态保留。
- [x] 由逐项结果计算 `deactivated`、`failed`、安装状态更新和用户消息，不再固定失败数或整批吞错。
- [x] Rust/native 注册表批量结果只在全部成功时接受；`reg.exe` 删除失败只有经查询确认值已不存在时才按幂等完成处理。
- [x] A2 反转为混合批次正确性门禁并加入长期诊断；Stage 0 观察现为 5 个已知缺陷、3 个正确/行为锁。
- [x] 将逐记录事务结算从批量调度器中拆为独立职责模块，生产文件分别为 183/202 行；未触碰三大巨型编排文件。

硬门禁：一成一败的批次只能提交成功项；失败项仍在会话状态中，且不会进入错误的文件删除路径。

提交：`fix: 按项结算批量字体停用`

### AT-1.3 单项激活逆序补偿

状态：已完成。

实际范围：

- `src/main/activation/runtime/fontActivationSessionRuntime.ts`
- `src/main/activation/runtime/fontActivationCompensationRuntime.ts`
- `src/main/activation/runtime/fontActivationCompensationQueue.ts`
- `src/main/activation/fontActivationRuntime.ts`
- `src/main/activation/runtime/fontActivationTypes.ts`
- `build/diagnostics/check-font-activation-transaction.cjs`
- `package.json`
- 两级任务书与 README

完成项：

- [x] 新激活严格按复制文件 -> 写注册表 -> 添加 resource -> 保存临时会话状态提交，安装状态只在会话状态成功后更新。
- [x] 每个成功阶段设置独立补偿标记；复制本身失败时不推进注册表、resource、状态或补偿副作用。
- [x] 后续阶段失败前先将补偿意图写入独立持久队列，再按 resource -> registry -> copied file 逆序执行。
- [x] resource 或 registry 补偿失败时继续尝试其余适用补偿，但阻止文件进入删除队列，避免活动资源指向已删除文件。
- [x] 文件只有成功写入既有持久删除队列后才完成文件补偿；入队失败保留 file 阶段供重试。
- [x] 原始失败始终位于复合错误首部，所有补偿与持久化错误均被汇总；未完成阶段是否已持久登记会明确返回。
- [x] 持久补偿队列按安装路径串行更新，并接入既有启动/退出清理入口；诊断证明 resource/registry 和 file queue 补偿失败均可在后续重试中清空。
- [x] 将队列持久化与事务结算拆为两个明确所有者，分别为 114/243 行；单项会话运行时为 260 行，未触碰三大巨型编排文件。
- [x] A3-A7 全部反转为 `CORRECTNESS_LOCK` 并纳入 `diagnostics:all`；当前 A1-A7 为 7 个正确性锁，仅 A8 保留为 AT-1.4 已知缺陷。

硬门禁：A3-A7 全部成为正确性门禁；每个故障点结束后都不存在无记录的孤儿 resource、registry 或文件。

提交：`fix: 为单项字体激活加入逆序补偿`

### AT-1.4 批量激活复用单项事务

状态：待启动。

预计范围：

- `src/main/activation/runtime/fontActivationBatchRuntime.ts`
- 单项事务的窄内部接口与批量结果类型
- 同一事务诊断中的 A8 和完整 Stage 1 正确性模式
- 两级任务书与 README

执行要求：

1. 提取可供单项和批量共同调用的一次性事务函数；状态所有权保持单一。
2. 批量层只负责去重、并发/串行策略、取消、汇总和最终耐久性等待。
3. 每项开始前检查取消信号；已提交项保留成功，未开始项标记取消。
4. 单项失败不污染其他项，结果中保留稳定 ID 和可重试原因。
5. 保存队列和后台删除队列在 API 返回或关闭前满足既有耐久性门禁。
6. 删除 Stage 0 的 `--baseline-observe` 事务语义，A1-A8 统一作为长期正确性诊断运行。

硬门禁：提前取消、处理中取消、混合失败和重试均无假成功；A1-A8 全部进入 `diagnostics:all`。

提交：`refactor: 统一批量与单项字体激活事务`

## 4. 每个 Atomic Task 的验证顺序

1. 先运行本任务对应的定向诊断，确认旧实现能失败或已由 Stage 0 观察证明。
2. 实现最小生产修复，重新运行定向诊断。
3. 运行 `npm run typecheck`。
4. 运行 `npm run diagnostics:all`，其中必须包含已完成任务的长期正确性门禁和编排契约门禁。
5. 运行 Electron/Vite 三端 build；若当前任务不涉及 Rust 源码，可记录 Rust build 为沿用 Stage 0 外部验收项。
6. 检查 `git diff --check`、受跟踪私钥/生成物和无关改动。
7. 更新本文档、总任务书及 README 后，一个 Atomic Task 只生成一个提交。
8. 推送到 `stage/01-activation-transactions`；不直接合并 `main`。

## 5. Windows 实机验收矩阵

自动替身不能替代以下 Windows 10/11 x64 验收：

- Rust worker 可用时分别注入 add/remove 逐项失败，确认 UI 报错且没有 native 重复调用。
- Rust worker 不可用时确认 native helper 正常接管；两者均不可用时操作明确失败。
- 单项停用失败后字体仍可被应用识别，持久记录仍存在，重试可成功。
- 混合批量停用只清除成功项，失败项重启后仍可恢复和重试。
- 在复制、注册表、resource、状态保存各点故障后检查用户字体目录、HKCU Fonts 和会话状态。
- Photoshop 已打开时执行激活、重新激活和停用，验证 WM_FONTCHANGE 行为与引用计数无回归。

当前非 Windows 审查环境只能证明 TypeScript/替身事务语义和 Electron/Vite 构建，不得表述为 Windows 系统集成已通过。

## 6. 巨型编排文件再审计门禁

Stage 1 不移动三大编排文件，但每个 Atomic Task 必须运行 `diagnostics:orchestration-contracts` 并检查：

- `src/main/index.ts` 是否新增领域判断、事务分支或匿名生命周期所有者。
- `rustCoreWorkerRuntime.ts` 是否因修复新增业务层 payload 泄漏、重复 fallback 或新的公开命令门面。
- `App.tsx` / `AppRootView.tsx` 是否新增平铺状态、`any` 或跨领域 prop。

发现新增耦合时必须在当前任务内收回到对应领域模块；发现既有拆分机会只记录到 Stage 4/5/6，不在行为修复提交中机械搬迁。

## 7. Stage 1 退出条件

- [ ] AT-1.1 至 AT-1.4 均有独立提交和执行记录。
- [ ] A1-A8 全部由正确性断言覆盖并纳入 `diagnostics:all`。
- [ ] 单项/批量激活与停用没有已知假成功或无记录孤儿资产。
- [ ] `npm run verify`、Electron/Vite build 和编排契约门禁通过。
- [ ] Windows 实机矩阵完成，或以明确外部验收阻塞项记录且未伪报通过。
- [ ] 工作树不含私钥、字体资产、输出目录、Rust `target/` 或无关改动。
- [ ] Stage 1 分支已推送，`main` 未被直接修改。

## 8. 执行记录

| 日期 | Atomic Task | 提交 | 自动验证 | Windows 实机 | 结论/阻塞 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-02 | AT-1.1 | 本提交 | A1 定向门禁通过；`npm run verify` 通过，65/65 长期诊断；Electron/Vite main、preload、renderer build 通过；剩余观察为 6 个 `KNOWN_DEFECT`、2 个正确/行为锁 | 当前执行环境非 Windows；Cargo 不可用，未重复构建未改动的 Rust worker | 已完成；失败时 registry/file cleanup、会话状态与安装状态均未推进 |
| 2026-09-02 | AT-1.2 | 本提交 | A2 混合批次及 resource 缺失、registry 失败、file queue 失败定向门禁通过；`npm run verify` 通过，66/66 长期诊断；Electron/Vite main、preload、renderer build 通过；三大编排公开契约未变 | 当前执行环境非 Windows；Cargo 不可用，未重复构建未改动的 Rust worker | 已完成；每条记录只有 resource、registry、持久文件队列均成功后才删除会话状态，失败项可重试 |
| 2026-09-02 | AT-1.3 | 本提交 | A3-A7 复制、注册表、resource、状态保存和补偿失败门禁通过；`npm run verify` 通过，67/67 长期诊断；Electron/Vite main、preload、renderer build 通过；三大编排公开契约未变 | 当前执行环境非 Windows；Cargo 不可用，未重复构建未改动的 Rust worker | 已完成；适用副作用按 resource -> registry -> file 逆序补偿，失败阶段持久登记并由启动/退出清理重试 |
