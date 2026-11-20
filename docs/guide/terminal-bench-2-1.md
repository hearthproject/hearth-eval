---
title: Terminal-Bench 2.1 接入执行计划
description: Harbor 执行、Hearth 作答、hearth-eval 导入与看板的代码 harness 评测全链路。
---

# Terminal-Bench 2.1 接入执行计划

> 版本：v2 · 2026-11-20
> 目标仓库：`D:\App\hearth-eval`（评测控制面）、`D:\App\hearth-os`（被测 native harness）
> 一句话：**Harbor 负责跑，Hearth 负责答，hearth-eval 负责记。**

## 0. 一页结论

- Terminal-Bench 2.1 是 **89 道 Linux 容器任务**，官方执行框架是 **Harbor**。
- 每题由 `tests/test.sh` 产出 `verifier/reward.txt` 或 `verifier/reward.json`，reward 通常是 0/1。
- 被测对象是 Hearth 的 **native harness**：shell、文件读写、`apply_patch`、搜索、`run_tests`、上下文管理、token 预算。不是 UI、审批或记忆产品功能。
- Hearth 以 **Harbor installed agent** 进入任务容器，在 `/app` 里执行，和 verifier 共享文件系统。
- **Harbor 执行，hearth-eval 只读导入。** 不在 hearth-eval 里重写 Docker/Harbor，不对 trial 调 LLM judge。
- 现有 50 个自定义 case 的 60/30/10 评分体系完全不动；benchmark 是平行域。
- 本机先跑 1 题 → 5 题 → 89 题 ×1；89 题 ×5 上 Linux 大机器。

## 1. 角色与边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| Terminal-Bench 2.1 | 任务、instruction、镜像、`tests/test.sh`、超时 | 模型调用、harness 实现 |
| Harbor | 拉数据集、建容器、装 agent、跑 verifier、并发、写 `jobs/<job>/` | 评测历史、跨 run 看板 |
| Hearth OS | 容器内执行、usage、`hearth-result.json` | 数据集管理、结果入库 |
| hearth-eval | 数据集/版本登记、导入 job、trial 明细、指标、对比、CSV、看板 | 容器生命周期、镜像构建、verifier 执行 |

明确不做：

1. 不在 hearth-eval 里实现 Docker 编排。
2. 不把 89 题塞进现有 `CaseManifest`；`experiments` 是 rubric 评分，TB 是 verifier reward，语义不同。
3. 不对 TB trial 调 LLM judge。
4. 不跨 TB 2.0/2.1 比较分数；2.1 修正了 2.0 的若干题，分数不可直接比。

## 2. 全链路

```text
Terminal-Bench 2.1 (89 tasks)
        │
        ▼
harbor run -d terminal-bench/terminal-bench-2-1 -o harbor-jobs
        │
        ├─ task container: /app + task.toml 资源
        ├─ Hearth installed agent: /app 内执行
        ├─ verifier: bash /tests/test.sh
        └─ jobs/<job>/
             ├─ config.json
             ├─ result.json
             └─ <trial>/
                  ├─ config.json
                  ├─ result.json
                  ├─ agent/hearth-result.json   （可选，Hearth 写）
                  └─ verifier/
                       ├─ reward.txt / reward.json
                       ├─ test-stdout.txt
                       └─ test-stderr.txt
        │
        ▼
hearth-eval importer（只读 jobs/，幂等）
        │
        ▼
SQLite: benchmark_datasets / tasks / runs / trials
        │
        ▼
API + Benchmark 看板：mean reward / pass@5 / tokens / cost / 逐题对比
```

## 3. 数据模型

实现位于 `apps/eval-server/src/benchmark-store.ts`，复用 `EvalStore` 的同一个 `DatabaseSync` 连接；不新开第二个 SQLite 连接。

```sql
CREATE TABLE IF NOT EXISTS benchmark_datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  commit_sha TEXT,
  digest TEXT,
  task_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_tasks (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  instruction_path TEXT,
  image_ref TEXT,
  timeout_sec REAL,
  metadata_json TEXT NOT NULL,
  UNIQUE(dataset_id, task_key)
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  harness_name TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  config_json TEXT NOT NULL,
  raw_dir TEXT NOT NULL,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, dataset_id, harness_name, harness_version, model)
);

CREATE TABLE IF NOT EXISTS benchmark_trials (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  trial_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  reward REAL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  reward_path TEXT,
  result_path TEXT,
  error_code TEXT,
  error_message TEXT,
  verifier_stdout TEXT,
  verifier_stderr TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, trial_key)
);
```

