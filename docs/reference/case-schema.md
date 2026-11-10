---
title: Case Manifest
description: case.json 的字段、grader、criteria 与人工复核策略。
---

# Case Manifest

每个 case 由 `eval/cases/<caseId>/case.json` 描述。目录名必须与 `id` 一致。

## 核心字段

| 字段 | 说明 |
|---|---|
| `schemaVersion` | manifest 版本 |
| `id` / `version` | case 身份与内容版本 |
| `title` / `family` / `difficulty` | 展示与筛选信息 |
| `runModes` | `offline`、`live` 或 `live-only` |
| `goal` | 交给 Agent 的目标 |
| `inputs` | 文件或 URL 输入 |
| `liveInputs` | 在线模式使用的输入 |
| `expectedOutputs` | 期望产物相对路径 |
| `networkHosts` | 在线模式允许访问的域名 |
| `timeoutMs` | 单次运行超时 |
| `graders` | 确定性检查 |
| `criteria` | 评分项与权重 |
| `humanReview` | 人工复核提示与抽样率 |

## Criteria

```json
{
  "id": "quality",
  "label": "回复依据充分",
  "source": "judge",
  "points": 30,
  "severity": "scored",
  "rubric": "每个结论都有来源，未知项不编造。"
}
```

`source` 可以为 `deterministic`、`judge` 或 `human`。`severity` 为 `blocker` 或 `scored`。

## 安全约束

- 输入路径不能跳出 case 目录或仓库；
- 期望产物必须是安全相对路径；
- offline case 禁止 URL 输入；
- live 模式只传递声明的 host 白名单；
- 符号链接不能作为产物；
- 缺失或空产物必须明确失败。
