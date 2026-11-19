# 评分器校准 v1

外部评测的文字模式与结构化模式共享 `evaluateSubmission → evaluateChecks → runGrader`，最后一个检查器与实验评测共用。实验仍采用原有 60/30/10 综合策略；本轮没有改写模型裁判或实验总分。

- 文字模式：等权关键词检查，仍兼容 Codex Hook、CLI 和历史记录，不代表任务完成。
- 结构化模式：`checks` 数组替代 `requiredText`（二者不可同时使用）。所有提交以 `output.txt` 为逻辑路径，不依赖上传文件名。支持 file/text/json/csv/state/mail_draft；不接受轨迹、产物数量或正则规则。
- 每项含 id、title、config，可选 weight（默认 1）、blocker（默认 false）。配置随批次保存，提交时不可替换。
- 通过项权重 / 总权重 × 100 得到整数分。全部检查通过才判定 pass；任一 blocker 失败则总分为 0。分数与通过结论分别展示。
- 未收集到产物为 unknown；非法规则或检查器异常为 grader_error；格式损坏的 JSON 为 fail。未知或错误时不生成总分，除非已有确定的 blocker 失败。
- JSON 状态只是对提交字段的核验，不能证明测试实际运行或邮件实际未发送。真实执行证明需要后续接入独立测试结果、服务回执或可信轨迹。

## 运行与查看

在“外部 Agent 评测 → 评分器校准”查看每个规则集的统计和全部样本依据。

```sh
npm run eval:calibrate
npm run eval:calibrate -- /absolute/path/to/human-reviewed.json
```

命令输出 JSON；数据集格式错误退出非零。误判本身作为报告数据展示，不自动视为命令故障（旧文字基线特意保留已知误判）。网页默认读取本目录的 seed-v1.json。

## 种子集与人工确认

seed-v1.json 包含 18 条正例、反例、边界和对抗样本，是开发者编写的校准种子，**尚未经人工确认**。旧文字基线会暴露否定句误放过与同义表达误拒绝；结构化样本检查字段合同，不宣称测出 Agent 的真实成功率。不同规则集的难度和目标不同，不能把这些小样本结果当作新旧模式的公平性能比较。

人工复核时逐条检查 text、expected、rationale。建议两人独立标注并解决分歧，另留未参与调规则的留出集。完成后复制成新版本，更新 version、labelStatus 为 human_reviewed，并填写 reviewedBy。不要修改旧版标签后继续沿用旧版本号。

新增样本必须指定现有 ruleSetId、唯一 id、类别、预期 pass/fail 和理由。规则 ID 唯一。规则须来源于任务验收要求，而不是为了凑高校准分。

## 统计口径

- 误放过率：预期 fail 实际 pass / 全部预期 fail。
- 误拒绝率：预期 pass 实际 fail / 全部预期 pass。
- 可判定覆盖率：(pass + fail) / 全部样本。
- 准确率：与预期一致 / 全部样本；unknown 和 grader_error 不算正确，并单独计数。
- 分母为零返回 null，不报 0% 或 100%。分组按规则集统计，报告保留逐样本结果、原因及评分器版本 checks-v1。

后续先补充实际失败案例和盲标留出集，再评估模型裁判准确性与评分阈值；不要将种子集通过当作线上准确率保证。
