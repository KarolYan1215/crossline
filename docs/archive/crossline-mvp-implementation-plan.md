# Crossline personal MVP execution plan

> **归档文档**：v1 的个人 MVP 执行计划，其中与 v2 冲突的部分已作废。 当前文档索引见 [docs/README.md](../README.md)。


## Authority

This execution plan applies the user-approved redesign together with
`docs/archive/crossline-plan-critical-review.md`. The review governs where the original
plan over-claimed certainty.

## Global constraints

- Work in `C:\Users\karol\Documents\ChatGPT\Multi-ID` on the existing
  `codex/crossline-mvp` branch. Do not commit, push, publish, or delete user data.
- Local single-user MVP; every aggregate still carries `ownerId` and
  `workspaceId`.
- No silent regex/default substitute for an unavailable or invalid AI result.
  Manual mode is allowed only when explicitly labelled and audited.
- Known runtime, permission, timeout, refusal, schema and policy failures become
  typed blockers and cannot advance formal state.
- Plan changes require batch approval. Every email, publish, submit or other
  external side effect requires item-level approval. Trading remains forbidden.
- Health is a capacity policy, never an identity. Capture asks for natural
  language only; time estimates come from labelled priors and observed history.
- UI may display only database facts, connector facts, explicit priors or
  unknown states. No simulated KPI, evidence, connector health or precision.
- Codex uses an isolated home under `%LOCALAPPDATA%\Crossline\codex-home` and a
  fixed, measured runtime contract. Start without a Codex fork.
- Use TDD for behavior changes. Required final commands are `pnpm test`,
  `pnpm typecheck`, `pnpm build`, and `pnpm test:e2e`.

## Task 1: Make Codex authentication and sidecar lifetime durable

Move app-server ownership out of a Next request lifetime into the Windows
worker (or the smallest equivalent long-lived supervisor), expose loopback-only
status/login/cancel operations to the Web app, consume login completion/update
notifications, and preserve the already completed isolated-home login. Add
focused tests proving a login request does not terminate the owning sidecar and
account state is read through the durable boundary. Record runtime version,
source baseline, generated-protocol hash and contract-test result without
claiming they correspond unless verified.

## Task 2: Implement one real AI analysis vertical slice

For one captured item, run the existing `crossline-automation-stripper` Skill
through Codex using a versioned context bundle and a strict output schema.
Validate the response at the trust boundary. Transition transactionally from
`captured` to `analyzing` to `awaiting_plan_approval`, or to a typed blocker.
Remove keyword identity guessing and minute defaults; an unavailable AI must
not create an analysed WorkOrder. Keep explicit manual capture available.

## Task 3: Close the human execution and evidence loop

Route every formal WorkOrder transition through the deterministic state
machine and one SQLite transaction that appends its event. Persist real
execution start/pause/complete intervals, interruption reasons, evidence claims
and human accept/block decisions. Remove the literal `manual_confirmation`
stand-in. Add API/UI paths sufficient to complete one real item end to end.

## Task 4: Remove false precision and the camera energy path

Delete simulated KPI, fake connector status, fake evidence and fixed progress
numbers from production pages. Replace them with real queries or explicit
unknown/blocker states. Remove the MediaPipe/camera sampling path and its
dependency. Represent capacity as `low | medium | high | uncalibrated` plus
confidence, observations and blockers; no medical inference or precise fatigue
score.

## Task 5: Learn duration from real execution data

Implement a labelled fallback chain: identity-pack prior, related task family,
then personal history. Store p25/p50/p85, source, observation count and
confidence. Update from actual execution while preserving interruption and
missing-input causes. Run estimates in shadow mode until there is enough local
evidence; do not silently move approved calendar blocks.

## Task 6: Add the next evidence-backed AI capability

Add material preparation first, because it directly precedes human core work.
Use a strict schema, authorized roots and real artifact references. Then add
evidence pre-review only as a proposal; humans accept milestones. Capture model,
usage/cost, artifacts, failures and blockers. Enforce the monthly budget gates.

## Task 7: Make offline commands and connectors truthful

Use IndexedDB for offline commands, preserve `clientCommandId` idempotency, and
replay on foreground as well as Background Sync. Terminal 4xx/schema failures
enter a visible dead-letter blocker rather than retrying forever. Implement
Graph/UW/Google read-only gates and ETag/delta conflict visibility before any
writeback; only the personal Crossline calendar and To Do list can later be
write targets.

## Task 8: Add evidence-bound milestone relations and review

Milestone relations may be cyclic and use `enables`, `reuses`, `informs`,
`constrains`, or `recurring_feedback`. Candidate relations store evidence,
counterexamples, cost and last validation time and never affect Today until
approved. Weekly insights propose versioned overlay patches; they never apply
automatically. Report system time/cost as observed data, not promised benefit.

## Task 9: Finish the personal operational surface

Complete the editorial Today/Plan/Milestones/Workbench/Approvals/Review/
Connections surface with one shared PlanVersion, accessible desktop/mobile
behavior, Windows worker autostart instructions, encrypted backup/restore
verification and audit export. Preserve the explicit approval boundaries.

## Task 10: Verify release gates

Run all local unit, integration, build and E2E checks; perform a real isolated
Codex analysis, one human execution/evidence/acceptance cycle, read-only
connector probes, offline replay, and backup restore drill. Report unmet gates
as blockers. Do not enable external writeback, publishing, sending or trading.
