# HanFontManager Stage 7：IPC 收口与依赖治理任务书

## 0. 状态与边界

- 版本：1.1；日期：2026-09-15；软件：HanFontManager 3.0.0。
- 分支：`stage/07-ipc-security-dependencies`。
- 不可变进入基线：Stage 6 完成提交 `e773deba2a7b1d96ec9ac878a71154bd04bab567`。
- 进入依据：用户提供 AT-6.5 Windows Cargo 1.97.1 release、Electron/Vite 354/1/190 模块和混淆 3/3 的成功回执，并明确要求开始 7.1；随后又提供 AT-7.1 同样完整的 Windows 成功回执并要求推进 7.2。
- 当前状态：AT-7.1 实现、自动验证与 Windows 完整构建均通过；AT-7.2 依赖升级、锁图清理和本环境自动验证完成，Windows 原生重建、安装包与启动/卸载烟测待 pull 后完成。
- 上级顺序、停止条件与最终发布门禁以[总任务书](HFM_REMEDIATION_MASTER_TASKBOOK.md)为准。

AT-7.1 只收紧既有信任边界，不修改 IPC channel、preload API、数据库、用户数据、CSS、Rust/C/C++ 协议或依赖版本。AT-7.2 是独立 Atomic Task，只调整开发/打包工具链、对应配置与诊断；四项生产依赖及其声明版本保持不变，也不迁移用户数据或协议。

## 1. AT-7.1 审计结论

主进程源码只有两种 Electron IPC 注册边界：

| 注册边界 | 审计结果 | 本项处理 |
| --- | --- | --- |
| `registerTracedIpcHandler` | 原 115 项业务能力最终经过唯一动态 `ipcMain.handle`，中央断言已是回调首句 | 保持实现并纳入全目录注册扫描 |
| `windowRuntime.ts` | 5 个窗口 channel 直接调用 `ipcMain.handle`，原先绕过来源校验 | 每个回调首句调用同一 `assertTrustedIpcSender` |

五个已收口窗口 channel 为 `app-window:minimize`、`app-window:toggleMaximize`、`app-window:close`、`app-window:flushComplete`、`app-window:rendererReady`。诊断递归扫描 `src/main/**/*.ts` 的 `ipcMain.handle/handleOnce/on/once`；出现新的直接注册、漏掉首句校验或改变现有拓扑都会失败。

旧 `appSecurityRuntime.ts` 与 `ipcSenderValidation.ts` 各自维护一套 `startsWith` 前缀规则。打包页面的 `index.html.evil`、开发服务器子路径或相似主机可能落入过宽边界，且导航与 IPC 规则会独立漂移。现在由 `appSecurityRuntime.ts` 唯一导出 renderer 文档身份策略，IPC 与导航共同消费。

## 2. 精确 renderer 文档身份

候选 URL 先通过 WHATWG `URL` 解析，解析失败直接拒绝。每个候选必须逐项满足：

| 字段 | 策略 |
| --- | --- |
| protocol | 精确相等，拒绝 http/https/file 替换 |
| origin 与 host | 精确相等，包含主机与有效端口；拒绝相似域名和错端口 |
| username/password | 精确相等，避免凭据变体复用同一 origin |
| pathname | 精确文档路径；Windows `file:` 路径仅做大小写兼容，不允许目录或文件名前缀 |
| search | 精确相等，不允许未声明 query 改变入口语义 |
| hash | 不参与文档身份，保留 React 同文档客户端路由兼容 |

打包态只信任 `app.getAppPath()/out/renderer/index.html`。开发态兼容固定的 `127.0.0.1:39217/`、`localhost:39217/`、electron-vite 实际配置入口和 `cwd/out/renderer/index.html`；每个入口仍必须是完整精确文档，不能扩成子路径。`HFM_FORCE_DIST=1` 时不会把环境中的非默认开发服务器加入可信集合。

## 3. 导航与窗口策略

- `setWindowOpenHandler` 继续无条件返回 deny，并记录目标 URL。
- `will-navigate` 现在在开发态与打包态都安装；只有中央 renderer 身份策略认可的同一文档可以继续，其余 URL 记录后 `preventDefault()`。
- 打包态的 DevTools/reload 快捷键拦截保持原行为；开发态快捷键行为不变。
- IPC 拒绝继续记录 channel、sender id 和 URL，再抛出固定错误；窗口动作、关闭确认或 ready 标记均不会先发生。

