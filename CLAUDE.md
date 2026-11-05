# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Crossline (跨人生主线执行看板) — a local-first execution board that unifies tasks and evidence across multiple "identities" (研究/科研, 创业, 自媒体, 投资) sharing one task/evidence ledger, with health treated as a capacity constraint rather than a competing identity. Everything runs on one machine against a local SQLite ledger; there is currently no live external write path (see Safety boundaries below). UI copy and commit-facing text in this repo are in Chinese.

Current closed loop (per README): natural-language capture → system infers identity + duration bucket → a `WorkOrder` is generated → next-action recommendation → one calendar (day / week / month) with the plan's differences folded under it, approved as a batch → manual completion submission → evidence acceptance on the approvals page. Plan versions, recurring milestone relations, state transitions, and approval events are written to local SQLite WAL — not static frontend data.

## Commands

Run from the repo root (pnpm workspace, Node >=22, pnpm 12.6.0):

```powershell
pnpm install
pnpm dev              # starts @crossline/web (Next.js) on http://127.0.0.1:3210
pnpm worker           # starts @crossline/worker in watch mode
pnpm test             # vitest run, across packages/**/*.test.ts and apps/**/*.test.{ts,tsx}
pnpm test:watch       # vitest watch mode
pnpm test:e2e         # playwright test (visual regression + flow coverage, see e2e/)
pnpm typecheck        # tsc --noEmit in every workspace package (pnpm -r typecheck)
pnpm build            # next build for @crossline/web
pnpm verify           # typecheck + test + build + e2e, the one command before a commit
pnpm doctor:ledger    # ledger health: orphan rows, half-migrations, retired tables, WAL size
                      # (not `pnpm doctor` — that is pnpm's own built-in and shadows the script)
```

Single test file / single package:

```powershell
pnpm vitest run packages/planner/src/planner.test.ts
pnpm --filter @crossline/db typecheck
pnpm exec playwright test e2e/crossline.spec.ts
```

Worker one-shot run (used for smoke checks — ticks once and exits instead of looping):

```powershell
$env:CROSSLINE_RUN_ONCE='1'; pnpm worker:start
```

Export a full ledger snapshot to JSON:

```powershell
pnpm export -- C:\path\to\crossline.json
```

Rebuild a database from a snapshot (never writes to the live ledger; target must not already exist):

```powershell
pnpm restore -- C:\path\to\crossline.json C:\path\to\target.db
```

Codex app-server contract smoke test (pins against the commit recorded in `codex-baseline.json`):

```powershell
pnpm exec tsx scripts\codex-smoke.ts
```

Production start / scheduled-task install / backup / restore are PowerShell scripts under `scripts/` — see `docs/claude/operational-scripts.md`. Do not run `install-startup.ps1` unless the user explicitly asks; it registers a Windows Scheduled Task.

## Area docs (read before working in that area)

These used to be inline here; they were moved to keep every session's context small. Read the matching file before changing code in that area.

