# Generated Goal Pipeline Design

Date: 2026-08-29
Status: Approved in conversation; awaiting review of this written specification

## Purpose

Generalize the bounded Minecraft LLM system so a slow planning LLM can generate complete goal contracts while a fast action LLM executes the current contract. The two layers operate concurrently: while the fast worker acts, the slow worker prepares one speculative successor. The system continues without pausing between valid goals, but deterministic code retains authority over permissions, execution, evidence, budgets, concurrency, and recovery.

The first production goal pack is survival progression. The architecture must not hard-code survival as its only use: the same generated-contract mechanism must later support building, exploration, combat preparation, filming, and recovery goals.

## Scope

This increment will:

- add a generated goal-contract language composed from code-owned capabilities, predicates, constraints, and limits;
- allow the slow LLM to generate the objective, prerequisites, success conditions, constraints, capability request, budgets, expected outcome, and optional multiple-choice question;
- validate every generated contract before it receives execution authority;
- run one active fast goal while generating at most one speculative successor;
- promote a speculative successor only after reconciling it with the actual verified predecessor outcome and fresh Minecraft state;
- persist compact mission, contract, outcome, question, limit, and recovery state;
- accept normal and urgent mission updates while running;
- continue automatically between valid goals until stopped, blocked, disconnected, or a global ceiling is reached;
- fail closed on unknown, stale, contradictory, unverifiable, over-budget, or unauthorized contracts.

This increment will not allow generated JavaScript, shell commands, raw Minecraft commands, direct network access, arbitrary coordinates, new executable capability implementations, or LLM-authored verifier code. It will not coordinate multiple actors; that remains a later subsystem built on the same coordinator boundaries.

## Authority Model

The slow LLM is an author and strategist, not an executor. It may compose a proposed contract only from the vocabulary supplied in its request. The validator decides whether that proposal can become executable.

The fast LLM is a bounded controller. It may choose only actions permitted by the active validated contract and the existing action contract. It cannot edit its objective, success conditions, constraints, or budgets.

The Minecraft adapter is the sole component that executes game actions. The verifier is the sole component that establishes action and goal success from trusted live observations. The supervisor is the sole component that grants and revokes execution authority, advances lifecycle state, updates mission versions, and promotes speculative work.

No LLM claim can substitute for live world or inventory evidence.

## Three Planning Levels

1. **Mission:** a persistent high-level direction such as `survive, progress, and prepare for exploration`.
2. **Generated goal contract:** one bounded, measurable outcome such as retaining a stone pickaxe.
3. **Fast actions:** individual validated actions such as navigate, mine, collect, craft, place, equip, consume, retreat, attack an approved hostile, or speak.

Only verified goal outcomes are summarized upward. Raw prompts, raw observations, hidden reasoning, and chain-of-thought are never persisted.

## Generated Contract

Each slow-LLM response must match one exact versioned JSON schema. A contract contains:

- `contractId`: supervisor-issued nonce echoed by the LLM;
- `missionVersion`: the exact mission version used to generate it;
- `predecessor`: active contract ID plus expected terminal status and expected proof kinds;
- `objective`: concise human-readable intent;
- `rationale`: concise explanation suitable for logs and player status;
- `prerequisites`: a bounded Boolean expression over approved predicates;
- `success`: a bounded Boolean expression over approved predicates;
- `constraints`: a bounded list of approved rule instances;
- `capabilities`: a bounded list of approved capability IDs;
- `budget`: action, replan, duration, search-radius, and travel-radius ceilings;
- `expectedOutcome`: a compact predicted summary and proof kinds;
- `question`: either `null` or one bounded multiple-choice question.

Unknown and missing fields fail closed. The MVP permits at most 16 predicates at Boolean depth 3, eight constraints, eight capabilities, 40 actions, five replans, 300 seconds, a 64-block search radius, and a 128-block travel radius from the contract start. Objectives are at most 300 characters, rationales and expected summaries at most 500 characters, and question text and choice labels at most 200 and 80 characters respectively. Smaller values may be configured, but neither LLM may raise these ceilings. The contract contains no executable text.

## Code-Owned Vocabulary

The initial capability registry contains:

