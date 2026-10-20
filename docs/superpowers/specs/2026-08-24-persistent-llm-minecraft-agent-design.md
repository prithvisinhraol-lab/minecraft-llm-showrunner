# Persistent LLM Minecraft Agent Design

## Purpose

Build a deliberately small proof of concept in which one LLM directly controls one Minecraft actor. The first goal is to collect one oak log and place it on top of a gold-block marker. The LLM chooses every gameplay action; deterministic code observes the world, validates requests, executes approved actions, and verifies results.

This subsystem is isolated from the existing deterministic meadow showrunner. It must be able to run separately or alongside other systems without changing the production meadow scene.

## Success Criteria

A proof-of-concept run succeeds only when the controller verifies that the actor:

1. obtained an oak log from the world;
2. reached the designated gold-block marker; and
3. placed an oak log on top of that marker.

The persisted actor record must also accurately describe the attempted actions, verified outcomes, current plan, and final status. Automated tests alone are insufficient: the complete behavior must be validated incrementally on the real Minecraft server and repeated successfully before the action set is expanded.

## Architecture

The subsystem has five focused components:

1. **Minecraft adapter** — produces compact observations and executes the small action vocabulary through the actor.
2. **Agent controller** — owns the decision loop, validates LLM output, enforces limits, and determines verified success or failure.
3. **Codex CLI provider** — invokes Codex ephemerally for one decision at a time using structured input and a strict output schema.
4. **Actor state store** — atomically persists durable state separately for each actor.
5. **Operator command adapter** — exposes start, status, stop, resume, and reset controls without coupling the agent to the meadow showrunner.

The Codex CLI process is ephemeral. Continuity does not depend on a persistent CLI conversation: the controller reloads the actor record and sends the relevant state with every decision request.

## Ownership of State

State is divided into trusted controller state and untrusted LLM-authored state.

### Controller-owned state

Only the controller may write:

- actor ID and state schema version;
- run ID, lifecycle status, and timestamps;
- immutable goal and machine-checkable success condition;
- turn count, remaining limits, and failure counters;
- verified position and inventory observations;
- identified nearby blocks and controller-assigned target IDs;
- completed milestones;
- recent requested actions and verified results; and
- death, disconnect, timeout, and stop conditions.

Minecraft-derived facts are refreshed from the live adapter. An LLM statement never becomes a trusted fact merely because it appears in a summary or state variable.

### LLM-authored state

The LLM may write and persist:

- a bounded working summary of relevant history;
- its current plan;
- its current subgoal;
- learned strategy notes;
- failed approaches to avoid; and
- schema-constrained custom state variables.

This state survives individual decisions, server restarts, controller restarts, stopped runs, and future goals for the same actor. The operator can deliberately erase it with the reset command. LLM-authored state is context for future reasoning, not authoritative world truth.

For the proof of concept, the same LLM call both chooses the next action and updates its authored state. A separate summarizer is out of scope.

## Persisted Actor Record

Each actor has one versioned record with these logical sections:

```text
identity: actor ID, schema version
lifecycle: run ID, status, timestamps
goal: objective, verified success condition
trusted: phase, milestones, recent observations, recent action results
working: summary, plan, subgoal, custom variables
limits: turns used, invalid responses, repeated failures, deadline
```

The summary and recent history are bounded to keep every prompt compact. The working summary is limited to 500 Unicode characters, and the trusted history retains the five most recent action results. Overlong LLM-authored text is rejected rather than silently truncated; eviction of older trusted results is deterministic and tested.

Writes are atomic: write a complete replacement to a temporary sibling file, flush and close it, then rename it over the actor record. A crash must leave either the previous valid record or the new valid record, never a partially written record. Unknown schema versions fail closed and require migration or reset.

## Decision Loop

Each turn follows this sequence:

