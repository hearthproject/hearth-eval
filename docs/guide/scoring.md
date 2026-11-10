---
title: 评分与复核
description: 确定性检查、模型评委、人工复核、blocker 与通过阈值。
---

# 评分与复核

## 三类 criteria

| 来源 | 判断方式 | 默认权重 |
|---|---|---:|
| `deterministic` | 文件存在、文本包含、JSON/CSV 结构、数量、golden 对比 | 60 |
| `judge` | 模型按 rubric 打分并返回逐项理由与置信度 | 30 |
| `human` | 人确认低置信度、冲突或抽样项目 | 10 |

最终分数按当前可用权重归一化，通过阈值为 **80**。

## Blocker

任何 `severity: blocker` 的 criterion 失败，运行直接得到 0 分和 `failed`，不会用其他高分项平均掩盖。

## 模型评委不可用

如果实验启用自动 judge，而 case 需要 judge 项：

- 模型未配置 → 触发 `low_confidence`，运行进入 `needs_review`；
- judge 临时失败 → 按实验配置重试；
- 重试仍失败 → 保留失败证据并进入复核。

评测不会因为评委不可用而把运行标记为通过。

## 复核触发原因

| 原因 | 含义 |
|---|---|
| `low_confidence` | judge 置信度低于阈值，或人工选择 unknown |
| `judge_conflict` | 确定性结果与 judge 结论冲突 |
| `sampled` | 命中 case 的抽样率 |

## 对比原则

平均分只有在实验条件一致时才有意义。对比页面会明确区分：

- 总体通过率差异；
- 任务族通过率差异；
- 分数差异；
- 耗时、Token、重试和审批差异；
- 不可比警告。