索引：`benchmark_trials(run_id, task_key)`、`benchmark_trials(run_id, status)`、`benchmark_runs(dataset_id, created_at)`。

规则：

- `run.id` 由 `dataset + jobId + harness + harnessVersion + model` 的 sha256 前 16 位生成，重复导入稳定命中同一 run。
- `job_id` 不单独 UNIQUE；同一 job 在修正 dataset/harness/model 元数据后可以形成新 run，不覆盖旧 run。
- `summary_json` 在导入完成时写入，列表页不用每次聚合 445 条 trial。
- `verifier_stdout/stderr` 截断到 32KB，并写截断标记；原始 `jobs/` 目录保持只读。
- `status`：`passed`、`failed`、`partial`、`error`、`timeout`、`budget_exceeded`、`skipped`。
- `reward` 允许 0–1 浮点；TB 2.1 正常是 0/1。

## 4. 导入契约

### 4.1 目录

Harbor 官方目录结构：

```text
jobs/<job-name>/
├── config.json
├── result.json
├── <trial-name>/
│   ├── config.json
│   ├── result.json
│   ├── agent/
│   │   ├── recording.cast
│   │   ├── trajectory.json
│   │   └── hearth-result.json   # 本方案可选扩展
│   └── verifier/
│       ├── ctrf.json
│       ├── reward.txt
│       ├── reward.json
│       ├── test-stderr.txt
│       └── test-stdout.txt
└── ...
```

### 4.2 解析优先级

| 字段 | 首选 | 兜底 | 失败处理 |
|---|---|---|---|
| `task_key` | trial `config.json` 的 `task_name` / `task.name` | trial 目录名去掉 `__<suffix>` | 目录名兜底 |
| reward | `result.json.verifier_result.rewards.reward` | `verifier/reward.txt` → `verifier/reward.json.reward` | 缺失 → `error`，不记 0 |
| input tokens | `result.json.agent_result.n_input_tokens` | `hearth-result.json.usage.inputTokens` | 允许 `null` |
| output tokens | `result.json.agent_result.n_output_tokens` | `hearth-result.json.usage.outputTokens` | 允许 `null` |
| cached tokens | `n_cached_tokens` / `cached_tokens` | `hearth-result.json.usage.cachedInputTokens` | 允许 `null` |
| duration | `result.json` 时长字段 | `completed_at - started_at` | 允许 `null` |
| exception | `exception_info` | `exception` | 映射 `timeout` / `error` |
| model | 导入参数 | job `config.json.model` | `unknown` |
| harness | 导入参数 | job `config.json.agent.name` | `hearth-native` |

### 4.3 幂等与安全

- 导入在一个 `BEGIN IMMEDIATE` 事务内完成：upsert dataset/task/run → 删除该 run 旧 trial → 插入新快照 → 写 summary。
- 同一 job 重复导入：run 不变，trial 不重复；旧 trial 被本次快照替换。
- `jobDir` 必须是 `jobsRoot` 下的真实子目录：`realpathSync` 后做 `relative` 校验，拒绝 `..`、绝对路径逃逸和符号链接逃逸。
- `dryRun=true` 只解析、算 summary，不写库。
- 错误码：`JOB_NOT_FOUND`、`JOB_OUTSIDE_ROOT`、`INVALID_JOB_JSON`、`NO_TRIALS`、`JOB_MISMATCH`、`REWARD_MISSING`。
- 缺 reward 的 trial 存为 `error`，`reward=null`，单独计入 `errorTrials` / `infraErrorRate`。

### 4.4 导入 API

```http
POST /api/benchmarks/import
Content-Type: application/json

{
  "jobDir": "harbor-job-mini",
  "datasetName": "terminal-bench/terminal-bench-2-1",
  "datasetVersion": "2.1",
  "datasetTaskCount": 89,
  "harnessName": "hearth-native",
  "harnessVersion": "0.1.0",
  "model": "provider/model",
  "pricing": {
    "inputPerMillionUsd": 3,
    "outputPerMillionUsd": 15,
    "cachedPerMillionUsd": 0.3
  },
  "dryRun": false
}
```

`jobDir` 推荐传相对路径；绝对路径也支持，但必须仍位于 `harborJobsRoot` 内。

