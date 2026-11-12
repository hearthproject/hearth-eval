---
title: 评测结果
description: Native 30 题离线实验的最新结果、实验 ID、未复测边界与报告入口。
outline: [2, 3]
---

# 评测结果

本页只汇总已经实际运行的实验。实验详情、逐任务结果和复测建议以主仓库 `hearth-os` 的评测报告为准。

## Native 30 题

运行条件：30 个离线 case（8 个任务族均匀分布）、仅 `native` 执行器、重复 1 次、自动评分与自动重试开启、并发 4。

| 指标 | 结果 |
|---|---:|
| 最好完整单轮 | **18/30 通过（60%）**，平均分 88.89，`EXP-20261111145332-7a95ea` |
| 累计定向确认 | **19/30** 个 case 曾达到 100 分；不是一次连续实验 |
| 最近完整单轮 | 12/30 通过（40%），平均分 73.33，`EXP-20261112003215-b1172b` |
| 最终修复提交 | `eb32ad5`，尚未做不中断的完整 30 题复测 |

初始基线 `EXP-20261111051349-b71b80` 为 0/30：评测桥接创建的任务带有空 `permissions.tools`，原生运行时过滤掉全部工具。修复工具白名单后，第一次完整实验达到 15/30。

最近完整实验受到 provider 慢响应、评分 JSON 截断和任务超时影响，而且早于最后四个归一化修复，40% 不能直接归因于最终代码能力。CAL01、WEB01 等 case 还存在输入与评分 rubric 的语义歧义；T02、T11、WEB03 因 `sampled` 标记未计为正式通过。

## 报告入口

- [Native 30 任务最终评测报告（2026-11-12）](https://hearthproject.github.io/hearth-os/evaluation/native-30-final-report-2026-11-12.html)
- [Native 30 任务基线评测（2026-11-11）](https://hearthproject.github.io/hearth-os/evaluation/native-30-baseline-2026-11-11.html)
- [Hearth 评测与结果总览](https://hearthproject.github.io/hearth-os/evaluation/)

## 复现前检查

1. 主服务设置 `HEARTH_EVAL_INPUT_ROOT=D:\App\hearth-eval\eval`。
2. 评测服务设置 `HEARTH_EVAL_ARTIFACT_ROOT=D:\App\hearth-os\.hearth\eval-artifacts`。
3. 重启后通过 `GET /api/system` 确认 `artifactRoot` 和 `hearthUrl`。
4. 在控制台选择 30 个离线 case、`native`、重复 1 次、离线模式、自动评分和自动重试。
5. 不要在 provider 抖动或服务版本不一致时把单轮结果当作最终结论。

## 口径边界

- 累计 19/30 来自不同轮次和定向重跑，不能作为官方单轮成绩。
- 自动测试、场景运行和一次实验都不能替代真实账户、真实设备或长期运行验收。
- 实验 ID、提交和运行条件必须与分数一起报告；缺一项就无法判断结果是否可比。
