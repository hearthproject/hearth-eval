---
title: 任务集
description: 60 个 case、8 个任务族、case 结构与选择原则。
---

# 任务集

## 数量与分布

| 任务族 | 数量 | 覆盖重点 |
|---|---:|---|
| `documents` | 9 | 纪要、合同、报告、教案、编辑 |
| `email` | 8 | 分流、回复、投诉、发票、安全 |
| `calendar` | 7 | 排程、冲突、周视图、里程碑、隐私 |
| `web` | 8 | 归档、抽取、合并、审计、来源 |
| `research` | 8 | 检索、证据、事实核验、研究缺口 |
| `code` | 8 | 修复、评审、复现、契约、升级 |
| `desktop` | 5 | 应用操作、恢复、边界 |
| `cross-app` | 7 | 多应用组合与状态一致性 |

总计 **60 个 case**。启动时服务会校验目录名、manifest、输入和 golden，并同步 case 内容哈希和版本。

## 选择原则

任务集不是能力演示列表，而是用于观察稳定性和成本的固定基线：

1. 输入可固定，结果可复核；
2. 关键事实能由确定性 grader 检查；
3. 质量判断有明确 rubric；
4. 失败能区分环境、审批、执行和内容问题；
5. 外部副作用可审批、可核对；
6. 同一 case 可以重复运行并比较离散度。

## 目录结构

```text
eval/cases/E01/
  case.json
  input.json
  golden/
    triage.json
```

离线 case 必须有 `golden/`；`live-only` case 可以只声明在线输入。manifest 中的 `runModes` 决定允许的运行模式。

## 增加 case

新增 case 时至少需要：

1. 新建与 id 同名的目录；
2. 编写合法 `case.json`；
3. 提供输入和离线 golden；
4. 为关键事实增加 deterministic grader；
5. 为质量要求增加 judge rubric；
6. 明确 blocker、人工复核触发和 timeout；
7. 运行目录校验与评分测试。