1. Observe the live Minecraft actor and relevant nearby world state.
2. Load the actor's persisted goal, trusted history, and LLM-authored state.
3. Construct a compact request containing the allowed action schema, verified observation, limits, last result, and durable working state.
4. Invoke Codex CLI as a fresh ephemeral, noninteractive, read-only process with approvals disabled and a strict output schema.
5. Parse and validate the response.
6. Persist rejected responses and their error result without executing them.
7. For a valid request, execute exactly one action through the Minecraft adapter.
8. Observe and verify the result instead of trusting the requested outcome.
9. Atomically persist the updated controller and LLM state.
10. Check success and termination conditions; otherwise begin the next turn.

After a controller or server restart, resume always begins with a fresh Minecraft observation. No previously requested but unverified action is assumed to have succeeded.

## LLM Input and Output

The LLM receives compact structured information, not unrestricted server access. Targetable world objects use controller-generated IDs so the model does not issue arbitrary raw coordinates.

Each valid response contains:

- exactly one action;
- only the parameters permitted for that action;
- a short reason;
- a replacement working summary;
- an updated plan and subgoal; and
- schema-constrained updates to custom state variables.

The initial action vocabulary is:

- `observe`
- `move_to_block`
- `mine_block`
- `select_item`
- `place_on_block`
- `finish`

The LLM cannot submit arbitrary Minecraft commands, raw coordinates, JavaScript, shell commands, or filesystem operations. `finish` is only a request to verify completion; the controller determines whether the goal actually succeeded.

## Lifecycle and Operator Commands

The operator-facing commands are:

- `VPNAJ agent start` — create a new run for the configured proof-of-concept goal, preserving durable actor knowledge unless reset;
- `VPNAJ agent status` — report lifecycle state, goal progress, last result, and limits;
- `VPNAJ agent stop` — stop before another action and preserve state;
- `VPNAJ agent resume` — continue a stopped or interrupted run after a fresh observation; and
- `VPNAJ agent reset` — stop the actor and deliberately erase its goal history and LLM-authored persistent state.

Lifecycle statuses are `idle`, `running`, `succeeded`, `failed`, and `stopped`. Only one run may control a given actor at a time. Other showrunner systems may run concurrently only when they control different actors and do not claim the proof-of-concept test area.

## Limits and Failure Handling

The initial run is bounded to 12 decision turns. It also has per-decision and per-action timeouts, a total run deadline, an invalid-response limit, and a repeated-identical-failure limit.

The controller rejects malformed output, unsupported actions, unknown targets, unavailable inventory items, and parameters outside the action schema. Rejection consumes a turn and is recorded as a verified result so the LLM can correct itself.

The controller immediately stops safely on operator stop, actor death, or disconnect. Timeouts and repeated failures produce a `failed` status with a specific reason. A Codex CLI failure never causes a default gameplay action. Resume is permitted only when the persisted record is valid and the actor can be observed again.

## Incremental Validation

Validation proceeds in small real-world steps:

1. Unit-test schema validation, state ownership, bounded summaries, atomic persistence, restart loading, and reset.
2. Test structured Codex CLI decisions and malformed-output rejection without Minecraft.
3. Test each allowed action individually against the real server, verifying actual world and inventory changes.
4. Test stop and resume across a controller restart.
5. Run the complete oak-log-to-gold-marker goal in a controlled area.
6. Restart during a run and verify safe continuation from persisted state plus a fresh observation.
7. Repeat complete successful runs and retain evidence before declaring the proof of concept established.

Tests must distinguish simulated adapter success from real-server evidence. No result is called production-ready based only on mocks or unit tests.

## Explicit Non-goals

This proof of concept does not include:

- multiple LLM-controlled actors;
- combat or the full Minecraft action space;
- dialogue generation or scripted scene coordination;
- long-term semantic memory, embeddings, or retrieval systems;
- modification of the existing meadow scene;
- arbitrary tool execution by the LLM; or
- automatic expansion of permissions after success.

Those capabilities can be designed only after the bounded one-actor loop is repeatedly validated on the real server.
