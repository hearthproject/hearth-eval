# DESK02：邮件草稿动作规划（离线）

## 如何运行实际实验

启动 Hearth 和 Eval 后，在评测台「新建实验」选择 DESK02、offline 和可用的执行器，创建并启动实验。首次验证建议重复 1 次并启用模型评分，在运行详情查看产物和评分证据。

- `case.json`：任务目标、输入路径、产物要求和评分配置；当前为第 2 版。
- `input.json`：模拟 MailDesk 的初始状态、批准的邮件内容、动作格式和语义。
- `golden/actions.json`：合法参考计划，供测试与人工复核；不是实际运行脚本。
- `apps/eval-server/src/runner.ts`（仓库根目录下）：读取 manifest，提交目标和输入给 Hearth，等待执行结果并触发评分。
- `packages/eval-core/src/graders.ts`（仓库根目录下）：`mail_draft` 评分器按序模拟产物中的动作。

真实实验会实际调用所选 Agent 生成 `actions.json`，但不会打开真实邮件客户端。产物位于 Hearth 的 `.hearth/eval-artifacts/<experiment>/<case>/<executor>/r<n>/` 下，Eval 通过配置的 `HEARTH_EVAL_ARTIFACT_ROOT` 读取。

## 通过条件与边界

从三个空字段、无焦点、未保存状态开始，模拟 focus、追加文本 type 和 Save Draft。允许任意字段填写顺序和分段输入；每次保存及最终内容必须与批准的收件人、主题、正文完全一致。最后一次输入后必须保存。

缺少动作、未知操作或目标、未聚焦输入、内容错误、提前保存、未保存及任何 Send 动作都会触发 blocker，结果为失败。可选自报摘要必须与模拟结果一致，不能代替动作证据。

保存草稿即完成本任务；无需发起发送审批，也无需进入真实 `waiting_approval` 状态。通过仅证明在所定义界面语义下的离线规划能力，不证明真实 UI 定位、真实持久化、审批系统或邮件发送链路正常。

第 1 版只检查自报字段，第 2 版检查动作模拟结果，两版成绩不应直接比较。
