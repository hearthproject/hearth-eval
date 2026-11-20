# 启动评测台

日常使用只需要启动 **hearth-eval**。一个 PowerShell 终端执行 `npm run dev`，会同时启动页面和后端；不需要先启动 hearth-os。

## 1. 日常启动：只运行这一套

打开 PowerShell，执行：

```powershell
cd E:\codex-eval-agent\hearth-eval
npm run dev
```

首次安装或依赖文件更新后，先在此目录执行一次 `npm ci`，再运行 `npm run dev`。需要 Node.js 22.13 或更高版本。

等待终端同时显示：

- 后端：`http://127.0.0.1:4318`，以及 `hearth eval ready`。
- 前端：`http://127.0.0.1:5175/`。

然后打开：

| 页面 | 地址 |
|---|---|
| 评测控制台 | http://127.0.0.1:5175/ |
| 系统配置 | http://127.0.0.1:5175/system |
| 原生 LLM 评测 | http://127.0.0.1:5175/native.html |

保持这个终端运行。停止时，在该终端按 `Ctrl+C`，整组开发服务会一起停止。

### 5175 和 4318 是什么关系？

| 端口 | 用途 | 是否需要手动另开终端启动 |
|---|---|---|
| **5175** | 浏览器看到的页面 | 不需要，`npm run dev` 已包含 |
| **4318** | 保存配置、读数据库、运行评测的后端 API | 不需要，`npm run dev` 已包含 |
| 4317 | 可选的 Hearth 主服务 | 只有要评测 Hearth Agent 时才需要 |
| 5173 | 可选的 Hearth 主控制台 | 独立评测不需要 |

浏览器访问 5175，页面中的 `/api` 请求会自动转发给 4318。因此页面能打开，不代表后端已经更新或启动成功。

## 2. 更新代码后怎么重启

1. 回到之前运行 `npm run dev` 的终端，按 `Ctrl+C` 停止整组服务。
2. 在 `E:\codex-eval-agent\hearth-eval` 重新运行 `npm run dev`。
3. 等待 **4318 后端和 5175 前端都启动成功**，再刷新浏览器；必要时按 `Ctrl+F5`。

不要只重启 5175。新增的“本地存储”和“模型评委”接口由 4318 提供。

### 出现“未找到：/api/system/storage”或“未找到：/api/system/judge”

这通常意味着新页面连接到了旧后端，或另一份检出启动的后端。按上面的步骤重启整组服务，再在另一个 PowerShell 窗口检查：

```powershell
Invoke-RestMethod http://127.0.0.1:4318/api/health -TimeoutSec 10
Invoke-RestMethod http://127.0.0.1:4318/api/system/storage -TimeoutSec 10
Invoke-RestMethod http://127.0.0.1:4318/api/system/judge -TimeoutSec 10
```

第一条应返回 `ok: true`、`service: hearth-eval`；后两条应返回配置 JSON。模型尚未配置时返回 `configured: false` 是正常的，不应返回“未找到”。

如果 4318 的检查正常，但页面仍失败，再检查前端代理：

```powershell
Invoke-RestMethod http://127.0.0.1:5175/api/system/storage -TimeoutSec 10
Invoke-RestMethod http://127.0.0.1:5175/api/system/judge -TimeoutSec 10
```

## 3. 端口被占用，或者找不到旧终端

先检查占用者，确认路径属于要停止的评测项目：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 4318,5175 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,OwningProcess |
  ForEach-Object {
    $evalProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)"
    [pscustomobject]@{
      Port = $_.LocalPort
      PID = $_.OwningProcess
      CommandLine = $evalProcess.CommandLine
    }
  }
```

本机可能有多份 hearth-eval 检出。应使用本文的 `E:\codex-eval-agent\hearth-eval`；其他工作目录启动的服务不会自动使用这里的新代码。

优先回到所属终端按 `Ctrl+C`。找不到终端时，确认上面列出的 PID 后再停止指定进程，例如：

```powershell
# 将 12345 替换为刚查到并确认属于旧评测服务的 PID。
Stop-Process -Id 12345
```

重新运行查询，确认 **4318 和 5175 都没有旧进程监听**，然后执行第 1 节的启动命令。如果进程又被自动拉起，需要停止对应的 `tsx watch` / npm 启动终端。

`npm run dev` 的任一子服务启动失败，会停止同组其他服务；看到端口冲突时，应先处理冲突再重启。

## 4. 配置独立评测

### 被测 LLM：负责执行任务

打开 `http://127.0.0.1:5175/native.html`，填写模型名称、OpenAI 兼容 API 地址和 API Key，测试连接并注册模型，再选择任务运行。

### 模型评委：负责评价产物

打开“系统 → LLM 状态与模型评委”，填写评委 API 地址、模型名和 API Key，保存配置，再点击“确认 LLM 状态”。

- 被测 LLM 和模型评委是两份配置，分别设置。
- 评委由 Eval 独立调用，不读取 Hearth 的聊天模型设置，也不要求 Hearth 在线。
- “已配置”不等于连接成功；连接测试会发送一次短模型请求。
- “测试当前配置”只测试草稿，不会保存；点击“保存评委配置”后，后续评分使用新配置。
- 修改配置时 API Key 留空会保留原密钥。
- 未配置或评委调用失败时，需要评委判断的结果转人工复核。

