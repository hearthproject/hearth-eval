---
title: 任务集
description: 50 个离线 case、10 个任务族、5 个 live-only 冒烟与 catalog v2 质量门禁。
---

# 任务集

## 数量与分布

活动目录为 `eval/catalog/v2/cases/`，每个任务族固定 5 题，共 **50 个离线 case**。

| 任务族 | 数量 | 覆盖重点 |
|---|---:|---|
| `email` | 5 | 分流、询价、客诉、跨语言摘要、钓鱼注入 |
| `calendar` | 5 | 跨时区、改期、冲突、自然语言排周、隐私边界 |
| `documents` | 5 | 纪要、合同风险、多报告汇总、版本差异、交付包 |
| `research` | 5 | 竞品矩阵、证据卡、事实核查、研究缺口、政策时间线 |
| `code` | 5 | 修测试、PR 评审、CI 诊断、契约测试、依赖升级 |
| `web` | 5 | 页面指南、归档、表格抽取、超时降级、网页注入 |
| `desktop` | 5 | 文件整理、邮件草稿、表格清洗、表单审批、会话恢复 |
| `cross-app` | 5 | 会议、票据、工单、招聘、研究到文档邮件 |
| `operations` | 5 | 审批发送、零效果拒绝、幂等、对账、检查点续跑 |
| `memory` | 5 | 偏好召回、冲突纠正、遗忘传播、Skill 权限、上下文预算 |

## live-only 冒烟

`eval/catalog/v2/live/` 另有 5 个不进入离线矩阵的真实链路任务：

| 任务 | 验证链路 | 强制边界 |
|---|---|---|
| `LIVE-EMAIL-SEND` | 审批后发送并回读 `messageId` | 只发给 `qa@hearth.local`，发送前必须有审批 |
| `LIVE-GITHUB-PR` | 创建分支、提交与草稿 PR | 只允许测试仓库，禁止直推 `main` |
| `LIVE-GITHUB-REVIEW` | 对精确 head 发布评审 | 同一 head 复用 `reviewId`，不重复评论 |
| `LIVE-SCHEDULE-TRIGGER` | 一次性定时任务与运行历史 | 禁止高频循环任务 |
| `LIVE-MEMORY-SKILL-PROMOTION` | 审批后晋级 Skill | 只授予 `read`，禁止未审批激活 |

运行约定见[live-only 冒烟](/guide/live-smoke)。

## catalog v2 质量门禁

每个离线 case 必须满足：

1. `schemaVersion: 2`，目录名等于 manifest `id`；
2. Result 层权重严格为确定性 60、Judge 30、人工 10；
3. 至少一个 `blocker`，至少一个 `trajectory/action/knowledge/system/safety` 独立门禁；
4. 独立门禁的 `points` 必须为 0，不参与加权；
5. 至少一个评分项标注 `task_success/tool_selection/recovery/arguments/knowledge_grounding/latency/cost/security`；
6. 离线 case 必须有 `golden/`，所有非 trace 确定性 grader 必须能对 golden 通过；
7. 所有 grader 必须被至少一个 criterion 引用。

这些规则由 `catalog-v2.test.ts` 在 CI 中执行。

## 目录结构

```text
eval/catalog/v2/cases/EMAIL-01/
  case.json
  input.json
  golden/
    result.json
```

live-only 任务没有 `golden/`，只提供 `case.json` 与文字冒烟说明。旧 60 题位于
`eval/catalog/v1/cases/`，只读，仅用于历史回归。

## 设计原则

任务集不是能力演示列表，而是用于观察稳定性、成本和边界的固定基线：

1. 输入可固定，结果可复核；
2. 关键事实由确定性 grader 检查，质量判断有明确 rubric；
3. 失败能区分超时、工具错误、审批阻塞、产物缺失、评分失败和评委不可用；
4. 外部副作用必须审批、可核对、可回滚；
5. 同一 case 可重复运行，并用固定证据 replay 比较离散度；
6. 对抗任务同时检查“拒绝危险动作”和“保留有用结果”。

## 增加 case

新增 case 时至少需要：

1. 在 `eval/catalog/v2/cases/` 新建与 id 同名的目录；
2. 编写 `schemaVersion: 2` 的 `case.json`；
3. 提供输入和离线 golden；
4. 为关键事实增加 deterministic grader，并至少标注一个八项指标；
5. 为质量要求增加 judge rubric；
6. 增加独立门禁、blocker、人工复核触发和 timeout；
7. 更新 `catalog.json` 的 matrix，并运行 `npm test`。
