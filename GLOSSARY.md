# Crossline

A local-first execution board that unifies a person's tasks and evidence across their identities and lines of work.

## Language

**Capture**:
Something the person has said they want done, before it has been analysed. Becomes a WorkOrder only when analysis produces a proposal.
_Avoid_: Task, ticket

**WorkOrder**:
The unit of executable work. Carries its own evidence contract and moves from proposal through execution to acceptance.
_Avoid_: Task, job

**Accepted**:
A WorkOrder whose own evidence contract has been judged met. Says nothing about whether any Milestone is achieved.
_Avoid_: Done, complete

**Milestone**:
A dated, concrete event the person must reach (an exam with a score, a submission, a reply). Its progress is recorded separately from WorkOrder acceptance.
_Avoid_: Goal

**Discard**:
Removing a Capture that never became a WorkOrder.
_Avoid_: Delete, archive

**Archive**:
Withdrawing a WorkOrder, with a reason. Archived work leaves the board and stays in the ledger.
_Avoid_: Discard, delete

**Domain line**:
A line that covers a part of life every person has (health, money) rather than a calling of their own. Carries a fixed interview checklist, milestone templates and records; at most one per domain.
_Avoid_: Mode, edition, capacity

**Record**:
One real event a domain line keeps — a payment, a salary, a workout, a weight — stated by the person or one of their devices and checked by code, never a model's estimate.
_Avoid_: Log, entry, transaction
