---
title: 快速开始
description: 启动 Hearth 主服务与独立评测 Agent，创建第一条可追踪实验。
---

# 快速开始

## 前置条件

- Node.js 22.13 或更高版本；
- 一个可运行的 Hearth 仓库；
- 至少一个已配置并可执行的 Hearth executor；
- 如需自动 judge，需要配置可用的聊天模型。

推荐目录结构：

```text
D:\App\
  hearth-os\
  hearth-eval\
```

## 1. 允许 Hearth 读取评测输入

评测仓库和 Hearth 是两个独立目录。Hearth 只接受 `HEARTH_EVAL_INPUT_ROOT` 白名单下的输入文件。

在 `hearth-os/.env` 中加入：

```dotenv
HEARTH_EVAL_INPUT_ROOT=D:\App\hearth-eval\eval
```

Linux/macOS 示例：

```dotenv
HEARTH_EVAL_INPUT_ROOT=/home/me/App/hearth-eval/eval
```

## 2. 启动 Hearth

```powershell
cd D:\App\hearth-os
npm install
npm run dev
```

主服务默认监听 `127.0.0.1:4317`。在 Hearth 控制台确认至少一个 executor 可用。

## 3. 启动评测 Agent

```powershell
cd D:\App\hearth-eval
npm install
Copy-Item .env.example .env
$env:HEARTH_EVAL_ARTIFACT_ROOT='D:\App\hearth-os\.hearth\eval-artifacts'
npm run dev
```

打开 <http://127.0.0.1:5174>。评测服务监听 `127.0.0.1:4318`。

`HEARTH_EVAL_ARTIFACT_ROOT` 必须与主服务实际写入的产物根一致；遗漏时运行详情会找不到已登记产物，并错误报告 `BLOCKER_FAILED: exists`。重启后先通过 `GET /api/system` 确认 `artifactRoot`，再启动实验。

## 4. 创建实验

1. 打开“任务目录”，确认 case 目录校验通过；
2. 打开“实验”，选择 case 与 executor；
3. 设置重复次数与离线/在线模式；
4. 创建并启动实验；
5. 在运行详情查看轨迹、grader、产物和 Hearth 任务；
6. 在复核队列处理需要人判断的项目；
7. 用“对比”确认两个实验是否满足对齐条件。

服务重启后会恢复中断运行并标记需要处理的状态，不会把未完成的任务当作通过。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HEARTH_EVAL_HOST` | `127.0.0.1` | 评测服务监听地址 |
| `HEARTH_EVAL_PORT` | `4318` | 评测服务端口 |
| `HEARTH_URL` | `http://127.0.0.1:4317` | Hearth 主服务地址 |
| `HEARTH_EVAL_DATA_DIR` | `.hearth/eval` | SQLite 数据目录 |
| `HEARTH_EVAL_ARTIFACT_ROOT` | `.hearth/eval-artifacts` | 评测产物根目录 |
| `HEARTH_EVAL_CASES_DIR` | `eval/cases` | case 目录 |
| `HEARTH_EVAL_INPUT_ROOT` | 无 | Hearth 允许读取的评测输入根目录 |

## 生产启动

```bash
npm run build
npm start
```

构建后的控制台位于 `apps/eval-web/dist`，由评测服务在 `4318` 端口直接托管。控制台共有 11 个页面、7 个主导航入口；最新 native 30 题结果和复现检查见[评测结果](/reference/results)。
