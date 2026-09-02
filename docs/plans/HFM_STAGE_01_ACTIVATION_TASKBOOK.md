# HanFontManager Stage 1：激活与停用事务任务书

## 0. 文档状态

- 文档版本：1.0
- 建立日期：2026-09-01
- Stage 分支：`stage/01-activation-transactions`
- 起始提交：`d35ba6f89b7966427a8a671ff0016bff3d7f5d9c`
- 当前 Atomic Task：AT-1.1 已完成；AT-1.2 待启动
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

状态：阻塞于 AT-1.1。

预计范围：

- `src/main/activation/runtime/fontDeactivationBatchRuntime.ts`
- 必要的窄结果类型
- 同一事务诊断中的 A2
- 两级任务书与 README

执行顺序：

1. 建立 `installPath -> resource result` 的逐项映射，缺失条目按失败处理。
2. 对每条临时激活记录分别记录 resource、registry、file queue 三阶段结果。
3. 资源移除失败时保留注册表、文件和持久会话记录，不报告停用成功。
4. 资源已移除但后续清理失败时，保留足以重试的持久信息并写入清理队列。
5. 由逐项结果计算 `deactivated`、`failed` 和用户消息，禁止固定失败数或整批吞错。
6. A2 反转为混合批次正确性门禁并加入长期诊断。

硬门禁：一成一败的批次只能提交成功项；失败项仍在会话状态中，且不会进入错误的文件删除路径。

提交：`fix: 按项结算批量字体停用`

### AT-1.3 单项激活逆序补偿

状态：阻塞于 AT-1.2。

预计范围：

- `src/main/activation/runtime/fontActivationSessionRuntime.ts`
- 既有 copy、cleanup、delete queue 运行时及必要窄类型
- 同一事务诊断中的 A3-A7
- 两级任务书与 README

事务步骤：

1. 校验源文件并复制到当前用户字体目录。
2. 写入 HKCU Fonts 注册表值。
3. 添加字体资源并触发必要通知。
4. 最后保存临时激活状态与安装状态。

失败补偿：

- resource 已添加：先移除 resource。
- registry 已写：再删除 registry value。
- 文件已复制：最后删除或进入持久删除队列。
- 状态保存失败同样执行全部适用补偿。
- 原始错误与所有补偿错误合并返回；不能用补偿错误覆盖根因，也不能吞掉补偿失败。

硬门禁：A3-A7 全部成为正确性门禁；每个故障点结束后都不存在无记录的孤儿 resource、registry 或文件。

提交：`fix: 为单项字体激活加入逆序补偿`

### AT-1.4 批量激活复用单项事务

状态：阻塞于 AT-1.3。

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