“Hearth 未连接”只是可选接入的状态，不影响原生 LLM 评测或外部 Agent 评分。

### 数据库和产物目录

在“系统 → 本地存储 → 选择配置”输入或浏览服务所在电脑的已有可写目录，然后保存。

- 页面分别显示当前路径与重启后路径。
- 目录配置保存后，按第 2 节重启整组服务才会生效。
- 数据库文件名固定为 `eval.sqlite`。
- 不会自动迁移旧数据库、被测模型配置或旧产物。切换空目录后看不到旧记录，不代表旧文件被删除；需要保留历史时，先停服务、备份并安排迁移。

默认位置（相对于 `E:\codex-eval-agent\hearth-eval`）：

| 内容 | 默认位置 |
|---|---|
| 数据库 | `.hearth/eval/eval.sqlite` |
| 被测 LLM 配置，含密钥 | `.hearth/eval/providers.json` |
| 产物根目录 | `.hearth/eval-artifacts/` |
| 独立模型评委配置，含密钥 | `.hearth/judge-providers.json` |
| 页面保存的目录配置 | `.hearth/storage-settings.json` |

`HEARTH_EVAL_DATA_DIR` 和 `HEARTH_EVAL_ARTIFACT_ROOT` 环境变量优先于页面保存的目录。如果页面提示“由环境变量指定”，先检查当前终端：

```powershell
Get-Item Env:HEARTH_EVAL_DATA_DIR,Env:HEARTH_EVAL_ARTIFACT_ROOT -ErrorAction SilentlyContinue
```

确定要改由页面配置控制时，停止服务，在启动服务的终端清除这两个临时覆盖，再重新启动：

```powershell
Remove-Item Env:HEARTH_EVAL_DATA_DIR -ErrorAction SilentlyContinue
Remove-Item Env:HEARTH_EVAL_ARTIFACT_ROOT -ErrorAction SilentlyContinue
npm run dev
```

这只清除当前终端的环境变量，不会删除任何数据库或产物。若变量设置在 Windows 用户或系统环境中，新开终端仍可能继承，需要同步调整环境设置。

当前启动脚本不自动加载 `.env`；仅编辑 `.env` 不会改变运行配置。

## 5. 可选：使用构建后的页面

不使用开发服务器时，在项目目录执行：

```powershell
npm run build
npm start
```

此方式只监听 **4318**，打开 `http://127.0.0.1:4318/`，不需要 5175。更新前端代码后，需要重新构建并重启。不要与第 1 节同时运行，因为两者都会使用 4318。

这是本地运行方式，不是发布 release。当前继续逐项完善，验收完成后再统一发布。

## 6. 可选：评测 Hearth Agent

只有需要评测 Hearth Agent 时，才额外启动 hearth-os。原生 LLM 与外部 Agent 评分无需执行本节。

在另一个 PowerShell 启动 Hearth 后端：

```powershell
cd E:\codex-eval-agent\hearth-os
# 首次安装或依赖更新后才需要 npm ci
$env:HEARTH_EVAL_MODE = '1'
$env:HEARTH_EVAL_INPUT_ROOT = 'E:\codex-eval-agent\hearth-eval\eval'
node --import tsx apps/server/src/index.ts
```

等待 4317 启动成功。Eval 的产物根目录还需与 Hearth 实际写入的评测产物目录一致；可在 Eval 的系统页选择并保存，重启 Eval 后生效。不要为独立评测默认设置到 hearth-os 目录。

如需 Hearth 自己的控制台，再另开终端运行：

```powershell
cd E:\codex-eval-agent\hearth-os
npm run dev -w @hearth/web -- --port 5173 --strictPort
```

Hearth 白盒场景依赖同级 `hearth-os` 源码，不属于纯独立运行能力。当前已知其类型检查存在 PDF 依赖声明问题，待修复验收。

## 7. 桌面 Markdown 交付验收

启动 Hearth OS 后端并配置好 native 模型，再启动 Eval 前后端，打开 `http://127.0.0.1:5175/acceptance`（侧栏“交付验收”）。

填写一个尚不存在的 `.md` 文件名、标题和必含内容，选择是否允许失败后修复一次，点击“开始执行与验收”。Hearth 在任务沙箱生成产物，交付步骤原样保存到指定桌面文件，Eval 再读取真实文件并独立检查；已有同名文件不会覆盖。

若显示“等待 Hearth 审批”，请按页面显示的任务 ID 到 Hearth 审批。需要 Hearth 控制台时按第 6 节启动 5173 前端。批准后 Eval 自动继续跟踪，最多等待每轮 10 分钟。

每轮记录任务 ID、失败原因、文件 SHA-256 和复测结果。详见[桌面 Markdown 交付验收](./delivery-acceptance.md)。

需要参考共享项目背景时，勾选“使用共享记忆与语义评审”，先保存项目记忆，再填写本次内容要求。执行与评审使用同一份固定快照，结果自动进入共享验收记录。语义评委在“系统”页独立配置。
