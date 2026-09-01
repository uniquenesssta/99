# HFM Stage 0：基线与行为锁任务书

## 1. 阶段信息

- 上级任务书：[`HFM_REMEDIATION_MASTER_TASKBOOK.md`](HFM_REMEDIATION_MASTER_TASKBOOK.md)
- 基线提交：`9d9be77b4761a3c1e169ffe15fbda059b556064f`
- 阶段状态：进行中（AT-0.1 已完成）
- 阶段分支：`stage/00-baseline-behavior-locks`
- 目标：建立能稳定复现已确认问题的行为门禁，并固定三大编排文件拆分前的公开契约。
- 本阶段禁止：修复生产逻辑、搬迁模块、升级依赖、改数据库/IPC/Rust 协议。

## 2. 进入条件

- `main` 与 `origin/main` 对齐，工作区没有未说明改动。
- 已阅读根目录 `AGENTS.md`、`ALL_AI_CODE.md`、`AI_PROJECT_RULES.md` 和总任务书。
- `npm ci` 可使用公共 npm registry 完成。
- Windows 特有验证如果当前环境不可用，必须分成“自动替身已验证”和“Windows 实机待验证”，不得混写。

## 3. 基线产物

Stage 0 结束时必须新增或更新：

1. 行为诊断脚本：激活事务、路径边界、编排公开契约。
2. 可直接执行的基线观察脚本；修复任务将其转换成 `package.json` 中的长期诊断后才纳入 `diagnostics:all`。现有 `run-all.cjs` 会自动执行所有 `diagnostics:*` script，因此基线观察阶段不能提前注册该前缀。
3. 本文档的实际执行记录、环境版本与结果。
4. 总任务书 Stage 0 状态和 README 变更记录。

诊断脚本沿用现有 `build/diagnostics/check-*.cjs` 体系；若需测试夹具，放入 `build/diagnostics/fixtures/`，不得向真实注册表、系统字体目录或用户字体库写入数据。

## 4. Atomic Task 清单

### AT-0.1 环境、仓库与风险基线

允许修改：本文档、总任务书、README。不得修改源码或锁文件。

执行：

- [x] 记录 `git status --short --branch`、HEAD、远端 HEAD。
- [x] 记录 `node --version`、`npm --version`、`rustc --version`、`cargo --version`。
- [x] Windows 执行机记录 OS build、PowerShell、MSVC/Windows SDK 版本；当前 Linux 环境明确记为待补。
- [x] 执行干净 `npm ci` 并确认锁文件未改变；Electron 二进制 postinstall 因当前容器下载阻塞而人工终止，不能记为完整成功。
- [x] 执行 `npm run typecheck` 与 `npm run diagnostics:all`，记录实际通过项数量。
- [x] 执行 Electron/Vite build；当前无 Cargo，Rust build 与完整 `npm run build` 待补。
- [x] 分别保存 `npm audit` 与 `npm audit --omit=dev` 的摘要。
- [x] 确认仓库当前版本无私钥标记、`out/`、Rust `target/` 和受跟踪 `hfm-core-worker.exe`。

通过标准：每个命令都有日期、环境和真实结果；缺失工具写作环境阻塞，不伪造通过。

提交建议：`docs: 固化修复前环境与验证基线`

### AT-0.2 激活/停用事务行为诊断

允许修改：

- `build/diagnostics/check-font-activation-transaction.cjs`
- 必要的纯测试夹具
- 两级任务书与 README

禁止修改：`src/main/activation/**`、`src/main/windows/**` 生产逻辑。

用例矩阵：

| 用例 | 故障注入 | 旧实现预期暴露 | 修复后的正确结果 |
| --- | --- | --- | --- |
| A1 | 资源 remove 条目 `ok: false` | 单项停用可能返回成功 | 返回失败，保留会话状态 |
| A2 | 批量 remove 一成一败 | `failed` 仍为 0 | 汇总 1/1，失败项状态保留 |
| A3 | 激活 copy 失败 | 可能遗留前置状态 | 无注册表、资源、提交状态 |
| A4 | 注册表写失败 | 临时文件可能成为孤儿 | 删除临时文件或进入清理队列 |
| A5 | 资源 add 失败 | 注册表/临时文件可能遗留 | 逆序删除注册表和临时文件 |
| A6 | 状态保存失败 | 系统已激活但无持久记录 | 逆序补偿；补偿失败有持久记录 |
| A7 | 补偿删除失败 | 错误可能被吞 | 复合错误 + 删除队列 |
| A8 | 批量取消 | 已提交与未提交项边界不清 | 逐项状态可重试且无假成功 |