- `docs/claude/architecture.md` — Workspace layout, data flow, event-sourced ledger and migrations (`packages/db`), capture, work orders, approval policy, the one calendar, freezes/locks, completion check, calendar sources
- `docs/claude/two-languages.md` — Bilingual UI (branch `claude/i18n-bilingual`, not deployed)
- `docs/claude/identity-and-deployment.md` — Two databases/schemas, accounts and sessions, outgoing mail, Sign in with ChatGPT, removing the hardcoded identity, installed tester copy
- `docs/claude/profile-first-loop.md` — Onboarding interview, portrait, long runs, dates from files, milestones, web research, recordings, worker per-workspace jobs, fixed events
- `docs/claude/interface-and-model-routing.md` — Typeface and views, model routing, owner/effects, 小助手, notifications, calibration, asks, walkthrough-driven UI changes
- `docs/claude/flywheel-and-views.md` — Flywheel and views summary (full record: `docs/flywheel-and-views.md`)
- `docs/claude/personal-agent.md` — Tools mode, mailbox (IMAP), automations, output folder, sandboxed shell, asking mid-run, supervisor `services`
- `docs/claude/skill-library.md` — Line skills, public skills, grown workflows, favourites by topic, workflow self-revision and merging, account-reading workflows, Settings → Skill 库
- `docs/claude/opportunity-discovery.md` — Opportunity agent track A: needs, sources, eligibility, morning brief, offer card
- `docs/claude/opportunity-time-space.md` — Opportunity agent track ②: the time–space engine
- `docs/claude/domain-lines.md` — Lite edition: domain lines and records
- `docs/claude/registration-forms.md` — Registration forms (2026-11-01)
- `docs/claude/voice-input.md` — Voice input (2026-11-02)
- `docs/claude/release-gates.md` — Release gate status (from README; update as gates change)
- `docs/claude/operational-scripts.md` — What each script in `scripts/` does
- `docs/claude/walkthrough-fixes.md` — What the 2026-10-18, 2026-10-21 and 2026-10-29 walkthrough fixes changed (W-1–W-42, W-97–W-101, W-155–W-158)

