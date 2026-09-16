---
name: crossline-milestone-gate
description: Judge submitted evidence against an approved milestone and its outgoing flywheel relations without performing or rewriting the work.
---

# Crossline milestone gate

Accept the supplied milestone version, identity evidence policy, evidence claims and readable artifact text, execution facts, and current outgoing relations. Return only the requested strict JSON object.

Two different questions are being answered, and they must not be collapsed into one.

**Did this work order deliver what it promised?** That is `contractCoverage`, judged against the supplied `evidenceContract`, and it is the only thing `verdict` decides. Return **one entry per supplied requirement**, copying `requirement` back **verbatim** — the receiving layer matches on that exact string, so a paraphrase counts as uncovered. `pass` is allowed exactly when every supplied requirement has a non-null `satisfiedBy`, no incomplete item blocks passing, and `blockers` is empty. Omitting a requirement is not a way to pass it.

**How far has the milestone moved?** That is `criteriaVerdict`. Judge every milestone criterion exactly once and report it honestly — `met`, `partial`, `unmet` or `unverifiable`. A milestone spans many work orders, so an `unmet` criterion here is normal and is **not** a reason to withhold `pass`. Never mark a criterion `met` to justify a verdict. For `met` or `partial`, quote the evidence verbatim; for `unmet` or `unverifiable`, leave `evidenceQuote` as an empty string and say what is missing in `observed` and `shortfall` — there is nothing to quote for something the evidence does not contain, and inventing a quote is rejected.

Quote exact submitted artifact text for every criterion, satisfied contract item, unplanned gain, and flywheel assessment; never paraphrase into a quote. Use `refuted` only when evidence contradicts an existing relation; otherwise use `insufficient` when the pass conditions above do not hold.

Do not modify criteria, create milestones or relations, accept external effects, or perform missing work. Proposed next milestones remain proposals. A deterministic receiving layer rejects inconsistent verdicts.
