# Two languages (2026-10-16, branch `claude/i18n-bilingual`, not deployed)

> Moved verbatim from `CLAUDE.md` on 2026-11-04. Add new notes for this area here, not to `CLAUDE.md`.

The whole site switches between Chinese and English in one press. Rules, glossary and decisions are in `docs/i18n.md`.

**Translation layer**
- i18next (`packages/i18n`), with the Chinese sentence as the key: `t("待确认")`, `t("已完成 {{n}} 项", { n })`. English lives in `packages/i18n/locales/en/*.json`, one file per area. Chinese needs no catalogue.
- The language comes from the cookie `crossline-locale`, then the account setting `ui.locale`, then Chinese. It is carried as `AccessContext.locale`.
- Where code gets its translator:
  - client components: `useT()` (`app/locale-context.tsx`);
  - server code: `tOf(ctx)` (`lib/locale.ts`);
  - background work: `readLocale(store, ws)`;
  - core functions take an optional `locale` (omitted, they write the old Chinese).
- Label tables keep their Chinese values, because those may be compared or stored; they are translated where shown. One Chinese word with two English meanings uses a context: `t("关闭", { context: "act" })`.

**The guard** (`packages/i18n/src/catalog.test.ts`) is a discovery test over every source file. It fails on:
- Chinese JSX text or attributes;
- Chinese template strings with values;
- a Chinese literal with no English;
- a catalogue problem (empty, Chinese in the English, mismatched `{{values}}`, two Englishes for one key, stale keys).

Text that is not interface (model prompts, patterns matched against what the person or a model wrote, stored markers) is marked `// i18n-ignore`.

**What stays in its own language**
- What the person or a model wrote stays as written.
- New model output follows the workspace's language (`packages/codex/src/style.ts`).
- The interview keeps the language it started in (`lockInterviewLocale`).

**Lengths**
- English runs get output-schema string limits widened 2.5× (`schemaForLocale`).
- Code-side limits use `textWidth` (`packages/core/src/text-width.ts`): unchanged for any text containing Chinese.

**Heuristics that read the person's or a model's words** (external action, the person's call, trivial steps, question kinds, answer lines, task merging, course codes…) read both languages. Each has a test in both.

**Quick test** (`apps/assess`)
- Has its own switch, which keeps answers across the reload.
- Its 32 statements are rewritten for English readers.
- Posters and pair cards render in the viewer's language, cached per language.
- The result email goes in the language of submission, stored in `results.locale`.
