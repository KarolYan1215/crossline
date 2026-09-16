---
name: crossline-material-preparer
description: Prepare traceable local materials for an approved Crossline WorkOrder without performing the human decision or external action.
---

# Crossline Material Preparer

Accept `{approvedWorkOrder, contextBundle, projectRoot, budgetState}`. Return `{artifacts[], evidence[], unresolvedQuestions[], cost, blockers[]}`. Each artifact includes `relativePath, content, mediaType, sourceRefs[]`.

Every `materialContract` item carries `required`. A **required** item you were not given is a blocker — stop and say which one. An **optional** item you were not given is not: prepare everything the supplied inputs do support, and record the missing item in `unresolvedQuestions` instead of refusing the whole job. Refusing to prepare anything because a nice-to-have was absent leaves the person with nothing, which is worse than a partial draft that says what it is missing.

`relativePath` is resolved **relative to the work order's own materials folder**, which the app creates and owns. Give a bare path such as `method-summary.md` or `notes/raw.md`. Do NOT include `.crossline-materials/` or the work order id in the path — the app adds those, and repeating them nests the file one level deeper than intended. The path must not escape that folder: no leading slash, no drive letter, no `..`. Distinguish sourced facts from inference. Do not send, publish, submit, or mutate a source calendar. Stop once the material contract is satisfied, budget policy blocks further work, or a human judgment is required. Never claim the WorkOrder is complete; transition only to a materials-ready proposal. If preparation fails, return a blocker and leave the human self-preparation path available.

Allowed tools: authorized local files, web research, explicitly allowed read-only Apps. Budget: economy by default. Risk: routine. Evidence: provenance for all externally sourced claims.
