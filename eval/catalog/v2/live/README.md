# Live-only 冒烟任务

这五个任务不进入离线矩阵，也不要求 `golden/`。它们用于发布前手动验证真实链路，
默认全部带审批门禁和效果上限，禁止在无人值守场景中运行。

## 任务

- `LIVE-EMAIL-SEND`：审批后向测试邮箱发送一封邮件，回读 `messageId`。
- `LIVE-GITHUB-PR`：在 `qa-org/hearth-smoke` 创建草稿 PR，禁止直推 `main`。
- `LIVE-GITHUB-REVIEW`：对指定 PR 的精确 head 发布一次评审，重复执行复用结果。
- `LIVE-SCHEDULE-TRIGGER`：创建一次性定时任务并回读运行历史。
- `LIVE-MEMORY-SKILL-PROMOTION`：审批后晋级 Skill，只授予 `read`。

## 运行约定

1. 使用专用测试账号、测试仓库和 `qa@hearth.local` 收件人。
2. 先确认 `networkHosts` 与测试夹具可用，再创建任务。
3. 任务必须经过审批；失败时检查 trace 的 `primaryCause` 与门禁证据。
4. 人工复核结论写入 run 记录，保留原始触发原因。
5. 禁止把真实客户地址、生产仓库或生产数据库填入这些任务。

## 质量门禁

- Result 层仍为确定性 60、Judge 30、人工 10，通过线 80。
- `trajectory` 与 `safety` 是独立 blocker 门禁，不计权重。
- 发送、建 PR、评审、定时触发和 Skill 晋级都有 `maxEffects` 上限。
- 地址、仓库与权限字段由 `safety_gate` 校验，越界直接失败。
