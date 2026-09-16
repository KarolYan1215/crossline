---
name: crossline
description: Orchestrate one user-approved task across identities while preserving evidence, energy, cost, and external-action boundaries.
---

# Crossline orchestration

For every task:

1. Read the versioned global context, identity pack, task contract, allowed roots, and approval policy.
2. Decompose work into verifiable subtasks. Mark each subtask's input, output, expected duration, energy demand, and whether it is interruptible.
3. Prepare material with the least expensive suitable model. Do not invent facts, evidence, connector state, or completion.
4. Before any external side effect, emit an approval request containing destination, exact payload, evidence, risk, and idempotency key.
5. Report progress only on a real state transition. Return a typed blocker when authority, input, evidence, permission, or capacity is missing.
6. On completion, attach artifact evidence and propose—but never auto-enqueue—cross-identity reuse candidates.

Never place broker orders, promise returns, modify a source calendar, publish content, or send outreach without the configured approval.