## 4. 长期门禁

新增 `diagnostics:ipc-sender-validation` 并纳入 `diagnostics:all`：

- 真实执行开发、配置开发服务器、强制 dist 与打包四种 URL 策略；覆盖合法 hash，以及子路径、query、错端口、错协议、相似主机、相邻目录、文件名后缀和畸形 URL。
- 真实执行 senderFrame 和顶层 sender URL fallback；有明确不可信 senderFrame 时不能被可信顶层 URL 覆盖。
- 真实执行开发/打包导航守卫和新窗口拒绝，并确认打包快捷键守卫仍注册。
- AST 扫描全部主进程 IPC 注册；固定 5 个窗口 channel 与一个业务动态边界，并要求来源断言是副作用前第一句。
- 四个退化反例分别把路径精确比较改回前缀、移除 origin/host、移除导航 `preventDefault`、移除一个窗口断言；门禁均必须失败。
- LF 与 CRLF 源码重放都必须通过。

既有字体读取授权诊断的轻量 `windowRuntime` loader 增加中央断言 mock；测试语义与产品断言均未放宽。

## 5. 自动验证结果

- `npm run verify`：退出码 0；TypeScript 与 **90/90** 长期诊断通过。
- `npm run diagnostics:ipc-sender-validation`：精确开发/打包身份、IPC fallback、5 个窗口 channel、导航/新窗口、四项变异与 CRLF 全部通过。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- Electron/Vite main、preload、renderer：**354/1/190** 个模块；main **1149.56 kB**、preload **9.04 kB**、renderer JS **400.08 kB**、CSS **106.02 kB**；混淆 **3/3** 通过。
- main 相对 Stage 6 增加约 **0.69 kB**，来自解析式 URL 策略和窗口 IPC 断言；preload 与 renderer 产物未漂移。
- required Rust 构建已实际尝试，当前审查环境没有 Cargo。AT-7.1 未改 Rust/原生源码，不把分步 Electron 构建描述为完整 Windows build。
- 用户随后在 Windows 完成 AT-7.1 `npm run build`：Cargo 1.97.1 release、worker 复制、公钥同步、354/1/190 三端模块和混淆 3/3 全部成功；该回执关闭 AT-7.1 的 Windows 构建项并成为 AT-7.2 进入依据。

本项没有使用新依赖或版本敏感 API；URL 解析、Electron 导航事件和窗口打开策略都沿用仓库现有 API，因此不需要为 AT-7.1 引入依赖查询或升级。Mermaid Chart 已记录中央 renderer 身份向业务 IPC、窗口 IPC 与导航守卫分发的实际边界。

## 6. Windows 拉取与验收

```bat
git status --short
git fetch origin
git switch stage/07-ipc-security-dependencies
git pull --ff-only origin stage/07-ipc-security-dependencies
npm run build
```

无需数据迁移、重新配置字体库或手工清缓存。若本地修改阻止切换，先保留并处理实际冲突，不执行 hard reset/clean。

构建后至少确认：窗口最小化、最大化/还原、关闭 flush、首次显示正常；字体搜索、预览、标签与安装操作仍可调用；外部链接和 `window.open` 不产生新窗口；把主窗口导航到不同路径/主机时被拒绝。开发模式可另跑 `npm run dev`，确认默认 39217 入口和 DevTools 快捷键仍工作。

Windows 回执应包含 diagnostics 总数、Cargo release/worker 复制、公钥同步、main/preload/renderer 模块数和混淆结果。GUI 观察与构建日志分开记录。

## 7. 回滚与兼容

AT-7.1 的回滚单位是单独提交。回滚不会迁移或删除用户数据，但会重新暴露窗口 IPC 绕过中央校验和 URL 前缀信任问题，因此只用于定位，并须保持应用离线/受控。IPC 名称、参数、返回值和 preload API 均未改变，正常 renderer 无需兼容分支。

如果 Windows 发现合法入口被拒绝，应先记录日志中的精确 URL，再为真实入口建立明确、可测试的完整文档身份；不得恢复 `startsWith` 或把整个目录、origin 当作通配信任。

## 8. AT-7.2 进入与基线审计