- observe;
- navigate to a controller-owned target or named landmark;
- mine a permitted block;
- collect a controller-observed dropped item;
- craft an approved known recipe;
- place a permitted block against a controller-owned target;
- equip an inventory item;
- consume approved food;
- attack an approved hostile target;
- retreat to a named safe landmark;
- speak one bounded chat message.

The initial predicate registry contains:

- actor alive, connected, health, hunger, dimension, and named region;
- inventory item count and equipped item;
- permitted block or entity exists within a bounded radius;
- controller-owned target has an expected type or state;
- named landmark is visible or reached;
- recipe is available;
- time of day and weather category;
- approved hostile threat exists or is absent;
- explicitly permitted container contains an item;
- bounded blueprint completion;
- predecessor proof kind exists in verified outcome history.

Each capability and predicate implementation owns its input schema, authorization checks, live observation requirements, and deterministic result validation. Adding a new vocabulary item is a code change with tests; an LLM cannot define one at runtime.

## Validation and Compilation

Contract validation is a deterministic compilation step:

1. Parse the exact schema and enforce size and numeric bounds.
2. Confirm mission, observation, predecessor, and contract fences.
3. Resolve every capability, predicate, constraint, item, recipe, block, entity, landmark, region, and blueprint through an allowlisted registry.
4. Reject raw coordinates, commands, code, unknown IDs, and protected resources.
5. Confirm each success predicate is independently observable and supported by requested capabilities.
6. Detect direct prerequisite/success contradictions and impossible Boolean expressions covered by the predicate model.
7. Clamp nothing silently: any out-of-range request is rejected.
8. Evaluate prerequisites against fresh trusted Minecraft state.
9. Freeze the normalized contract and persist it before publication.

The slow worker receives structured validation failures for telemetry, but a stale or invalid speculative proposal is discarded. The next generation request starts from fresh state rather than repairing assumptions in place.

## Pipelined Execution

The supervisor maintains exactly:

- zero or one active executable contract;
- zero or one speculative successor;
- zero or one slow generation request in progress;
- zero or one fast execution request in progress.

After contract N becomes executable, the fast worker begins it. Concurrently, the slow worker receives the compact verified state, active contract N, expected successful outcome of N, current mission, approved vocabulary summaries, and recent verified outcomes. It drafts N+1 against that expected predecessor.

The N+1 draft remains speculative and cannot authorize Minecraft actions. When N terminates, the supervisor records its actual verified outcome and takes a fresh observation. N+1 is promoted only if:

- N succeeded with the expected proof kinds;
- mission and world fences still match;
- N+1 has not expired;
- N+1 prerequisites pass against the fresh observation;
- its contract validation remains valid under the current registry version and remaining global budgets.

Otherwise N+1 is discarded and the slow worker generates a replacement from the actual state. When a contract is promoted, the fast worker starts it immediately without player approval, and the slow worker begins drafting its successor.

## Lifecycle and Fencing

Contract lifecycle is:

`draft -> validated -> speculative|ready -> executing -> verifying -> succeeded|failed|stopped|invalidated`

Every asynchronous request and persisted transition carries:

- mission version;
- registry/schema version;
- world-observation version;
- contract ID;
- predecessor contract ID and expected outcome;
- actor run ID where applicable;
- lease owner;
- creation and expiration timestamps.

Late or mismatched responses are discarded without changing authoritative state. One serialized supervisor queue owns lifecycle transitions. Separate leases prevent overlapping supervisor, slow-worker, and fast-worker authority after restarts.

## Mission Updates

A normal mission update increments the mission version, invalidates the speculative contract and pending slow request, and allows the current bounded goal to finish. The next contract is generated from the new mission and actual terminal outcome.

An urgent mission update increments the mission version, aborts both workers, safely stops the active action/controller, invalidates speculative work, takes a fresh observation, and begins planning the new mission.

`stop` always behaves urgently. Mission text is data, never executable instructions, and remains subject to the same capability, predicate, constraint, and budget system.

## Multiple-Choice Questions

The slow LLM is the only question author. It may emit one question only when materially different valid intentions cannot be chosen safely from available state. A question contains a bounded prompt, two or three stable choices, a safe default choice, and a timeout of at most 30 seconds. The supervisor is the only component that presents a question or accepts its answer; the fast worker cannot invent one during action execution.

Questions are presented in Minecraft chat. Only the authorized player may answer using an exact choice command. If the timeout expires, the safe default is selected and execution continues. Open-ended answers do not enter the executable contract pipeline.

