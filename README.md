<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/brand/hearth-os-logo-reverse.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/brand/hearth-os-logo.png">
    <img src="docs/public/brand/hearth-os-logo.png" alt="Hearth Eval Agent" width="420">
  </picture>
</p>

<p align="center">
  <strong>像实验室一样运行个人 Agent 评测。</strong><br>
  60 个真实任务 · 8 个任务族 · 30 个白盒场景 · 全周期可视化
</p>

<p align="center">
  <a href="https://hearthproject.github.io/hearth-eval/"><strong>文档站</strong></a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#评测全周期">评测全周期</a> ·
  <a href="#任务集">任务集</a> ·
  <a href="#架构">架构</a> ·
  <a href="#验证">验证</a>
</p>

<p align="center">
  <img alt="60 cases" src="https://img.shields.io/badge/cases-60-2f7d4f">
  <img alt="8 families" src="https://img.shields.io/badge/families-8-2f7fa8">
  <img alt="30 scenarios" src="https://img.shields.io/badge/scenarios-30-b8471d">
  <img alt="26 tests passing" src="https://img.shields.io/badge/tests-26%20passing-2f7d4f">
  <img alt="Node.js 22.13+" src="https://img.shields.io/badge/node-22.13%2B-3c8773">
  <img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1b1815">
</p>

---

Hearth Eval Agent 不是一个散落着脚本的评测集，而是一个**独立于个人 Agent 运行时的评测控制面**。它管理任务目录、创建实验、驱动目标 Agent 执行、保存完整轨迹、运行确定性与模型评分、排队人工复核，并把两次实验放回同一张表里比较。

它回答一个很具体的问题：**同一批真实任务，在不同执行器、重复次数和运行模式下，通过率、质量分数、耗时、Token 和审批次数发生了什么变化？**

> **边界：** 本仓库负责“怎么评测”，不伪造评测结论。首次启动不会自动创建实验；真实通过率、执行器差异和成本数据必须由你实际运行后产生。

## 为什么单独拆出来

| 问题 | Hearth 主仓库 | Hearth Eval Agent |
|---|---|---|
| 关心什么 | 把用户意图变成可靠任务 | 证明任务完成得是否稳定、可信、值得成本 |
| 运行内容 | Agent、执行器、审批、记忆、调度 | Case、实验、评分、复核、对比、证据 |
| 失败语义 | 任务失败、等待输入或审批 | 实验失败、需要复核、不可比或样本不足 |
| 数据边界 | `.hearth/artifacts` 与个人状态 | `.hearth/eval` 与 `.hearth/eval-artifacts` |

拆分后，评测不会把实验状态混入个人 Agent 的正式产物，主服务只需要保留一个最小运行桥接。

## 能做什么

| 能力 | 当前实现 |
|---|---|
| **任务目录** | 60 个 case、8 个任务族；按任务族、难度、运行模式和关键词筛选 |
| **实验编排** | 多 case、多执行器、1–5 次重复、离线/在线模式、并发上限与取消 |
| **全周期轨迹** | 从任务创建、执行、等待审批到评分、复核、完成或失败的逐事件记录 |
| **三层评分** | 确定性检查、模型 rubric 评分、人工复核；blocker 失败直接归零 |
| **人工复核队列** | 低置信度、评委冲突、抽样复核与 `pass/fail/unknown` 决定 |
| **实验对比** | 对齐 case、执行器、重复次数与运行模式；不可比时明确警告 |
| **产物审计** | 受控预览运行产物、grader 证据、Token、耗时、重试与审批次数 |
| **白盒场景** | 30 个本地场景，覆盖审批、效果对账、崩溃恢复、记忆、本体、任务图等 |

## 界面

评测控制台包含七个主视图，默认地址为 `http://127.0.0.1:5174`：

