# Catalog v2

`cases/` 是下一代活动任务集的 staging 目录。它不会参与当前服务启动时的
catalog 加载，直到全部任务族、live-only 冒烟任务和文档完成切换。

规则：

- 每个离线 case 必须是 `schemaVersion: 2`。
- Result 层固定为确定性 60、Judge 30、人工 10。
- Trajectory、Action、Knowledge、System、Safety 是独立门禁，`points` 必须为 0。
- 离线 case 必须有 `golden/`，且所有确定性 grader 能对 golden 通过。
- 每个 case 至少标注一个八项指标维度。
- 切换时 `eval/cases/` 整体归档到 `eval/catalog/v1/cases/`，保持只读。
