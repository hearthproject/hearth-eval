---
title: 评测结果
description: Native 30 题历史实验、2026-11-14 Native 审批与场景自检定向验证、未复测边界与报告入口。
outline: [2, 3]
---

# 评测结果

本页只汇总已经实际运行的实验。实验详情、逐任务结果和复测建议以主仓库 `hearth-os` 的评测报告为准。

## Native 30 题

以下为 2026-11-11 至 11-12 的历史实验。运行条件：30 个离线 case（8 个任务族均匀分布）、仅 `native` 执行器、重复 1 次、自动评分与自动重试开启、并发 4。

| 指标 | 结果 |
|---|---:|
| 最好完整单轮 | **18/30 通过（60%）**，平均分 88.89，`EXP-20261111145332-7a95ea` |
| 累计定向确认 | **19/30** 个 case 曾达到 100 分；不是一次连续实验 |
| 最近完整单轮 | 12/30 通过（40%），平均分 73.33，`EXP-20261112003215-b1172b` |
| 11 月 12 日报告的修复提交 | `eb32ad5`，尚未做不中断的完整 30 题复测 |

初始基线 `EXP-20261111051349-b71b80` 为 0/30：评测桥接创建的任务带有空 `permissions.tools`，原生运行时过滤掉全部工具。修复工具白名单后，第一次完整实验达到 15/30。

最近完整实验受到 provider 慢响应、评分 JSON 截断和任务超时影响，而且早于最后四个归一化修复，40% 不能直接归因于最终代码能力。CAL01、WEB01 等 case 还存在输入与评分 rubric 的语义歧义；T02、T11、WEB03 因 `sampled` 标记未计为正式通过。

## 2026-11-14 定向验证更新

本轮修复 Native 工具审批被撤销后仍等待决定的问题：审批后的可执行文件被替换时，动作校验拒绝执行，并向 Native 返回拒绝决定，使 Agent 能跳过该工具继续运行。新增回归测试先复现了等待未解除，再验证修复。

| 验证范围 | 结果 |
|---|---|
| Hearth OS 审批、动作绑定、调度、Agent 循环 | 5 个测试文件，106/106 通过 |
| `action-binding-tamper`（动作绑定：审批后替换可执行文件被拒绝） | 单场景重复 3 次，3/3 通过；检查撤销审批、阻止执行、解除 Native 等待和恢复运行状态 |
| Hearth Eval 自检服务、批次与证据 API | 2 个测试文件，9/9 通过 |
| Hearth Eval 类型检查、前端构建 | 通过 |
| 当前代码完整 Native 30 题实验、全部 30 个白盒场景 | 尚未完成本轮复测 |

验证在 Windows 本地工作区执行，相关改动随后提交为 Hearth OS `ef8ca2d`（`fix/native-approval-recovery`）与 Hearth Eval `cfe95d2`（`feat/scenario-self-check`）。场景运行读取同级 Hearth OS 源码，复现时需要同时包含这两侧改动。

Native 30 题是由模型执行任务并评分的实验；白盒场景检查特定实现行为。本次 3/3 是同一个场景的三次运行，不是 Native 30 题的新成绩，也不是全部场景通过。尚未执行真实模型与浏览器的人工审批端到端验收。Hearth OS 全量类型检查仍存在 MCP 参数类型、PDF 模块声明错误，场景类型检查也受 PDF 声明问题影响。

### 在控制台查看自检结果

1. 打开“场景测试”，选择全部或单个场景，点击“开始自检”。
2. 执行中查看扫描状态和运行输出。
3. 完成后自动切换到“最近一次”运行批次，查看统计、检查项与证据，并展开 `log.md` 查看本次日志。

页面自检结果与日志仅保留在评测服务内存中；下一次完成的自检替换上一次结果，服务重启后清空。`log.md` 是页面展示的日志内容，不另存文件；临时测试文件结束后清理。已有命令行历史批次仍可查看。命令行 `npm run eval:scenarios` 保留原有落盘行为，将报告写入 `eval/scenario-runs/`。

复现命令和定位过程见 [Hearth OS 定向验证记录](https://hearthproject.github.io/hearth-os/evaluation/native-30-final-report-2026-11-12.html#定向验证更新)。

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
