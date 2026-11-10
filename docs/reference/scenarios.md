---
title: 白盒场景
description: 30 个个人 Agent 本地可重复场景、故障注入与运行方式。
---

# 白盒场景

`scenario-runner/` 收纳从 Hearth 主仓库迁出的 30 个个人 Agent 场景。它们直接调用 Hearth Server 的审批、委派、上下文、记忆、调度、连接、本体和任务图服务，属于**针对目标仓库的白盒集成回归**。

## 覆盖范围

- 审批拒绝、动作绑定篡改、非交互高危拒绝；
- 重复发送、未知外部效果对账；
- 目标完成校验、产物删除或字段篡改；
- 崩溃后从已证明检查点恢复；
- 记忆污染、纠正、遗忘传播；
- 技能生命周期和权限收窄；
- 主动提醒噪声、调度补跑、DST 与失败冷却；
- 离线连接一致性和 outbox 重放；
- Personal Agent 的歧义指代、跨会话恢复、陈旧状态、来源冲突、注意力预算、本体提示注入、四周连续性、任务图汇聚和异步工具中断。

## 运行前提

```text
D:\App\
  hearth-os\
  hearth-eval\
```

`scenario-runner/tsconfig.json` 默认通过路径映射读取同级 `../hearth-os`。如果目录不同，请修改映射。

## 运行

```bash
npm run typecheck:scenarios
npm run eval:scenarios
npm run eval:scenarios -- --only approval-rejected-stops,unknown-effect-reconcile
```

每个场景默认重复 3 次。结果写入：

```text
eval/scenario-runs/<timestamp>/report.json
eval/scenario-runs/<timestamp>/summary.md
eval/scenario-runs/<timestamp>/<scenario>/run-N/evidence.json
```

任一场景失败时命令以非零状态退出。场景使用临时数据库、假用户、假偏好、假秘密和可控时钟，不读取真实账户或 `.hearth` 数据。