AT-7.2 已按独立提交实施。开始前先在不可变基线 `0810137091933a88c03be15cd38dee11bf6a593d` 上复跑完整审计，确认旧锁图为 1 critical、21 high、1 moderate，共 23 个易受攻击包；生产依赖审计仍为 0。升级过程中未使用 `npm audit fix --force`，也没有增加、删除或替换生产依赖。

## 9. AT-7.2 官方兼容决策矩阵

2026-09-15 查询并以官方资料为决策依据：Electron [版本支持策略](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)与[破坏性变更](https://www.electronjs.org/docs/latest/breaking-changes)、electron-vite [v4 到 v5 迁移说明](https://electron-vite.org/guide/migration)与[Vite 兼容要求](https://electron-vite.org/guide/)、Vite [v7 迁移说明](https://v7.vite.dev/guide/migration)、electron-builder [Windows 配置](https://www.electron.build/win/)。锁定的是经本项目验证的兼容组，不把“latest”写成长期契约。

| 组件/组 | 基线 | AT-7.2 | 决策与暴露面 | 单项回退 |
| --- | --- | --- | --- | --- |
| Node engine | 未声明；开发机 Node 22 | `>=22.12.0` | electron-vite 5 与 Vite 7 的共同最低线；本环境 Node 24.19.0 通过 | 删除 engine 并还原整个 AT-7.2 提交 |
| Electron | 35.7.5 | 42.11.3 | 42/43/44 是当日三个受支持稳定大版本；选择最老受支持的 42.11.3，取得安全维护同时避开 43 的 dialog 默认目录变化与 44 的 Windows ia32/clipboard 变化。Electron 是产品运行框架；审计命中的 `extract-zip` 位于安装链 | 35.7.5，仅限受控定位；会恢复已知风险 |
| electron-builder | 25.1.8 | 26.15.3 | 清除 builder/rebuild/tar 等构建链风险；26 仍为 CommonJS 兼容线，未跨入 v27 的 ESM 迁移。只在构建、原生重建和制包时暴露 | 25.1.8 |
| electron-vite + Vite | 3.1.0 + 6.4.3 | 5.0.0 + 7.3.6 | v5 官方 peer 覆盖 Vite 5/6/7；Vite 8 不在该 peer 范围，因此没有追逐最新大版本。只在开发/构建阶段暴露 | 3.1.0 + 6.4.3 |
| `@types/node` | 22.10.2 | 24.13.4 | 对齐 Electron 42 内置 Node 24 类型；仅编译期 | 22.10.2 |
| React Vite plugin | 4.7.0 | 保持 4.7.0 | 已声明 Vite 7 peer，无升级收益 | 不适用 |
| TypeScript | 5.9.3 | 保持 5.9.3 | 当前编译契约全通过，无跨大版本理由 | 不适用 |

`better-sqlite3`、`fontkit`、`react`、`react-dom` 四项生产依赖的名称、声明和锁定版本全部保持；无需新增许可证评估、数据库迁移或运行时兼容分支。

## 10. 漏洞收敛与锁图

升级按 Electron、electron-builder、electron-vite/Vite 三个兼容组逐次执行。electron-builder 组落地后，完整审计从 23 降至 4；最后只对满足新范围但被旧 lock 保留的 `postcss` 与 `browserslist` 执行普通定向 lock 更新，最终完整与生产审计均为 0。

| 基线风险族 | 代表性公告 | 暴露面 | AT-7.2 结果 |
| --- | --- | --- | --- |
| Electron 安装解压 | `GHSA-jmr9-qjv8-65gv`、`GHSA-7pqw-9j4j-h8q3` | Electron 安装/获取；框架最终进入产品 | 改用 `@electron-internal/extract-zip`，旧 `extract-zip` 从锁图消失 |
| builder 与 updater/AppImage | `GHSA-7g7r-gx96-252g` | 构建/发布；本项目当前 Windows NSIS，不运行 AppImage | app-builder-lib 26.15.3，已越过公告修复线 |
| tar 与重建链 | `GHSA-23hp-3jrh-7fpw` 及路径穿越/DoS 系列 | 原生依赖下载、解包、构建 | tar 7.5.22，`@electron/rebuild` 4.2.0；门禁固定安全下限 |
| CSS/浏览器目标链 | `GHSA-r28c-9q8g-f849`、`GHSA-c83g-rgw3-j3cx`、`GHSA-73wf-gq98-2v4g` | Vite 构建期 | postcss 8.5.28、browserslist 4.29.0、baseline-browser-mapping 2.11.23 |
| 构建辅助链 | `GHSA-2v37-7h3g-55p8`、`GHSA-52cp-r559-cp3m`、`GHSA-hmw2-7cc7-3qxx` 等 | 构建/打包输入处理 | nanoid 3.3.19、js-yaml 4.3.2、form-data 4.0.6，并为相关包设置可执行安全下限 |

“0 vulnerabilities”只表示 2026-09-15 npm advisory 数据库对当前锁图没有已知命中，不等于永久安全证明。新门禁因此同时固定直接兼容组、关键传递依赖下限、`brace-expansion` 分支安全范围及禁止强制审计修复。

## 11. 配置迁移与长期门禁

- electron-vite 5 默认外部化依赖，删除已弃用的 `externalizeDepsPlugin()`，main/preload 的既有行为保持。
- electron-builder 26 把签名发布者配置读取点收进 `win.signtoolOptions.publisherName`；旧 v25 顶层 `win.publisherName` 会被 v26 schema 拒绝，现已最小迁移。
- `diagnostics:dependency-security-matrix` 已纳入 `diagnostics:all`，检查 Node engine、七项直接工具版本、四项生产依赖集合、Electron 安全解压器、Vite peer、关键锁图下限、builder v26 配置和禁止 `audit fix --force`。
- 六个退化反例分别恢复旧 Electron、旧 builder runtime、旧 Vite、弃用 plugin、增加生产依赖、恢复 v25 publisherName 写法；LF 与 CRLF 均通过。

## 12. AT-7.2 自动验证结果

- `npm ci`：成功；安装 395 个包。仅显示五项传递包弃用提示，无 vulnerability；本项没有为消除提示而扩大依赖范围。
- `npm ls --depth=0`：Electron 42.11.3、electron-builder 26.15.3、electron-vite 5.0.0、Vite 7.3.6、`@types/node` 24.13.4，安装树无 missing/invalid。
- `npm audit --audit-level=high` 与 `npm audit --omit=dev --audit-level=high`：均为 **0 vulnerabilities**；基线完整审计为 **23 -> 0**。
- `npm run verify`：TypeScript 与 **91/91** 长期诊断通过。
- Vite 7/electron-vite 5 main、preload、renderer：**354/1/190** 个模块；main **1149.59 kB**、preload **9.04 kB**、renderer JS **399.91 kB**、CSS **106.02 kB**；混淆 **3/3** 通过。
- electron-builder 26 Windows 配置 schema 通过并进入 Electron 42 / x64 的 `better-sqlite3` 重建；Linux 随后按预期拒绝 Windows node-gyp 交叉编译。单独的当前平台 native rebuild 因受限网络准备阶段无进度而主动停止，没有作为成功证据。
- required Rust build 已实际尝试，但本环境没有 Cargo。Windows 原生 ABI、Rust worker、NSIS 安装包和实际启动/卸载必须由下节补验，不能用分步构建替代。

## 13. AT-7.2 Windows 拉取、打包与回滚

锁文件和 ABI 均已变化，必须使用干净依赖安装，不能沿用旧 `node_modules`：

```bat
git status --short
git fetch origin
git switch stage/07-ipc-security-dependencies
git pull --ff-only origin stage/07-ipc-security-dependencies
npm ci
npm run build
npm run build:win
```

验收记录至少包含：91/91 诊断、Cargo release/worker 复制、公钥同步、354/1/190 三端模块、混淆 3/3、electron-builder 26 / Electron 42、NSIS 产物路径。随后用未签名测试包完成安装、首次启动、字体库打开/搜索/预览、窗口关闭 flush、退出与卸载；不得用生产私钥做本阶段烟测。

AT-7.2 的回滚单位是整个独立提交，需同时恢复 `package.json`、`package-lock.json`、两份构建配置和诊断/文档，不能只降一个工具造成 peer/ABI 混配。回滚不改数据库或字体文件；但旧锁图重新带回 23 个已知审计命中，只允许离线受控定位。Windows 构建与安装烟测通过后，Stage 7 才可关闭并进入 Stage 8。
