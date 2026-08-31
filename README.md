# HanFontManager v3.0.0 shared tag rename latency optimization

本修改包基于 `HanFontManager_Electron_v3.0.0_shared_tag_rename_zero_count_fix_20260705`。

## 目标

优化共享标签重命名保存时的可感知延迟，尤其是数量为 0 的共享标签。

## 改动

- 共享标签重命名弹窗保存后立即关闭，侧边栏先做乐观重命名。
- 后端异步确认；失败时回滚侧边栏标签名并提示错误。
- 新增 0 绑定共享标签快速路径：确认旧标签没有字体绑定时，只更新已知共享标签列表，不再走 root-index / shared metadata merged-index 完整刷新链路。
- 有字体绑定的共享标签仍走原子重命名主链路，保证字体关联关系正确。

## 验证

已对修改的 TypeScript 文件执行 `transpileModule` 语法检查。
版本号未更新。
