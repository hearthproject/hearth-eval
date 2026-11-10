# 白盒场景运行器

这里收纳原先位于 Hearth 主仓库 `apps/server/src/scenarios/` 的 30 个个人 Agent 场景。场景会直接调用 Hearth Server 的审批、委派、上下文、记忆、调度、连接和本体服务，因此属于**目标仓库白盒集成测试**，不属于评测控制面的独立运行逻辑。

运行前需要把 Hearth 仓库和本仓库放在同一级目录：

```text
D:\App\
  hearth-os\
  hearth-eval\
```

默认通过 `tsconfig.json` 的路径映射读取 `../hearth-os`。如果 Hearth 位于其他位置，请修改该文件中的路径映射。

```bash
npm run typecheck:scenarios
npm run eval:scenarios
npm run eval:scenarios -- --only approval-rejected-stops,unknown-effect-reconcile
```

运行结果写入 `eval/scenario-runs/<timestamp>/`。每次运行使用内存或临时 SQLite、假用户、假偏好、假秘密和可控时钟，不读取真实账户或真实 `.hearth` 数据。
