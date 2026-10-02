# HFM 工程文档索引

## 当前工作

- [字体身份、页面残留与卸载删除权限任务书](plans/HFM_FONT_IDENTITY_PERMISSIONS_TASKBOOK.md)：Stage 12 专项 S12-F01～F07；源码基线 `55b5b01`，分支 `stage/12-font-identity-permissions`。F01 Windows 反例审计已收尾；F02 首批 CI 通过，本地状态路径隔离适配待新 CI，生产兼容切换未完成；F03 独立状态/响应校验 CI 已通过，整项未验收；F04～F07 未开始。

[列表与网格视图审计及优化任务书](plans/HFM_LIST_GRID_VIEW_OPTIMIZATION_TASKBOOK.md) 是本次专项的执行与状态入口。

- 仓库：`uniquenesssta/99`；实施分支：`stage/11-list-grid-view`（基线 `6012cb6`，Stage 10 保持不变）；审计基线：`8582526`。
- S10-V00：审计、计划与归档已完成；S11-V01：已完成，本地/Windows 159 项诊断、300 次真实 DOM 场景及 Windows/Linux CI 通过；S11-V02：已完成，160 项诊断、320 次真实 DOM 场景及 Windows/Linux CI 通过，见任务书 §11；V03：初始显示与详情开合定位修复已实现，自动化验证见任务书 §12.4～§12.5，用户本机体验待确认；V04 实现与自动化验证已完成，161 项诊断、54 张网格 PNG、140 次网格 DOM 场景及 CI 通过（任务书 §14）；V05 实现与自动化验证已完成，161 项诊断、Windows 组件资源/生命周期门及三组 CI 通过，见任务书 §15；V06 回归实现与自动化验证完成，本地/Windows 161 项诊断和三组 CI 通过，相关显示待验（任务书 §16）；V07 未开始。
- 2026-09-28 用户反馈修复：列表几何、网格主题、快速分页和浮动滚动条，以及维护争用、超时误判和统计开销；Windows 165/165 项诊断、真实界面、Windows/Linux 原生回归及三组 CI 全部通过，最终源码及回执见任务书 §18.3.2；目标环境验收未关闭。
- V06.5 已授权推进：A/B 已实现预览配置与共享计数解耦、缓存结果分类和关闭统计拦截；本地/Windows 164 项诊断、12 场景实际链路对比及三组 CI 均通过，证据见任务书 §17。真实共享盘与默认开发窗口待验，仍为 V07 收官必需前置。
- 原 Stage 10 的 S10-06 工程核查结论保留；专项人工性能门已由用户取消，不恢复为后续欠账。未测量的性能收益仍不宣称通过。
- 本索引只整理执行入口，不给旧任务追加实施授权，不把归档当作阶段验收通过。

## 历史任务

2026-09-27 将原 `docs/plans` 下 16 份旧任务书移动到 `docs/old task`。文件名、历史章节和回执保留；旧文件中的“当前”“下一项”均属于历史记录。被删除的分支不因此重建，具体状态以各文件原回执为准。

| 旧任务 | 归档文件 |
| --- | --- |
| HFM 全链路一致性修复任务书 | [HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md](old%20task/HFM_CHAIN_CONSISTENCY_REPAIR_TASKBOOK.md) |
| HFM 索引访问、共享 I/O、激活清理与退出一致性修复任务书 | [HFM_INDEX_IO_ACTIVATION_SHUTDOWN_REPAIR_TASKBOOK.md](old%20task/HFM_INDEX_IO_ACTIVATION_SHUTDOWN_REPAIR_TASKBOOK.md) |
| HFM 操作一致性与刷新优化任务书 | [HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md](old%20task/HFM_INTERACTION_REFRESH_OPTIMIZATION_TASKBOOK.md) |
| HanFontManager：预览缓存、本地标签与 App 专项拆分任务书 | [HFM_PREVIEW_TAG_APP_DECOMPOSITION_TASKBOOK.md](old%20task/HFM_PREVIEW_TAG_APP_DECOMPOSITION_TASKBOOK.md) |
| HanFontManager 修复与编排重构总任务书 | [HFM_REMEDIATION_MASTER_TASKBOOK.md](old%20task/HFM_REMEDIATION_MASTER_TASKBOOK.md) |
| HFM 常驻 DirectWrite 预览试验任务书 | [HFM_RESIDENT_DIRECTWRITE_PREVIEW_TASKBOOK.md](old%20task/HFM_RESIDENT_DIRECTWRITE_PREVIEW_TASKBOOK.md) |
| HFM 共享离线保留与本地字体退出清理任务书 | [HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md](old%20task/HFM_SHARED_OFFLINE_LOCAL_EXIT_TASKBOOK.md) |
| HFM Stage 0：基线与行为锁任务书 | [HFM_STAGE_00_BASELINE_TASKBOOK.md](old%20task/HFM_STAGE_00_BASELINE_TASKBOOK.md) |
| HanFontManager Stage 1：激活与停用事务任务书 | [HFM_STAGE_01_ACTIVATION_TASKBOOK.md](old%20task/HFM_STAGE_01_ACTIVATION_TASKBOOK.md) |
| HanFontManager Stage 2：字体路径授权任务书 | [HFM_STAGE_02_PATH_AUTHORIZATION_TASKBOOK.md](old%20task/HFM_STAGE_02_PATH_AUTHORIZATION_TASKBOOK.md) |
| HanFontManager Stage 3：文件移动一致性与预览限额任务书 | [HFM_STAGE_03_FILE_PREVIEW_TASKBOOK.md](old%20task/HFM_STAGE_03_FILE_PREVIEW_TASKBOOK.md) |
| HanFontManager Stage 4：主进程组合根拆分任务书 | [HFM_STAGE_04_MAIN_COMPOSITION_TASKBOOK.md](old%20task/HFM_STAGE_04_MAIN_COMPOSITION_TASKBOOK.md) |
| HanFontManager Stage 5：Rust Worker 门面拆分任务书 | [HFM_STAGE_05_RUST_WORKER_TASKBOOK.md](old%20task/HFM_STAGE_05_RUST_WORKER_TASKBOOK.md) |
| HanFontManager Stage 6：React 根组件拆分任务书 | [HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md](old%20task/HFM_STAGE_06_REACT_COMPOSITION_TASKBOOK.md) |
| HanFontManager Stage 7：IPC 收口与依赖治理任务书 | [HFM_STAGE_07_IPC_SECURITY_DEPENDENCY_TASKBOOK.md](old%20task/HFM_STAGE_07_IPC_SECURITY_DEPENDENCY_TASKBOOK.md) |
| Stage 10：预览性能与独立修复回移 | [HFM_STAGE_10_PREVIEW_PERFORMANCE_TASKBOOK.md](old%20task/HFM_STAGE_10_PREVIEW_PERFORMANCE_TASKBOOK.md) |

## 审计材料

[全链路审计](audits/HFM_FULL_CHAIN_AUDIT.md) 与 `docs/audits` 下观察脚本、样本保持原位置；只修复其指向旧任务的链接。它们不是新的执行入口。

项目统一变更记录仍在根 [README](../README.md)，不另建变更日志。