At most one question may be pending. A mission update or stop invalidates it. Question and answer history is compact and bounded.

## Persistent State

Coordinator state is stored separately from fast actor and legacy bounded-director state. It contains:

- mission text and version;
- supervisor lifecycle and lease metadata;
- active normalized contract or null;
- speculative normalized contract or null;
- pending question or null;
- up to five verified outcomes;
- bounded target/action failure fences;
- per-session and global budget counters;
- latest compact failure and recovery reason.

Writes use the existing atomic temporary-file, fsync, rename, and directory-sync pattern. Loading validates the complete record before use. Invalid state fails closed; operators do not hand-edit JSON.

## Recovery

- **Slow worker failure:** active fast execution continues; the slow request is cleared and retried within its bounded retry budget.
- **Fast worker failure:** the contract becomes stopped, execution authority is revoked, and resume requires fresh observation and reconciliation.
- **Minecraft disconnect or actor death:** abort all actions, invalidate speculative work, persist a resumable stopped state, and never assume the interrupted action completed.
- **Process restart:** load and validate state, acquire fresh leases, observe Minecraft, reconcile the active contract, then resume, verify, or invalidate it.
- **Stale speculative goal:** discard and regenerate from fresh verified state.
- **Goal failure:** record only verified failure facts, fence repeated target/action failures, and ask the slow LLM for a bounded recovery or alternative goal.
- **Repeated failure ceiling:** pause the pipeline and report status in chat.
- **Global ceiling:** pause rather than resetting counters or continuing automatically.

## Independent Global Limits

The supervisor enforces limits that neither LLM may raise:

- 90 minutes of continuous runtime;
- ten completed goals per session;
- 20 slow-LLM calls and 400 fast-LLM calls per session;
- a configured token ceiling when the provider supplies authoritative usage, with call ceilings remaining mandatory when it does not;
- the per-contract 128-block travel and 64-block search ceilings;
- three consecutive goal failures;
- three consecutive contract-generation failures;
- one pending question for at most 30 seconds;
- five persisted outcomes and ten failure fences.

Reaching a ceiling pauses the pipeline, revokes new execution authority, preserves state, and reports a concise reason. Resume requires an authorized player command and never silently refreshes budgets.

## Survival Progression Validation Slice

The first real-world increment proves this architecture through a small survival slice rather than attempting the entire game. The slow LLM must dynamically generate successive contracts that, depending on live state, can cover:

1. gather oak logs;
2. craft planks;
3. craft and place a crafting table;
4. craft a wooden pickaxe;
5. collect cobblestone;
6. craft and retain a stone pickaxe.

The test is successful only if at least two consecutive goals complete through the live pipeline, the successor was generated while its predecessor was executing, each promotion passed fresh prerequisite validation, and independent world/inventory evidence proves both outcomes. The slice stops after the stone-pickaxe milestone even if the system could continue.

## Testing and Acceptance

Automated tests must cover:

- exact generated-contract schema and all bounds;
- registry resolution and unknown-item rejection;
- permission and protected-resource failures;
- predicate evaluation and success-proof construction;
- contradiction and unverifiable-goal rejection;
- one active plus one speculative concurrency ceilings;
- promotion only after matching verified predecessor outcome;
- stale response, mission update, stop, timeout, death, and disconnect fencing;
- crash/restart reconciliation and lease exclusion;
- bounded persistence, outcome history, questions, and global limits;
- existing fast-agent and one-shot director behavior remaining compatible.

Live acceptance must use a fresh isolated survival area, an authorized player command to start the pipeline, real slow and fast LLM providers, and server-console/world inspection independent of persisted JSON. Automated tests, scripted providers, LLM summaries, or chat success messages alone are insufficient live evidence.

## Delivery Strategy

Implement incrementally:

1. contract schema and registries;
2. deterministic compiler and predicate evaluator;
3. persistent supervisor state and leases;
4. slow-worker generated-contract provider;
5. one-active/one-speculative pipeline;
6. mission updates, questions, recovery, and global limits;
7. survival capability/predicate slice;
8. complete regression and user-gated live acceptance.

Each increment receives focused tests before integration. Real-world validation occurs in small checkpoints, with durable evidence recorded before expanding the vocabulary or autonomy boundary.