- **总览**：运行中实验、待复核数量、任务目录健康度和最近活动；
- **任务目录**：任务 manifest、输入、golden、评分标准和历史实验；
- **实验**：创建、启动、取消和查看完整生命周期；
- **运行详情**：轨迹、deterministic/judge 结果、产物预览和 Hearth 任务关联；
- **复核队列**：需要人判断的项目集中处理；
- **对比**：通过率、分数和任务族差异，附对齐条件；
- **系统**：Hearth 连通性、执行器健康、评委模型和存储路径。

## 快速开始

推荐把两个仓库放在同一级目录：

```text
D:\App\
  hearth-os\
  hearth-eval\
```

### 1. 启动 Hearth 主服务

在 `hearth-os` 中启动个人 Agent，并允许评测服务读取本仓库的输入目录：

```powershell
# hearth-os\.env
HEARTH_EVAL_INPUT_ROOT=D:\App\hearth-eval\eval
```

```powershell
cd D:\App\hearth-os
npm install
npm run dev
```

主服务默认监听 `127.0.0.1:4317`。

### 2. 启动评测 Agent

```powershell
cd D:\App\hearth-eval
npm install
Copy-Item .env.example .env
npm run dev
```

打开 `http://127.0.0.1:5174`。评测服务监听 `127.0.0.1:4318`，Vite 会把 `/api` 代理到评测服务。

### 3. 创建第一条实验

1. 在“任务目录”选择 case；
2. 在“实验”中勾选执行器与重复次数；
3. 点击创建并启动；
4. 在运行详情查看轨迹、评分与产物；
5. 在复核队列处理需要人判断的项目；
6. 用“对比”检查两次实验是否真的可比。

首次启动只校验目录、同步 case 版本并恢复中断运行，**不会自动执行任务**。

## 评测全周期

```mermaid
flowchart LR
  A[选择 case] --> B[创建实验]
  B --> C[生成运行]
  C --> D[提交 Hearth 任务]
  D --> E[执行与轨迹采集]
  E --> F[确定性评分]
  F --> G[模型评委]
  G --> H{需要复核?}
  H -- 是 --> I[人工复核]
  H -- 否 --> J[汇总结果]
  I --> J
  J --> K[实验对比]
  K --> L[产物与证据留档]
```

关键状态不会被平均分掩盖：

- `failed`：blocker 或执行失败；
- `needs_review`：评委不可用、置信度不足或命中抽样；
- `blocked`：依赖、审批或环境无法继续；
- `passed`：确定性、模型和人工标准在可用权重内全部满足。

## 任务集

| 任务族 | 数量 | 典型任务 |
|---|---:|---|
| `documents` | 9 | 会议纪要、合同提取、多报告摘要、课程教案 |
| `email` | 8 | 收件箱分流、回复草稿、投诉处理、发票与账单 |
| `calendar` | 7 | 日程规划、冲突处理、周视图、里程碑、隐私 |
| `web` | 8 | 网页归档、表格提取、来源追踪、安全审计 |
| `research` | 8 | 多源检索、证据链、事实核验、研究缺口 |
| `code` | 8 | Bug 修复、PR 评审、CI 复现、契约检查、升级 |
| `desktop` | 5 | 应用操作、恢复、边界与不可逆动作 |
| `cross-app` | 7 | 邮件、日历、文档、桌面之间的组合任务 |

每个 case 都有 `case.json`，声明目标、输入、期望产物、grader、评分标准和人工复核策略。目录名必须与 manifest `id` 一致；离线 case 必须提供 `golden/`。

## 架构

```text
┌──────────────────────────────┐
│ apps/eval-web                │
│ React + Vite 评测控制台      │
└──────────────┬───────────────┘
               │ /api
┌──────────────▼───────────────┐       POST /api/eval/tasks       ┌──────────────────────┐
│ apps/eval-server             │ ───────────────────────────────▶ │ Hearth main service  │
│ Fastify · 实验 · 轨迹 · 评分 │ ◀─────────────────────────────── │ Agent runtime · 4317 │
└──────────────┬───────────────┘       GET  /api/tasks/:id        └──────────────────────┘
               │                         POST /api/eval/judge
       ┌───────▼────────┐
       │ SQLite + 产物  │
       │ .hearth/eval   │
       └────────────────┘

packages/eval-core   契约、目录加载、grader、评分、场景统计
eval/                60 个 case、输入、golden、历史验收证据
scenario-runner/     30 个 Hearth 白盒场景（读取同级 hearth-os）
docs/                VitePress 中文文档站
```

