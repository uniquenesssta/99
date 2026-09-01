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
- [当前 Stage 0：基线与行为锁任务书](docs/plans/HFM_STAGE_00_BASELINE_TASKBOOK.md)

任务书按 Atomic Task 执行：先建立行为锁，再依次修复事务正确性、路径边界和文件一致性，之后才拆分主进程组合根、Rust Worker 门面与 React 根组件。任何阶段硬门禁失败都阻塞后续阶段。

## 安全说明

仓库只应保存公钥。私钥、许可证、构建输出、日志和本地缓存均由 `.gitignore` 排除。任何曾提交到 Git 的私钥都必须立即停用并轮换；从当前分支删除文件不会清除旧提交中的内容。

## 变更记录

- 2026-09-01：建立 HFM 修复与编排重构总任务书及 Stage 0 当前任务书；完成三个巨型编排文件的二次职责审计，明确按状态所有权和领域边界拆分，不以行数或机械搬文件作为验收标准。本次仅更新文档，未修改运行时代码。
- 2026-09-01：删除误留的任务书、开发私钥、可重建输出与 Rust 构建缓存；完善忽略规则，并将锁文件中的内部制品地址改回公共 npm registry，使新环境可正常执行 `npm ci`。
- 本次验证：`npm ci`、TypeScript 类型检查、63 项诊断、Electron/Vite 构建及混淆通过。审查环境缺少 Cargo，未完成 Rust worker 与 Windows 安装包的全量重建。
