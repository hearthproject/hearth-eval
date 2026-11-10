---
title: 控制面 API
description: 评测 Agent 的控制面接口与 Hearth 运行桥接契约。
---

# 控制面 API

## 评测服务

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/health` | 存活与 case 数 |
| `GET` | `/api/system` | Hearth、评委、executor 与数据目录 |
| `GET` | `/api/dashboard` | 首屏汇总 |
| `GET` | `/api/cases` | case 目录与筛选 |
| `GET` | `/api/cases/:caseKey` | case 详情与 golden 状态 |
| `GET` | `/api/experiments` | 实验列表 |
| `POST` | `/api/experiments` | 创建并启动实验 |
| `GET` | `/api/experiments/:id` | 实验、运行、summary 与事件 |
| `POST` | `/api/experiments/:id/cancel` | 取消实验 |
| `GET` | `/api/runs/:id` | 运行轨迹、grader、复核、产物与 Hearth 任务 |
| `GET` | `/api/reviews` | 待复核队列 |
| `POST` | `/api/runs/:id/review` | 提交人工复核 |
| `GET` | `/api/compare` | 实验对比 |
| `GET` | `/api/events` | 增量事件流 |
| `GET` | `/api/runs/:id/artifacts/*` | 产物预览 |

## Hearth 运行桥接

### `POST /api/eval/tasks`

请求包含：

- `externalRef`、`title`、`goal`；
- `inputs`、`expectedOutputs`；
- `executorId`、`runMode`、`networkHosts`；
- `outputDir`、`timeoutMs`。

约束：

- 文件输入必须位于 `HEARTH_EVAL_INPUT_ROOT`；
- 离线模式禁止 URL 输入；
- 输出必须在 `.hearth/eval-artifacts/` 下；
- 同一 `externalRef` 幂等，内容变化返回 `409`。

### `POST /api/eval/judge`

请求包含任务、criteria、确定性结果和 locale。Hearth 读取任务已登记文本产物，调用聊天模型并返回：

```json
{
  "model": "judge-model",
  "promptHash": "...",
  "criteria": [],
  "overallConfidence": 0.9,
  "usage": { "inputTokens": 100, "outputTokens": 20 }
}
```

模型未配置返回 `503 JUDGE_UNAVAILABLE`，调用失败返回 `502 JUDGE_FAILED`。

## 事件流

`GET /api/events` 支持 `experimentId`、`runId`、`after` 和 `limit`。事件用于控制台轮询，不作为任务完成的事实来源；运行状态、grader 和产物仍从持久化记录读取。