评测服务通过两个专用接口访问 Hearth：

- `POST /api/eval/tasks`：受控创建评测任务；
- `POST /api/eval/judge`：使用已登记产物做模型评分。

输入文件只允许位于 `HEARTH_EVAL_INPUT_ROOT` 下；输出只允许写入 `.hearth/eval-artifacts/`；离线实验拒绝 URL 输入；外部写入必须经过 Hearth 原有审批。

## 评分模型

每个 case 的 criteria 分为三类：

| 来源 | 用途 | 默认权重 |
|---|---|---:|
| `deterministic` | 文件存在、内容包含、JSON/CSV 结构、数量和 golden 对比 | 60 |
| `judge` | 模型按 rubric 判断质量、完整性、证据与表达 | 30 |
| `human` | 人确认低置信度、冲突或抽样项目 | 10 |

通过阈值为 **80 分**。分数按当前可用权重归一化；任一 blocker 失败直接得到 0 分和 `failed`。模型评委不可用时，需要 judge 的运行进入 `needs_review`，不会静默通过。

## 常用命令

```bash
npm run dev                 # 评测服务 + 控制台
npm run dev:server          # 仅评测服务，4318
npm run dev:web             # 仅控制台，5174
npm test                    # 单元与 API 测试
npm run typecheck           # 评测代码类型检查
npm run typecheck:scenarios # 白盒场景类型检查
npm run eval:scenarios      # 30 个本地场景，每个重复 3 次
npm run build               # 构建评测控制台
npm start                   # 生产启动，服务端托管 dist
npm run check               # 类型检查 + 测试 + 构建
npm run docs:dev            # 文档站开发
npm run docs:build          # 构建文档站
```

只复现一个场景：

```bash
npm run eval:scenarios -- --only approval-rejected-stops,unknown-effect-reconcile
```

场景读取同级 `../hearth-os` 的白盒服务；运行结果写入 `eval/scenario-runs/`，该目录不纳入版本控制。

## 仓库结构

```text
apps/
  eval-server/          评测编排、SQLite、判分、复核、对比与 SPA 托管
  eval-web/             React + Vite 可视化控制台
packages/
  eval-core/            Case 契约、目录加载、grader、评分与场景统计
eval/
  cases/                60 个 case，含输入、case.json 与 golden
  inputs/               第一阶段 15 个任务的固定输入
  runs/                 第一阶段验收产物与证据
  scenarios/            30 个白盒场景 manifest
scenario-runner/        读取同级 Hearth 源码的集成场景运行器
docs/                   VitePress 中文文档站
```

## 验证

```bash
npm test
npm run typecheck
npm run typecheck:scenarios
npm run build
npm run docs:build
```

本仓库的自动验证不会执行真实评测实验，也不会把任何实验标记为通过。测试与本地场景只能证明控制面、评分逻辑和故障边界；真实通过率、执行器差异、模型成本和人工耗时必须由你实际运行后产生。

## 安全与数据边界

| 路径 | 内容 |
|---|---|
| `.hearth/eval/eval.sqlite` | case 版本、实验、运行、grader、复核与事件 |
| `.hearth/eval-artifacts/<experiment>/<case>/<executor>/r<n>` | 单次运行产物与证据 |
| `eval/cases/<caseId>/` | 输入、manifest、golden 与可选 live 输入 |
| `eval/scenario-runs/<timestamp>/` | 本地场景报告，已忽略 |

评测服务不接受任意本地输入路径，不写仓库外目录，不把评测产物混入个人 Agent 的正式产物。服务恢复时会把中断运行标记为需要处理，而不是当作通过。

## 许可

Apache-2.0。见 [LICENSE](LICENSE)。
