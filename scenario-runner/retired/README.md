# 已退役场景

这些场景依赖的 Hearth OS 功能已被上游主动删除，继续保留会让整套场景注册表在 import 阶段失败，因此从 `eval/scenarios/scenarios.json` 和 `scenario-runner/registry.ts` 中移出。原始实现保存在本目录的同名 `.ts.txt` 文件，便于追溯。

| 场景 | 退役原因 | Hearth OS 依据 |
|---|---|---|
| `channel-inbound-idempotency` | 通用 `ChannelIngressService` 已删除，IM 收敛为微信专用 `im-bridge.ts` | `2d2358c9 refactor(im): make WeChat the only IM channel`、`b666b7a6 feat(channels): add idempotent channel ingress adapter` 后续被移除 |
| `skill-archive-restore` | Method / SkillCurator / SkillPackage 生命周期已删除，只保留 `skill-tools.ts` 的工具入口 | `61375e69 refactor(methods): remove method learning and task binding` |
| `proactive-noise-budget` | Proactive / Attention 簇已整体删除 | `cd8c7e71 refactor(runtime): remove the proactive and attention cluster` |
| `connection-offline-consistency` | `ConnectionService` 已随连接簇删除 | `cd8c7e71 refactor(runtime): remove the proactive and attention cluster` |
| `attention-budget-30` | `StandingIntentService` 已删除，注意力预算不再由 OS 维护 | `cd8c7e71 refactor(runtime): remove the proactive and attention cluster` |

保留场景中的 Goal 校验已迁移到 `GoalService` / `verifyGoalCompletion` 当前契约；动作绑定与无人值守拒绝场景已改用当前 `action-resolver` 的 `host_file` 和 `network POST` 动作类型；四周连续性场景只保留仍存在的本体与上下文编译能力。