**Do not append implementation records to this file.** It is loaded into every session and every subagent. Put the record of a change in the matching `docs/claude/*.md` (or the area's doc under `docs/`) and in the commit message; add a line here only for a rule every session in the repo must follow. When a merge conflicts on `CLAUDE.md` because the other side appended to a section that now lives in `docs/claude/`, move that addition into the matching file.

## End-to-end tests

`e2e/crossline.spec.ts` (Playwright, config at `playwright.config.ts`) drives a **production build** (`next build --webpack` then `next start`) on port 3310 (3211 belongs to the resident worker's Codex supervisor) with its own temp data dir (`CROSSLINE_DATA_DIR` under the OS temp dir, keyed by PID) and `CROSSLINE_NEXT_DIR=.next-e2e` so it never collides with the port-3210 dev server or its `.next` build. A production build rather than `next dev`, because `next.config.mjs` disables Serwist in development — the offline claim had no service worker to test against and could not have been verified here no matter what a test asserted. The offline test cuts the network and **first proves the cut** with a `fetch("/api/health")` that must fail, then reloads and asserts the page still renders; without that probe a passing test shows only a warm cache. The data dir is stashed in `CROSSLINE_E2E_DATA_DIR` so test workers (separate processes, different PIDs) can open the same ledger the server did — the C-lens tests write their own pending diffs into it, because the seeded example diffs no longer exist. `CROSSLINE_FIXED_NOW` pins the clock so visual-regression PNGs (`e2e/crossline.spec.ts-snapshots/`) are reproducible. Runs `desktop-chrome` and `mobile-chrome` (Pixel 7) projects, `colorScheme: "light"`, `fullyParallel: false`. When intentionally changing layout, regenerate snapshots with `pnpm exec playwright test --update-snapshots` rather than hand-editing the PNGs. The two screenshots hide (`visibility:hidden`, so layout is kept) the pending badge and everything the scheduler produced — `STABLE_FOR_SCREENSHOT` in the spec — because the badge's count depends on what parallel tests have written and the scheduler's block lengths come from a time-limited solve that gives a different feasible answer on a busy machine; before that, the baselines passed or failed by run. The planner also rounds the solver's continuous minutes with a `+1e-6` so a half minute is not 25 on one run and 26 on the next. Desktop and phone runs share one ledger and their order varies between runs, so a test that needs a state writes it itself (`ensureOwnNextStep` for the phone's Today hero: once the desktop tests have written work of the person's own, the demo orders are no longer recommended). Off Windows `scripts/run-e2e.ts` starts the server in its own process group and stops the whole group: `next start` forks a `next-server` child that outlived the parent on 3310 and failed every later run with EADDRINUSE. Visual baselines are per platform (`-linux.png` / `-win32.png`); a layout change needs both regenerated.

## Safety boundaries (do not casually change)

These constraints are enforced in code, not just docs — read the relevant source before loosening any of them:

- Microsoft Graph writes only ever target a calendar/list literally named `Crossline`; `connectorWritePolicy` returns `"read_only"` for everything else. The schedule is written by default (no plan approval since 2026-10-12, `write_focus_block` is `automatic`); the boundary is the writer's: only the Crossline calendar, only events this app made and the person has not changed, deletes only in the future, preview and pencilled-in blocks never.
- UW Outlook and Google Calendar are read-only, imported only via the official Codex plugin (not implemented in this repo's connectors).
- Longbridge (`longbridgeToolAllowed`) permits only market-data/reference tools — no account or order-placement tools.
- `content-ops` only accepts idempotent `POST /v1/jobs` and reads real terminal state via authenticated `GET /v1/jobs/{id}`.
- No real Graph OAuth, outreach, publishing, or trading is currently wired up — `requiredApproval` returns `"never"` for `broker_order` and `silent_source_calendar_write` by design.
- **The camera.** The one camera path is the person's decision of 2026-10-14 (`docs/energy-and-ecosystem.md` §8).
  - Its scope: desktop only, its own consent (`energy.camera`) off by default, frames processed in the page and never stored or sent.
  - The energy API accepts from it only the five numeric `camera_aggregate` fields, and refuses them without consent (`CAMERA_NOT_ENABLED`).
  - Everything else stays refused: the old `camera_proxy` (`CAMERA_ENERGY_PATH_REMOVED`), raw media and unknown fields (`RAW_MEDIA_OR_UNKNOWN_FIELD_FORBIDDEN`), non-aggregate features (`AGGREGATE_FEATURES_ONLY`).
  - Widening any of it — phone camera, keeping frames, sending landmarks, sampling with the page in the background — requires another explicit decision, not a refactor.
- **The microphone.** The one microphone path in the web app is voice input, the person's decision of 2026-11-02 (`docs/voice-input.md`).
  - It opens only on the person's own press of a box's microphone, after a first-use notice per engine, and closes when the dictation ends (3 minutes at most); Settings → 通用 turns it off everywhere.
  - With the browser's engine the audio goes to the browser's vendor, never to Crossline. With Crossline's engine the clip goes to the person's own worker (the hosted server's transcriber or this computer), is deleted as soon as it is read, is never stored, logged, backed up or handed to a model; only the text is.
  - Widening it — keeping audio, listening without a press, sending audio anywhere else, using it for anything but filling the box — requires another explicit decision, not a refactor.

- **The device location** (track ② of docs/opportunity-agent.md §17.9, 2026-11-02). Its own consent (`location.device.consent`, Settings → 时间与提醒 「设备位置」), off by default. A position is taken only when the person presses the button, rounded to two decimals (about 1 km), only the latest kept (`location.device`), never a track; turning it off deletes it, and `/api/location/device` refuses without the consent (`DEVICE_LOCATION_NOT_ENABLED`). The worker sends only that rounded point to Nominatim for a city name. Widening it — background or repeated sampling, more precision, history — needs another explicit decision.
- **Nominatim is an outbound read path from the worker** (`nominatim.openstreetmap.org`, `apps/worker/src/geo.ts`): city or venue names and rounded points only, never a street address, one request a second, an identifying User-Agent, every answer cached in the ledger.
- The one outbound path the notifications have is Web Push to the person's own subscribed devices (chosen 2026-10-07): end-to-end encrypted for the device, posted only to known push services. It carries notification text, nothing else.
- **Registration forms are the one path that writes to a third-party site, and its boundary is the person's (docs/opportunity-agent.md §0, §10, §13; 2026-11-01).** Rules in `packages/core/src/form-fill.ts`, the engine in `apps/worker/src/form-engine.ts`, the browser in `form-browser.ts`, the queue in `form-service.ts`.
  - Machine owner only (`runtimeOwner`), only after the person pressed 报名/申请 on an offer card (`decision.by: "person"`), only on a computer with a screen (`FORM_NEEDS_SCREEN` otherwise), in a visible window of Crossline's own per-site profile (`browser-profiles/<ws>/forms/<host>`, held with `profile-locks` kind `fill`), never the person's everyday browser.
  - The browser navigates only to the opportunity's `registrationHost` and its known aliases (lu.ma ↔ luma.com); popups are closed, downloads off, private addresses refused, every refusal recorded as `opportunity.form.blocked`. An opportunity page off that host is refused before anything opens. No script of ours runs in the page.
  - A model only proposes (`crossline-form-filler`, from the ariaSnapshot with sensitive values redacted); `judgeAction` decides every action: profile data only from the profile (a typed email, phone or link is refused), long answers only from approved drafts, consents only those the offer card listed, never marketing or public-listing boxes, never follow/share/invite, never a link off the page; payment, login, captcha, ID upload, a missing item or an essay stops and hands the window to the person.
  - Submitting by itself only under `autoSubmitProblems` = [] (a free event, cost verified 0 with a quote, every field from the profile and read back, no upload/draft/literal, last page, no price, no error, `crossline-form-checker` passed on the list alone). Everything else stops at the submit button with the checklist and screenshots; anything not plainly 「next」 counts as the submission.
  - Sensitive profile items (phone, birth date, student id, address, id and passport numbers) live only in the worker's secret store (`apply-<slot>`); the ledger keeps only that one is held (`apply.sensitive`). They never reach a model, a log, the checklist, a screenshot (masked) or an event; read-back compares them by hash.
  - A fallback engine only proposes actions, which the engine judges and does itself: it never turns a page, submits or sees a sensitive value. Neither Stagehand nor browser-use connects to the person's browser or runs a script in the real page; the only DevTools port opened is the throwaway shadow browser's, on 127.0.0.1, for one run. browser-use is never downloaded without the person's press.
  - Never submit a real site's form while developing or testing; a real submission (§14 standard 3) needs the person to name the event and confirm first.

If a change would add or enable a real external write path (Graph OAuth, publishing, trading, outreach) or would let raw camera/media data leave the browser, flag it explicitly — these are deliberate, currently-unimplemented boundaries per the project README, not oversights.

## Notes

- Before walking the live beta as a tester (app.crossline.lol / test.crossline.lol), read `docs/walkthrough-ledger.md`: walk only paths it does not list or that changed since, and record paths and findings there in the same change.
- Documentation lives in `docs/` (index: `docs/README.md`); superseded design and acceptance records are in `docs/archive/`. Update the current docs in the same change as the code instead of adding a new file.
- `apps/web/CLAUDE.md` is auto-generated by `next dev` (see `node_modules/next/dist/server/lib/generate-agent-files.js`) and just points at `apps/web/AGENTS.md`, which itself is regenerated boilerplate about the current Next.js version. Don't hand-edit either; regenerating them is expected and safe to commit.
- Local dev DB files (`*.db`, `*.db-shm`, `*.db-wal`, `data/`, `backups/`) and `.env*` (except `.env.example`) are gitignored — never commit these. `apps/web/data-e2e/` (the e2e Playwright data dir) and `apps/web/.next-e2e/` fall under the same `.next*`/`*.db*` ignore patterns.
- `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` for the whole workspace; per-package `tsconfig.json` files extend it.
- **Cloud sessions** (Claude Code on the web, Linux): `.claude/hooks/session-start.sh` runs on SessionStart only when `CLAUDE_CODE_REMOTE=true` and installs what a fresh clone lacks — `node-gyp` (better-sqlite3 compiles from source and pnpm no longer bundles it), `libsecret-1-0` (keytar loads it at import, so every connector test failed to load without it) and `pnpm install`. `allowBuilds` must name every build script explicitly: pnpm 12 refuses the install (`ERR_PNPM_IGNORED_BUILDS`) on a placeholder; `onnxruntime-node` and `protobufjs` are `false` because their scripts only fetch optional GPU binaries or print a version warning. `.claude/settings.json` declares the `ponytail` and `superpowers-marketplace` plugin marketplaces — an enabled plugin with no declared marketplace cannot be installed in a cloud session. Tests that take a `platform` argument must use that platform's path rules (`path.win32`/`path.posix`), not the host's.
- `pnpm verify` = typecheck + test + build + e2e, and `.git/hooks/pre-commit` runs the first two. GitHub Actions: `ci.yml` (Linux, typecheck + test) runs on every push; `images.yml` builds the hosted beta's images only after CI passed on a `main` commit, and `server.yml` deploys them (2026-11-05, `docs/hosted-hardening.md` §2). `verify.yml` was removed: GitHub left its registration `deleted` and it could not be enabled again; its Codex-fork provenance check is run by hand (`scripts/verify-codex-fork.ts`). `server.yml` writes nothing to the job log (the repository is public): read a run with `sh scripts/ops-log.sh <run id>`.
- `packages/db` tests write temp databases into the repo root, and the migration runner's forced backup means each also leaves a `<name>.db.v0.bak`. `*.bak` is gitignored and the test cleanups delete it — thirteen of them reached a commit before that line existed.
- `apps/worker/src/testing/` holds the one shared Codex fake (two drifted copies used to disagree, and one of them miscounted thread ids) plus the recorded-response fixtures. Setting `CROSSLINE_RECORD_DIR` captures a real model answer to disk, rejected ones included; dropping it in `testing/fixtures/` replays that degenerate output through the full worker → validator → store path instead of testing it only as a pure function. Every newly found defect should leave a fixture behind.

## What is deliberately *not* ours to build

Audited against the vendored runtime (`vendor/codex`, rust-v0.155.0; rechecked for rust-v0.163.0 in `docs/codex-upgrade-0.163.md`, which also says why read-only tool parallelism, hooks and restored permissions on resume do not replace our code yet). Codex already provides, and we use rather than reimplement (an inventory on 2026-10-19 found 19 of its 167 client methods in use): thread persistence/resume/unsubscribe, its automatic compaction and explicit compaction (`thread/compact/start`, since 2026-10-20), `outputSchema` structured output, per-turn model and effort, `thread/tokenUsage/updated`, `account/rateLimits/read`, `model/list`, login flows, web search modes, dynamic tools, code mode, ChatGPT connectors (read-only), the plan tool, memories, image generation, plugins and skills, and sandbox profiles. It also offers, unused for the reasons in `docs/claude/personal-agent.md`: fork, goals with token budgets, subagents for the tools mode, mid-run questions, review, hooks, `account/usage/read` and image input. It does **not** provide, so we own: per-skill model/effort/schema (SKILL.md frontmatter only honours `name`/`description`), scheduling, PDF/docx extraction or OCR, batch audio transcription, a hard spend cap, and verification of what a model claims (quotes, URLs, DAGs, approvals). Before writing a script that wraps the model, check this list; the deterministic validators stay, the "ask the model to do it" scripts do not. Removed on this pass as having no caller: the orchestration skill, `validateMaterialPreparation`, the Graph/Longbridge/ContentOps connector classes were **kept** (Gate 3/5 roadmap) but flagged unwired, `readCodexAccount`/`startCodexChatGptLogin`, `readTailscaleIdentity`, `addCapturedTask`, `interviewQuestions`, `skipRecurringWorkOrder`/`tombstoneWorkOrder`/`notificationForTransition`, `normalizeCodexEvent`/`buildContextBundle`, three one-off scripts, and 91 CSS selectors of deleted components.

## Agent skills

### Issue tracker

GitHub: `KarolYan1215/crossline` via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