## 5. 指标口径

| 指标 | 定义 |
|---|---|
| `validTrials` | reward 为有限数值的 trial；`error` / `timeout` / `budget_exceeded` 不计入 |
| `meanReward` | `sum(reward) / validTrials`，与 TB 官方 5 次均值口径一致 |
| `passRate` | `passedTrials / validTrials` |
| `pass@5` | 至少有 5 次有效 trial 的题中，至少 1 次 reward=1 的题占比；不足 5 次为 `null` |
| `resolvedTasks` | 逐题 best reward >= 1 的题数 |
| `partialTasks` | 逐题 best reward 在 (0,1) 的题数 |
| `infraErrorRate` | `(error + timeout + budget_exceeded) / totalTrials` |
| `tokens` | input + output；cached 单独展示，不重复加总 |
| `costUsd` | 优先按导入单价计算；否则读 Harbor 可选 cost；都没有则 `null` |
| `costPerSolvedUsd` | `costUsd / resolvedTasks`；resolved=0 时 `null` |
| CI | 95% Wilson interval，基于 validTrials 的二值通过率 |
| 对比 | 同 dataset 才允许；模型不同给 warning，不拒绝 |

不引入 LLM judge；不把 `reward.txt` 缺失当 0；不跨 TB 2.0/2.1 比较。

## 6. API、CLI 与看板

### 6.1 API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/benchmarks/jobs` | 扫描 jobs root，返回候选 job 目录 |
| `POST` | `/api/benchmarks/import` | 导入 job；支持 dryRun、dataset/harness/model/pricing 覆盖 |
| `GET` | `/api/benchmarks` | run 列表，带 summary |
| `GET` | `/api/benchmarks/:id` | run 详情 + 逐题 summary |
| `GET` | `/api/benchmarks/:id/trials` | trial 分页/筛选 `taskKey`、`status`、`limit`、`offset` |
| `GET` | `/api/benchmarks/:id/trials/:trialId` | 单 trial 详情，含 raw 与 verifier 输出 |
| `GET` | `/api/benchmarks/:id/compare?baseline=` | 同 dataset 的 run 对比 |
| `GET` | `/api/benchmarks/:id/export?format=csv` | 逐 trial CSV 下载 |
| `POST` | `/api/benchmarks/:id/reimport` | 从已存 `raw_dir` 重导入；job 不匹配返回 409 |

不做 `POST /api/benchmarks/launch`；不在服务进程里拉 Docker。

### 6.2 CLI

```powershell
npm run bench:import -- `
  --job <job-dir-name> `
  --jobs-root .\harbor-jobs `
  --dataset terminal-bench/terminal-bench-2-1 `
  --version 2.1 `
  --harness hearth-native `
  --model <model>
```

可选 `--pricing-input`、`--pricing-output`、`--pricing-cached`、`--dry-run`、`--json`、`--help`。
`--db` 默认使用 `HEARTH_EVAL_DATA_DIR` 下的 `eval.sqlite`。

环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `HEARTH_EVAL_HARBOR_JOBS_ROOT` | Harbor job 根目录 | `<repo>/harbor-jobs` |
| `HEARTH_EVAL_DATA_DIR` | SQLite/运行数据目录 | `.hearth/eval` |
| `HEARTH_EVAL_PORT` | eval 服务端口 | `4318` |

### 6.3 看板

- `/benchmarks`：run 列表、汇总卡、Harbor job 导入面板、候选目录、dry-run、pricing 覆盖。
- `/benchmarks/:id`：指标卡（mean reward、pass@5、resolved、tokens、cost、infra errors）、逐题矩阵、搜索/状态筛选、trial 抽屉、重导入、CSV。
- `/benchmarks/compare?baseline=&candidate=`：聚合 delta + 逐题改善/退步/缺失/新增。
- 不展示模型自评分数；不自动生成“结论”。

## 7. 本机跑 TB 2.1（Windows）

### 7.1 能力边界

| 项 | 要求 | 本机现状 |
|---|---|---|
| 系统 | Windows 10/11 + WSL2 | Windows；Docker Desktop 已安装但 daemon 未启动 |
| Docker | Linux containers | 需启动 Docker Desktop |
| 内存 | 16GB 起；单题建议 10GB 给 Docker | 15.2GB，可跑 1 题 |
| 磁盘 | 5–10 题 60GB；89×5 200GB | D 盘 38.3GB，只够冒烟 |
| Node | ≥ 22.13 | 需确认 |
| Python/uv | Harbor 需要 Python 3.11+ | 需安装 uv |

