# Filming Readiness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final fail-closed runtime gaps on merged `main` and leave the meadow scene verified for filming.

**Architecture:** Preserve the existing sole-writer queues and signed command boundaries. Tighten validation at the earliest trusted boundary, then prove each rejection and race behavior with focused tests before running the complete suite and production validators.

**Tech Stack:** Node.js ESM, `node:test`, Mineflayer-compatible actor adapters, YAML production manifests.

## Global Constraints

- Keep the six visible meadow beats and twelve authored lines unchanged.
- Do not start a live recording until all automated and CLI checks pass.
- Fail closed on identity, authorization, schema, timeout, or delivery ambiguity.

---

### Task 1: Pre-start coordinator cancellation

**Files:**
- Modify: `src/showrunner/survival-coordinator.mjs`
- Test: `test/showrunner-state-machine.test.mjs`

**Interfaces:**
- Consumes: `cancel(attemptId)` from the showrunner cleanup path.
- Produces: idempotent cancellation for an idle coordinator before its first `start()`.

- [ ] Add a failing preparation-error regression that reaches cleanup before coordinator start.
- [ ] Verify it fails with an attempt/coordinator cancellation error.
- [ ] Make idle cancellation an authoritative no-work cleanup without weakening active-attempt identity checks.
- [ ] Run the focused state-machine test.

### Task 2: Nested observation identity

**Files:**
- Modify: `src/showrunner/survival-coordinator.mjs`
- Test: `test/showrunner-survival-coordinator.test.mjs`

**Interfaces:**
- Consumes: signed observation proof and its nested `after` snapshot.
- Produces: planner observations whose actor, goal, attempt, and version agree at both levels.

- [ ] Add wrong-actor and stale nested-identity failing tests.
- [ ] Verify both reach the coordinator but are rejected.
- [ ] Validate nested identity before promoting `proof.after`.
- [ ] Run the focused coordinator tests.

### Task 3: Spoken-line authorization binding

**Files:**
- Modify: `src/showrunner/actor-runtime.mjs`
- Test: `test/showrunner-actor-runtime.test.mjs`

**Interfaces:**
- Consumes: `payload.authoredLineId` and signed authorization.
- Produces: speech only when the authored line identifier matches the signed receipt.

- [ ] Add a failing mismatched-authored-line test that proves chat currently occurs.
- [ ] Verify the expected failure.
- [ ] Bind `authoredLineId` in `verifyLineAuthorization` before `bot.chat()`.
- [ ] Run the focused actor-runtime test.

### Task 4: Constructed-input composition validation

**Files:**
- Modify: `src/showrunner/episode-composition.mjs`
- Modify: `src/showrunner/state-machine.mjs`
- Test: `test/showrunner-state-machine.test.mjs`

**Interfaces:**
- Consumes: normalized or manually constructed showrunner and Survival episodes.
- Produces: identical supported schema versions and complete v1/v2 manifests before arming.

- [ ] Add failing unsupported-version, incomplete-v1, and non-six-beat-v2 tests.
- [ ] Verify each bypasses current arming validation.
- [ ] Enforce explicit schema and complete composition invariants at arming.
- [ ] Run focused schema/state-machine tests.

### Task 5: Integer operation budgets

**Files:**
- Modify: `src/showrunner/survival-coordinator.mjs`
- Test: `test/showrunner-survival-coordinator.test.mjs`

**Interfaces:**
- Consumes: fractional monotonic clock values.
- Produces: a positive safe-integer remaining budget never larger than the authored deadline.

- [ ] Add a fractional-clock failing regression.
- [ ] Verify the command carries a fractional budget.
- [ ] Floor and clamp the remaining budget before actor delivery.
- [ ] Run the focused coordinator test.

### Task 6: Serialized outbound delivery failure

**Files:**
- Modify: `src/showrunner/survival-coordinator.mjs`
- Test: `test/showrunner-survival-coordinator.test.mjs`

**Interfaces:**
- Consumes: asynchronous `emit()` rejection and concurrent actor events.
- Produces: a queued terminal delivery-failure transition that fences subsequent events.

- [ ] Add a failing race regression with an in-flight actor event.
- [ ] Verify state mutates outside the queue today.
- [ ] Re-enter the sole-writer queue for delivery failure and reject later actor progress.
- [ ] Run the focused coordinator test.

### Task 7: Filming gate

**Files:**
- Modify: `docs/showrunner-operations.md`

**Interfaces:**
- Consumes: hardened runtime and production episode pair.
- Produces: a verified filming runbook and current readiness result.

- [ ] Run `node --test test/*.test.mjs` and require zero failures.
- [ ] Run both meadow CLI validations and require valid cross-file composition.
- [ ] Run `git diff --check`.
- [ ] Document the preflight commands and the remaining live-server validation step.
- [ ] Commit the filming-readiness hardening on `main`.
