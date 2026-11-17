---
title: Case Manifest
description: case.json 的字段、grader、criteria 与人工复核策略。
---

# Case Manifest

活动 case 由 `eval/catalog/v2/cases/<caseId>/case.json` 描述。目录名必须与 `id` 一致；旧 v1 case 位于 `eval/catalog/v1/cases/`，只读。

## 核心字段

| 字段 | 说明 |
|---|---|
| `schemaVersion` | `1` 为历史归档，活动 case 必须为 `2` |
| `id` / `version` | case 身份与内容版本 |
| `title` / `family` / `difficulty` | 展示与筛选信息 |
| `runModes` | `offline`、`live-optional` 或 `live-only` |
| `goal` | 交给 Agent 的目标 |
| `inputs` | 文件或 URL 输入 |
| `liveInputs` | 在线模式使用的输入 |
| `expectedOutputs` | 期望产物相对路径 |
| `networkHosts` | 在线模式允许访问的域名 |
| `timeoutMs` | 单次运行超时 |
| `graders` | 确定性检查 |
| `criteria` | 评分项与权重 |
| `budgets` | 步骤、工具调用、时长、Token 与成本上限 |
| `humanReview` | 人工复核提示与抽样率 |

## Criteria

```json
{
  "id": "quality",
  "label": "回复依据充分",
  "source": "judge",
  "points": 30,
  "severity": "scored",
  "metric": "knowledge_grounding",
  "rubric": "每个结论都有来源，未知项不编造。"
}
```

`source` 可以为 `deterministic`、`judge` 或 `human`。`severity` 为 `blocker` 或 `scored`。

## 独立门禁

`layer` 省略时等于 `result`。`trajectory`、`action`、`knowledge`、`system`、`safety` 是独立门禁：

```json
{
  "id": "trajectory_gate",
  "label": "执行轨迹预算与错误门禁",
  "source": "deterministic",
  "points": 0,
  "severity": "blocker",
  "layer": "trajectory",
  "metric": "tool_selection",
  "graderId": "trajectory_gate"
}
```

独立门禁的 `points` 必须为 0，blocker 失败会使运行直接失败，不参与 100 分加权。

## 八项指标

每个离线 case 至少有一个 criterion 标注：

`task_success`、`tool_selection`、`recovery`、`arguments`、`knowledge_grounding`、`latency`、`cost`、`security`。

## v2 权重与 golden

- Result 层必须精确为确定性 60、Judge 30、人工 10；
- 至少一个 blocker；
- 至少一个非 result 独立门禁；
- 离线 case 必须有 `golden/`，且非 trace 确定性 grader 能对 golden 通过；
- 所有 grader 必须被 criterion 引用；
- 目录名必须等于 `id`。

## 安全约束

- 输入路径不能跳出 case 目录或仓库；
- 期望产物必须是安全相对路径；
- offline case 禁止 URL 输入；
- live 模式只传递声明的 host 白名单；
- 符号链接不能作为产物；
- 缺失或空产物必须明确失败。