实现要求：

- [ ] 测试替身记录调用顺序、参数与结果，不接触真实系统。
- [ ] 断言最终文件/注册表/resource/session/delete-queue 状态，而非仅匹配日志。
- [ ] 基线观察命令退出成功的含义只能是“精确复现了已知缺陷”，并输出 `KNOWN_DEFECT` 与命中的用例；不能把它表述为生产行为正确。
- [ ] 基线观察命令暂不进入 `diagnostics:all`，因此主分支全量门禁保持绿色。
- [ ] Stage 1 的对应修复任务必须移除基线观察语义，改为断言正确结果，并把同一诊断纳入 `diagnostics:all`。

通过标准：A1-A8 均可独立复现，失败消息指向具体事务步骤。

提交建议：`test: 锁定字体激活事务失败语义`

### AT-0.3 字体读取与破坏性路径边界诊断

允许修改：

- `build/diagnostics/check-font-path-authorization.cjs`
- 必要的临时目录夹具
- 两级任务书与 README

禁止修改：协议、IPC、path policy 和 physical folder 生产逻辑。

用例矩阵：

| 维度 | 合法用例 | 必须拒绝 |
| --- | --- | --- |
| 文件类型 | `.ttf/.otf/.ttc/.otc` 普通文件 | `.txt/.db/.pem/.woff/.woff2`、目录、设备路径 |
| 路径边界 | watched root、Windows Fonts、应用托管/临时字体目录 | 相似前缀目录、`..` 越界、未授权盘符/UNC share |
| 真实路径 | 根内普通文件 | 根内 symlink/junction 指向根外 |
| 编码 | 合法空格、Unicode、协议编码 | 双重编码、NUL/控制字符、畸形 URL |
| 破坏性操作 | 已索引字体 -> 授权目标目录 | 非字体源、根外目标、renderer 自报授权根 |
| 托管卸载 | 应用目录 + 受管命名 + 对应注册表身份 | 仅 basename 前缀命中、同名系统字体 |

实现要求：

- [ ] 读取授权与写/删授权分别断言，不共用“能读即能删”。
- [ ] 测试 Windows 大小写、UNC 和分隔符语义；非 Windows 环境只跑可移植子集并明确标记。
- [ ] 协议测试覆盖 `hfm-font://` 与 `readPreviewFontData` 的一致性。
- [ ] 失败用例验证没有发生 read/copy/unlink/registry 调用。

通过标准：至少一个现有越界读取在旧实现上被基线观察命令命中；命令暂不进入 `diagnostics:all`。Stage 2 修复时将其转换为长期门禁，要求全部非法用例稳定拒绝。

提交建议：`test: 锁定字体路径授权边界`

### AT-0.4 三大编排文件契约快照

允许修改：

- `build/diagnostics/check-orchestration-contracts.cjs`
- `build/diagnostics/run-all.cjs`
- `package.json`
- 两级任务书与 README

禁止修改：`src/main/index.ts`、`rustCoreWorkerRuntime.ts`、`App.tsx`、`AppRootView.tsx`。

需要锁定：

- [ ] `index.ts` 注册给主进程的 capability 键集合及 lifecycle hook 必需项。
- [ ] Rust facade 的公开方法集合、Input/Result TypeScript 可赋值性。
- [ ] Rust 命令的 capability 名、CLI 参数、不可用返回 `null` 与已提交失败抛错边界。
- [ ] `AppRootView` 的目标分组契约：`topbar/sidebar/content/detail/overlays/developer`。
- [ ] UI 关键流程清单：搜索、筛选、滚动、选择、详情、标签、文件夹、批量系统操作、冲突提示、关闭 flush。

快照质量要求：

- 使用结构化键集合、类型检查和受控调用验证。
- 不匹配源文件行号、空白、import 顺序或大段源文本。
- 不把当前 `props: any` 当作合法契约；先定义目标类型测试，再由 Stage 6 使其通过。

