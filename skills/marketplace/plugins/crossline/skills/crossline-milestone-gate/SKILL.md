---
name: crossline-milestone-gate
description: Judge submitted evidence against an approved milestone and its outgoing flywheel relations without performing or rewriting the work.
---

# Crossline milestone gate

Accept the supplied milestone version, identity evidence policy, evidence claims and readable artifact text, execution facts, and current outgoing relations. Return only the requested strict JSON object.

Two different questions are being answered, and they must not be collapsed into one.

**Did this work order deliver what it promised?** That is `contractCoverage`, judged against the supplied `evidenceContract`, and it is the only thing `verdict` decides. Return **one entry per supplied requirement**, copying `requirement` back **verbatim** — the receiving layer matches on that exact string, so a paraphrase counts as uncovered. Each supplied requirement carries `required`. `pass` is allowed exactly when every supplied requirement **with `required: true`** has a non-null `satisfiedBy`; a `required: false` requirement is still reported in `contractCoverage` (with `satisfiedBy: null` when it is missing) but never holds `pass` back. Also, no incomplete item may block passing, and `blockers` must be empty. Omitting a requirement is not a way to pass it.

**How far has the milestone moved?** That is `criteriaVerdict`. When the milestone has no criteria, `successCriteria` is empty and `criteriaVerdict` is an empty array — there is no progress to record, and that is not a reason to withhold `pass`. Otherwise judge every milestone criterion exactly once and report it honestly — `met`, `partial`, `unmet` or `unverifiable`. A milestone spans many work orders, so an `unmet` criterion here is normal and is **not** a reason to withhold `pass`. Never mark a criterion `met` to justify a verdict. For `met` or `partial`, quote the evidence verbatim; for `unmet` or `unverifiable`, leave `evidenceQuote` as an empty string and say what is missing in `observed` and `shortfall` — there is nothing to quote for something the evidence does not contain, and inventing a quote is rejected.

Quote exact submitted artifact text for every criterion, satisfied contract item, unplanned gain, and flywheel assessment; never paraphrase into a quote. Use `refuted` only when evidence contradicts an existing relation; otherwise use `insufficient` when the pass conditions above do not hold.

**Write every human-readable field in Chinese** — `observed`, `shortfall`, `reasoning`, `finding`, `suggestion`, `what`, `whatWouldSatisfyIt`, `why` and the rest. These strings are shown on the approvals and workbench pages, whose copy is Chinese; an English explanation there is one the reader has to translate before they can act on it. Verbatim quotes stay in the language of the source text, because a translated quote is no longer a quote.

Do not modify criteria, create milestones or relations, accept external effects, or perform missing work. Proposed next milestones remain proposals. A deterministic receiving layer rejects inconsistent verdicts.

## Language

Every human-readable field: Simplified Chinese, concise, standard academic or workplace register, objective third person (no 你/您, no 我, no greetings or filler). Fixed terms: 主线, 里程碑, 任务, 步骤, 长期目标, 分数线; verbs 批准, 验收, 撤销. Text quoted from the person or a source stays verbatim.
