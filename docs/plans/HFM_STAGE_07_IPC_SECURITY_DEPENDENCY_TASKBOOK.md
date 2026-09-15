# HanFontManager Stage 7：IPC 收口与依赖治理任务书

## 0. 状态与边界

- 版本：1.0；日期：2026-09-15；软件：HanFontManager 3.0.0。
- 分支：`stage/07-ipc-security-dependencies`。
- 不可变进入基线：Stage 6 完成提交 `e773deba2a7b1d96ec9ac878a71154bd04bab567`。
- 进入依据：用户提供 AT-6.5 Windows Cargo 1.97.1 release、Electron/Vite 354/1/190 模块和混淆 3/3 的成功回执，并明确要求开始 7.1。
- 当前状态：AT-7.1 实现和本环境自动验证完成，Windows 完整构建待 pull 后复验；AT-7.2 尚未开始。
- 上级顺序、停止条件与最终发布门禁以[总任务书](HFM_REMEDIATION_MASTER_TASKBOOK.md)为准。

AT-7.1 只收紧既有信任边界，不修改 IPC channel、preload API、数据库、用户数据、CSS、Rust/C/C++ 协议或依赖版本。AT-7.2 的依赖升级保持为独立 Atomic Task，不与本次安全逻辑混交。

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

## 8. 下一 Atomic Task：AT-7.2

AT-7.2 单独制定并执行 Electron、electron-builder、electron-vite、Vite 等兼容升级矩阵。开始时必须查询当日官方兼容信息与安全公告，逐个兼容组升级，记录直接/传递漏洞、生产/构建暴露面、回退版本和 Windows 打包结果；禁止 `npm audit fix --force`。本项提交和 Windows 构建通过后再进入 7.2。