结论：**本机可以一题一题跑，不适合 89×5 全量。** 云主机只是跑量加速器，不是必需。

### 7.2 启动 Docker 和 Harbor

```powershell
docker version
docker run --rm hello-world
uv tool install harbor
harbor --version
```

如果 Docker 内存不足，在 `C:\Users\<你>\.wslconfig` 限制：

```ini
[wsl2]
memory=10GB
processors=6
swap=2GB
```

然后 `wsl --shutdown`，重启 Docker Desktop。

### 7.3 先跑 oracle 冒烟

先不接 Hearth，只验证 Harbor 容器、任务、verifier 和导入链路：

```powershell
cd D:\App\hearth-eval
harbor run `
  -d "terminal-bench/terminal-bench-2-1" `
  -a oracle `
  -t "<task-name>" `
  -n 1 `
  -o harbor-jobs
```

跑完检查：

```powershell
Get-ChildItem -Recurse .\harbor-jobs\<job>\verifier
Get-Content .\harbor-jobs\<job>\<trial>\verifier\reward.txt
```

导入：

```powershell
npm run bench:import -- --job <job> --jobs-root .\harbor-jobs --dataset terminal-bench/terminal-bench-2-1 --version 2.1 --harness oracle --model oracle --json
```

再启动控制台：

```powershell
npm run dev
# http://127.0.0.1:5175/benchmarks
```

### 7.4 接 Hearth

Hearth 侧需要先产出 Linux 单文件和 Harbor installed agent（见第 8 节）。跑单题：

```powershell
harbor run `
  -d "terminal-bench/terminal-bench-2-1" `
  --agent-import-path "<hearth-os>/integrations/harbor/hearth_agent:HearthAgent" `
  -t "<task-name>" `
  -m "<model>" `
  -n 1 `
  -o harbor-jobs
```

然后用 `npm run bench:import` 导入，`--harness hearth-native`、`--model <model>`。

### 7.5 单题、5 题、89 题

1. **1 题**：确认 Docker、agent 安装、verifier、`reward.txt`、`hearth-result.json` 都能产出。
2. **5 题**：确认 token、耗时、异常、超时映射和看板逐题矩阵。
3. **89 题 ×1**：确认全量 job 的导入性能和缺失 reward 统计。
4. **89 题 ×5**：只在 32C/64G/200GB 级 Linux 主机上跑；本机 15.2GB 不建议。

Token 消耗属于 Hearth/模型侧，hearth-eval 导入器不调用模型，不会额外消耗 token。只有开启 LLM judge、自动重试、重复跑或往 instruction 塞额外上下文才会增加消耗，本方案都不做。

## 8. Hearth OS 需要补的能力

本仓库只负责导入、记账和看板。要真正用 Hearth 跑 TB，`hearth-os` 还需要：

| 文件 | 改动 |
|---|---|
| `scripts/bench/run-agent.ts` | 增加 `--benchmark`、`--json-out`、`--max-duration`、`--max-tokens`；输出稳定 JSON |
| `packages/agent-runtime/src/harness/profiles.ts` | 新增 `BENCH_RUN_BUDGET`：3 小时、200 turns、100 万 token/题 |
| `packages/agent-runtime/src/tools.ts` | benchmark 工具集只留 shell/file/search/patch/test/todo/finish |
| `packages/agent-runtime/src/harness/environment.ts` | `HEARTH_IN_CONTAINER=1` 时强制 bash |
| `packages/agent-runtime/src/harness/sandbox.ts` | 容器内允许 no-sandbox；宿主机模式仍保留 ACL |
| `packages/agent-runtime/src/harness/prompt.ts` | benchmark 用原始 instruction，不拼 outDir/expectedOutputs |
| `scripts/build-bench.mjs` | 产出 `hearth-bench-linux-x64` 单文件 |
| `integrations/harbor/hearth_agent.py` | Harbor installed agent adapter |
| `integrations/harbor/install-hearth.sh.j2` | 容器内安装/校验 `hearth-bench` |

benchmark profile 必须关闭：`ask_user`、桌面截图、memory/skills/user profile 注入、持久 `.hearth` 状态。
必须打开：`/app` 与 `/tmp` 读写、容器内 bash、按 `task.toml` 的网络策略、`HEARTH_IN_CONTAINER=1` 才允许 no-sandbox。

Hearth 输出契约（写到 `/logs/agent/hearth-result.json`）：

```json
{
  "status": "completed",
  "usage": {
    "inputTokens": 123456,
    "cachedInputTokens": 45678,
    "outputTokens": 6789
  },
  "turns": 42,
  "toolCalls": 87,
  "summary": "Implemented X and verified with tests."
}
```

`status` 允许：`completed`、`failed`、`timeout`、`budget_exceeded`。

Harbor adapter 示意：

```python
from pathlib import Path
from harbor.agents.installed.base import BaseInstalledAgent, ExecInput

class HearthAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "hearth-native"

    @property
    def _install_agent_template_path(self) -> Path:
        return Path(__file__).with_name("install-hearth.sh.j2")

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        return [ExecInput(
            command=(
                "hearth-bench --benchmark "
                "--goal-file /tmp/hearth/instruction.md "
                "--workspace /app "
                "--json-out /logs/agent/hearth-result.json"
            ),
            env={
                "HEARTH_IN_CONTAINER": "1",
                "HEARTH_HOME": "/tmp/hearth",
                "HEARTH_MODEL_BASE_URL": "<Harbor 允许的模型地址>",
                "HEARTH_MODEL_API_KEY": "<运行时注入，不写进镜像>",
                "HEARTH_MODEL_NAME": "<model>",
            },
            timeout_sec=1800,
        )]
```

> 以上是接口示意；以当前 Harbor 版本的 `BaseInstalledAgent` 签名为准。不要把 API Key 打进镜像或 git。

## 9. 测试与验收

### 9.1 自动化测试

| 层 | 覆盖 |
|---|---|
| `packages/eval-core/src/benchmark.test.ts` | mean reward、pass rate、pass@5、Wilson CI、成本、CSV 转义、run 对比 |
| `apps/eval-server/src/benchmark-store.test.ts` | 建表、dataset/task/run upsert、trial 替换、筛选/分页、summary |
| `apps/eval-server/src/benchmark-import.test.ts` | pass/fail/error/timeout、reward.txt/reward.json 回退、token 回退、重复导入、dryRun、路径逃逸 |
| `apps/eval-server/src/benchmark-routes.test.ts` | import/jobs/list/detail/trials/compare/export/reimport、400/403/404/409 |
| `apps/eval-server/src/benchmark-import-cli.test.ts` | CLI 参数、pricing 校验、help |
| fixture | `apps/eval-server/test/fixtures/harbor-job-mini{,-alt}` |

验收命令：

```powershell
cd D:\App\hearth-eval
npm run typecheck
npm test
npm run build
npm run docs:build
npm run check
```

### 9.2 手工验收

- [ ] 导入 `harbor-job-mini`，详情页显示 5 个 trial，mean reward 与手算一致。
- [ ] 同一 job 导入两次，数据库仍是 5 条 trial。
- [ ] 缺 reward 的 trial 显示 `error`，不被算成 fail。
- [ ] `timeout` trial 显示超时，不作为模型答错。
- [ ] `reward.json` 回退和 `reward.txt` 回退都能通过。
- [ ] 原始 `jobs/` 目录未被修改。
- [ ] 现有 50 个自定义 case 的测试全部通过。

## 10. 常见问题

| 现象 | 检查 |
|---|---|
| `JOB_NOT_FOUND` | 路径是否相对 `harbor-jobs`，或 `--jobs-root` 是否指向正确目录 |
| `JOB_OUTSIDE_ROOT` | 绝对路径是否在 jobs root 内；是否有符号链接逃逸 |
| `NO_TRIALS` | job 下是否有 trial 目录、`config.json`/`result.json`/`verifier` |
| `REWARD_MISSING` | verifier 是否真的跑了；检查 `verifier/test-stdout.txt` / `test-stderr.txt` |
| token 为 `null` | Hearth 是否写了 `hearth-result.json.usage`；Harbor 的 `agent_result` 是否为空 |
| Docker 起不来 | Docker Desktop daemon、WSL2、`.wslconfig` 内存 |
| 89×5 太慢/爆盘 | 本机不要跑全量；换 32C/64G/200GB Linux 主机 |
| 对比报 `DATASET_MISMATCH` | 两个 run 的 dataset/version 不一致，不能直接比 |
