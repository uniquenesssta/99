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
- Node.js 22 或兼容版本
- Rust 与 Cargo（构建 `hfm-core-worker` 时需要）
- Windows 原生组件对应的 C/C++ 构建工具链

```bash
npm ci
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

- [修复与编排重构总任务书](docs/plans/HFM_REMEDIATION_MASTER_TASKBOOK.md)
- [当前 Stage 2：字体路径授权任务书](docs/plans/HFM_STAGE_02_PATH_AUTHORIZATION_TASKBOOK.md)
- [已完成 Stage 1：激活与停用事务任务书](docs/plans/HFM_STAGE_01_ACTIVATION_TASKBOOK.md)
- [已完成 Stage 0：基线与行为锁任务书](docs/plans/HFM_STAGE_00_BASELINE_TASKBOOK.md)

任务书按 Atomic Task 执行：先建立行为锁，再依次修复事务正确性、路径边界和文件一致性，之后才拆分主进程组合根、Rust Worker 门面与 React 根组件。任何阶段硬门禁失败都阻塞后续阶段。

## 安全说明

仓库只应保存公钥。私钥、许可证、构建输出、日志和本地缓存均由 `.gitignore` 排除。任何曾提交到 Git 的私钥都必须立即停用并轮换；从当前分支删除文件不会清除旧提交中的内容。

## 变更记录

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