通过标准：移动实现但保持契约时测试应通过；删除/改名能力、改变错误边界或漏掉 lifecycle hook 时必须失败。

提交建议：`test: 固化主进程与界面编排契约`

## 5. Stage 0 总门禁

全部 Atomic Task 完成后执行：

```bash
npm run typecheck
node build/diagnostics/check-font-activation-transaction.cjs --baseline-observe
node build/diagnostics/check-font-path-authorization.cjs --baseline-observe
npm run diagnostics:orchestration-contracts
npm run diagnostics:all
```

有完整 Windows 工具链时再执行：

```bash
npm run rust:build
npm run build
```

注意：当前 `npm run build` 自带 `npm run verify` 与 required Rust build。若环境无 Cargo，记录为环境阻塞；可以单独验证 Electron/Vite build，但不得把它描述成完整 build 成功。

## 6. Stage 0 退出条件

- [ ] AT-0.1 至 AT-0.4 均有独立提交和记录。
- [ ] F-01 至 F-07 都有修复前行为锁或明确的 Windows 待补验证项。
- [ ] 三大编排文件的公开边界已有结构化门禁。
- [ ] `npm run verify` 完整通过；基线观察命令不属于全量门禁，不能让主分支保持失败状态。
- [ ] 总任务书 Stage 0 标为完成，Stage 1 解锁。
- [ ] 工作区无生成物、私钥、字体资产和无关改动。

## 7. 执行记录

| 日期 | Atomic Task | 提交 | 自动验证 | Windows 实机 | 结论/阻塞 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-01 | AT-0.1 | 本提交 | typecheck 通过；63 项诊断通过；Electron/Vite 三端 build 通过 | 当前执行环境非 Windows；Rust/Cargo、PowerShell、MSVC/SDK 均不可用 | 自动基线已记录；`npm ci` 卡在 Electron 35.7.5 binary postinstall 后终止，lock hash 未变 |

## 8. AT-0.1 基线详情

### 仓库与环境

- Stage 分支：`stage/00-baseline-behavior-locks`
- HEAD 与阶段起点：`9d9be77b4761a3c1e169ffe15fbda059b556064f`
- 起点时 `origin/main`：`9d9be77b4761a3c1e169ffe15fbda059b556064f`
- `package-lock.json` SHA-256：`44eba34d7229f2629fbfdd25398014dcc752994f082ab7ab48ac967faaced58f`
- Node.js：`v24.19.0`
- npm：`11.9.0`
- OS：Linux x86_64，kernel `6.18.35`
- Rust/Cargo：未安装。
- Windows/PowerShell/MSVC/Windows SDK：当前环境不可用，必须在 Stage 0 收口前由 Windows 执行机补充，或明确保留为外部验收阻塞。

### 验证结果

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| `npm ci` | 环境阻塞 | registry 包已下载，better-sqlite3 安装成功；停在 Electron 35.7.5 binary postinstall，人工终止；锁文件未变化 |
| `npm run typecheck` | 通过 | TypeScript strict 检查通过 |
| `npm run diagnostics:all` | 通过 | 63/63 |
| Electron/Vite build | 通过 | main 326 modules、preload 1 module、renderer 181 modules |
| `npm run rust:build` | 未执行 | 当前环境没有 Cargo |
| 完整 `npm run build` | 未执行 | required Rust build 必然受 Cargo 缺失阻塞，不能描述为完整 build 通过 |
| `npm audit` | 风险已记录 | 19 high、1 critical，共 20；位于含开发/构建依赖的完整树 |
| `npm audit --omit=dev` | 通过 | 生产依赖 0 vulnerability |

### 架构与安全快照

- `src/main/index.ts`：2036 行。
- `src/main/rust-core/rustCoreWorkerRuntime.ts`：2994 行；89 个导出 type、43 个 `runRust*` 内部函数、38 个公开 `runRust*` 方法。
- `src/renderer/src/App.tsx`：1397 行。
- `src/renderer/src/components/app/AppRootView.tsx`：386 行，169 个平铺解构属性，入口参数为 `any`。
- 当前受跟踪文件中未发现 private key PEM 标记。
- 当前受跟踪文件中未发现 `out/`、Rust `target/` 或 `build/native/hfm-core-worker(.exe)`。
