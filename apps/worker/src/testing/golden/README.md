# 本人的纠正 → 评测样例

`scripts/golden-from-corrections.ts` 从**账本副本**（备份恢复出来的库，不是正在用的账本）抽出本人的纠正，每类一个文件：

| 文件 | 来源事件 | modelSaid → personSaid |
|---|---|---|
| `undo.json` | `op.undone`（配 `op.applied`） | 撤销的操作（`inverse`）→ `undone`；`bySystem` 标出系统自己做的 |
| `gate.json` | `gate.overridden`（配 `gate.judged`） | 关口判定与理由 → 本人改成的判定 |
| `duration.json` | `estimate.adjusted` | 原估时 → 本人改的分钟数 |
| `date.json` | `work_order.due_changed` | 原截止日 → 本人改的日期 |
| `reject.json` | `approval.declined`、`goal.backplan_declined`、`insight.rejected`、`skill.*rejected` 等 | `proposed` → `rejected` |
| `rename.json` | `task.renamed`（不含系统自己的改名） | 原标题 → 新标题 |
| `completion.json` | 任务上的 `payload.completionMode` | 模型的 `completion.mode`（没有为 `null`）→ 本人选的 |

**这些文件含个人数据，被 gitignore，不提交。** 只提交本说明和虚构的 `example-*.json`（`scripts/eval-lib.test.ts` 用它）。

```powershell
pnpm exec tsx scripts/golden-from-corrections.ts C:\path\to\restored\crossline.db
pnpm exec tsx scripts/ablate.ts --rule completion.legacy-title
```
