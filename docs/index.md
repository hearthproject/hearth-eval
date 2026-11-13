---
layout: home

hero:
  name: "Hearth Eval Agent"
  text: "为个人 Agent 建立可信的评测闭环"
  tagline: 60 个真实任务、8 个任务族、30 个白盒场景。把任务、实验、轨迹、评分、人工复核与对比放在同一个控制面。
  image:
    src: /logo.svg
    alt: Hearth
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 系统架构
      link: /guide/architecture
    - theme: alt
      text: GitHub
      link: https://github.com/hearthproject/hearth-eval

features:
  - icon: 🧪
    title: 任务不是演示
    details: 60 个 case 覆盖文档、邮件、日历、网页、研究、代码、桌面和跨应用任务。每个 case 都有输入、期望产物、grader 与 golden。
  - icon: 🔁
    title: 全周期可追踪
    details: 从运行排队、Hearth 任务创建、执行轨迹到评分、复核、完成或失败，每一步都有状态、事件和证据。
  - icon: ⚖️
    title: 三层评分
    details: 确定性检查负责事实与结构，模型评委负责质量 rubric，人工复核处理低置信度、冲突和抽样。blocker 失败不会被平均分掩盖。
  - icon: 📊
    title: 可比较，不美化
    details: 对比会检查 case、执行器、重复次数和运行模式是否对齐。不可比时明确警告，而不是包装成“提升”。
  - icon: 🛡️
    title: 边界来自 Hearth
    details: 评测只通过受控任务和评分接口访问目标 Agent。离线模式禁用网络，产物写入独立目录，外部副作用仍走审批。
  - icon: 🧭
    title: 白盒回归单独运行
    details: 30 个场景覆盖审批、效果对账、崩溃恢复、记忆、技能、本体、任务图和连接一致性，故障注入与统计结果都留档。
  - icon: 📈
    title: 结果带边界
    details: Native 30 题最好完整单轮 18/30，累计定向确认 19/30；最终提交尚未连续复测，累计口径不会被写成官方单轮成绩。
---

## 它解决什么问题

一个 Agent 能写出一段看起来不错的内容，不代表它能稳定完成任务；一次演示全部通过，也不代表换执行器、增加重复次数或遇到故障后仍然可靠。

Hearth Eval Agent 用一个独立控制面回答四类问题：

| 问题 | 证据 |
|---|---|
| 任务是否真的完成 | 文件、结构、golden 与 blocker 检查 |
| 质量是否达到标准 | 模型 rubric、置信度与人工复核 |
| 成本是否值得 | 耗时、Token、重试与审批次数 |
| 两次实验能否比较 | case、执行器、重复次数与运行模式对齐 |

## 立即开始

```bash
git clone https://github.com/hearthproject/hearth-os.git
git clone https://github.com/hearthproject/hearth-eval.git
cd hearth-eval
npm install
npm run dev
```

评测 Agent 默认连接 `127.0.0.1:4317` 的 Hearth 主服务，并在 `127.0.0.1:5175` 提供控制台。完整步骤见[快速开始](/guide/getting-started)，最新实验见[评测结果](/reference/results)。

> 首次启动只校验 case 目录、同步版本并恢复中断运行，不会自动执行任何评测。
