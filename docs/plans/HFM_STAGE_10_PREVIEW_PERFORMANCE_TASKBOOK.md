# Stage 10：预览性能与独立修复回移

## 0. 范围与基线

- 日期：2026-09-26；软件版本：3.0.0；文档版本：1.0。
- 唯一分支：`stage/10-preview-performance`，从 Stage 9 `7d220c3d041291d4480210303ceae5dc3731145e` 建立。
- 用户当前授权：建立 Stage 10，先带回 CIM 等独立修复。常驻 DirectWrite 试验停止推进，原分支保留；本分支保持原预览路径。
- 遵守根目录 AGENTS.md、ALL_AI_CODE.md、AI_PROJECT_RULES.md 和总任务书。无新依赖、无数据库迁移，不变更激活/收藏/标签行为。

## 1. S10-00：独立修复回移

从 DW 最终代码 `56227d0` 按文件差异回移，禁止整提交 cherry-pick 混入试验接线。

1. `pathCanonicalizer.ts` 与 Rust `mapped_drives.rs`/命令入口：使用本机 WNetGetConnectionW 查询，UTF-8 JSON 严格校验；1500ms、30 秒缓存、请求合并、5 秒失败冷却不变。未知/断开映射及缺失/旧 worker 拒绝身份确认，不静默冒充本地盘。原开发启动负责重编译 worker。
2. mapped-drive-unicode / shared-root-retention 诊断适配实际 worker 查询，保留 Unicode、别名、失败冷却与共享根状态断言。
3. operation-chain 诊断等待独立 stderr 诊断帧后再停止，并等真实 close，保留原内容断言；shared-action-admission 变异匹配统一路径分隔符并要求锚点；user-intent-consistency 模块缓存统一路径并检查别名实例相同。三项只改测试，不改 daemon/收藏/共享准入生产逻辑。
4. 既有 Windows/Linux 工作流增加 Stage 10 触发，真实映射查询前构建 Rust worker。

排除：DW helper、常驻服务、字体副本、图片键/缓存接线、试验启动入口、UI、preload、预览埋点、DW 专项和冻结摘要调整。CIM 源实现已在 DW Windows 综合门 `36244288794` 成功（36ms/27ms），但此历史结果不替代新分支验证。

## 2. 验证

- 当前本地：mapped-drive-unicode、shared-root-retention（18场景）、operation-chain（7变异）、shared-action-admission（40组）、user-intent-consistency（4变异）及 typecheck 全通过。
- 完整诊断与构建运行中；新分支 Windows/Linux CI 推送后执行，未得到结果不得记为通过。
- 开发运行：`npm run dev`；不需要 build:win。新分支不提供 dev:dw。

## 3. 后续预览研究（尚未实施）

按用户高频改字目标，先处理可见队列等待整批图片缓存的阻塞，再区分 FontFace 超时与真正格式失败，保留已加载字体跨文字/字号复用；随后研究单请求授权/元数据/读取重复调用。不得绕过路径授权、根代次、离线或取消边界，不以无限并发或增大期限替代修复。

分别测量首次一屏、同屏连续改字、滚回热字体；记录首张/整屏耗时、实际调用次数及过期工作。当前无实机提速结论。55字体解析、C-09/O-07及此前待验事项不在 S10-00 关闭。
