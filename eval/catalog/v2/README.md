# Catalog v2

`cases/` 是当前活动任务集，由服务启动时加载；`live/` 保存发布前手动执行的
live-only 冒烟任务，不进入离线矩阵。

规则：

- 每个离线 case 必须是 `schemaVersion: 2`。
- Result 层固定为确定性 60、Judge 30、人工 10。
- Trajectory、Action、Knowledge、System、Safety 是独立门禁，`points` 必须为 0。
- 离线 case 必须有 `golden/`，且所有确定性 grader 能对 golden 通过。
- 每个 case 至少标注一个八项指标维度。
- 旧 60 题已归档到 `eval/catalog/v1/cases/`，保持只读，仅用于历史回归。
