# Catalog v1（只读归档）

`cases/` 保存 2026-11-17 之前的 60 题基线，仅用于历史回归和评分口径对照。

- 不接受新增或修改；活动任务请写入 `eval/catalog/v2/cases/`。
- 旧分布固定为：email 8、calendar 7、documents 9、research 8、code 8、web 8、desktop 5、cross-app 7。
- `node.test.ts`、`e01.test.ts` 与 `desk02.test.ts` 仍会读取本目录验证归档完整性。
- 旧 case 使用 `schemaVersion: 1`，不参与 v2 的 60/30/10 与独立门禁质量门禁。
