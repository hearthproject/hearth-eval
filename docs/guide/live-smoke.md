---
title: live-only 冒烟
description: 五个真实链路冒烟任务、审批门禁与运行约定。
---

# live-only 冒烟

离线 case 证明评分与产物逻辑；live-only 任务证明真实链路能完成审批、创建、写回和回读。它们默认不进入自动实验，也不要求 golden。

## 任务清单

| 任务 | 期望结果 | 关键门禁 |
|---|---|---|
| `LIVE-EMAIL-SEND` | 审批后发送给 `qa@hearth.local`，回读 `messageId` | `minApprovals=1`、`maxEffects=1` |
| `LIVE-GITHUB-PR` | 测试仓库草稿 PR，含分支、编号、URL | 禁止直推 `main`，效果上限 4 |
| `LIVE-GITHUB-REVIEW` | 对精确 `headSha` 发布评审并回读 `reviewId` | 重复执行复用结果，效果上限 1 |
| `LIVE-SCHEDULE-TRIGGER` | 一次性任务、触发时间与运行历史 | 禁止循环任务，效果上限 3 |
| `LIVE-MEMORY-SKILL-PROMOTION` | Skill 版本晋级与审批人 | 只授予 `read`，`maxEffects=2` |

## 运行前检查

1. Hearth 使用测试工作区，GitHub 使用 `qa-org/hearth-smoke`，邮件只发 `qa@hearth.local`。
2. 确认执行器健康、审批人可用、网络白名单与测试夹具存在。
3. 读取 trace 的 `primaryCause`，不要把审批阻塞误判为模型错误。
4. 失败时保留产物、评分证据和原始触发原因。
5. 人工复核 `sampleRate=1`，每条都要给出结论。

## 禁止事项

- 不使用真实客户地址、生产仓库或生产数据库；
- 不绕过审批直接发送、建 PR、触发任务或晋级 Skill；
- 不把 live-only 结果混入离线通过率；
- 不因为一次成功就把 live-only 任务改为自动高频运行。

## 失败排查

| 现象 | 优先检查 |
|---|---|
| `approval_blocked` | 审批人、审批时限、任务状态 |
| `tool_error` | 执行器日志、网络白名单、仓库权限 |
| `artifact_missing` | 输出目录约定与 `result.json` 路径 |
| `trace_unavailable` | Hearth trace 接口与任务 ID |
| `policy_denied` | 收件人、仓库、权限或外发白名单 |
