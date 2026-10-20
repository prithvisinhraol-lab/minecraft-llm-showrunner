# Bounded LLM Director Design

## Purpose

Add a slower, more thoughtful LLM layer that chooses one bounded Minecraft goal for the existing fast LLM agent. The director advances a human-provided overall objective without directly controlling Minecraft actions. This first increment proves one verified handoff from a completed agent goal to a newly selected goal.

## Proven Starting Point

The live Mineflayer agent can already receive the fixed goal to obtain one oak log and place it above a controller-identified gold-block marker. The fast Codex-backed decision loop observes the world, selects individual actions, executes them through the adapter, verifies each action, persists bounded state, and verifies the final world condition.

The director must build on that controller rather than bypassing it.

## Scope

This increment will:

- add a separate `src/llm-director/` subsystem;
- persist director state separately under `runtime/llm-director-state/`;
- give the director a bounded catalog of executable goal definitions;
- let a slower Codex invocation select exactly one next goal;
- hand the selected goal to the existing fast agent controller;
- add a second supported goal: remove and collect the oak log directly above the gold marker;
- verify the second goal from the live world and inventory;
- expose the workflow through the Minecraft chat command `director start`;
- record the selection, handoff, verified result, and compact summary;
- stop after that one goal, whether it succeeds or fails.

This increment will not autonomously loop over multiple goals, coordinate multiple actors, accept arbitrary natural-language executable goals, or implement director questions. Those are later increments after this handoff is live-validated.

## Architecture

The system has two decision rates and two authority boundaries.

The director is the slow layer. It receives an overall objective, a bounded list of eligible goal IDs, and a compact summary of recent verified outcomes. It returns one structured selection. It cannot issue Minecraft actions, coordinates, shell commands, or unsupported goal text.

The existing agent is the fast layer. It receives the selected catalog goal and repeatedly chooses one action from the existing action vocabulary. Only the agent controller and Minecraft adapter may execute or verify actions.

The orchestration flow is:

1. Load or initialize director state.
2. Require the preceding agent run to have trusted, live, successful evidence.
3. Build a compact director context containing the overall objective, eligible catalog entries, and bounded outcome history.
4. Ask the director provider for one structured goal selection.
5. Validate the response and resolve the goal ID through the local catalog.
6. Persist the selected goal before starting the agent.
7. Run the existing fast controller with that goal.
8. Accept success only from the agent controller's live goal verification.
9. Persist a compact outcome and stop.

## Goal Catalog

Goals are executable templates owned by local code. The director selects a goal ID and does not generate an executable objective or success condition.

The initial catalog contains:

- `place_oak_log_above_gold_marker`: obtain one oak log and place it directly above the controller-identified gold marker. This is the already proven goal.
- `collect_oak_log_above_gold_marker`: mine the oak log directly above the controller-identified gold marker and retain at least one oak log in inventory.

For the first director run, eligibility rules exclude goals already represented by the latest verified outcome and require the live prerequisite for the collection goal: the marker is known and an oak log is verified above it. Thus the intended next selection is `collect_oak_log_above_gold_marker` without hard-coding the provider response.

Every catalog entry includes a stable ID, bounded objective text, a typed success condition, prerequisite metadata, and a maximum action budget no greater than the existing agent safety maximum.

## Director Contract and Bounds

The director request contains only:

- schema version;
- actor ID;
- overall objective;
- up to five eligible goal summaries;
- up to five recent verified outcome summaries;
- the latest trusted goal proof;
- remaining director invocation budget.

The director response contains exactly:

- `decision`: `select_goal` or `stop`;
- `goalId`: one eligible catalog ID for `select_goal`, otherwise `null`;
- `reason`: a nonempty string of at most 300 characters;
- `stateSummary`: a string of at most 500 characters.

Unknown fields, unknown goal IDs, ineligible goals, oversized strings, malformed JSON, or unsupported decisions fail closed. The first increment permits one director decision and one agent run per `director start` invocation. The director decision timeout is 90 seconds; the existing agent limits remain authoritative for action decisions.

## Persistent Director State

Director state is stored atomically in one JSON record per actor and uses its own lease to prevent concurrent director runs. It contains:

- identity and schema version;
- overall objective;
- lifecycle status and run ID;
- current selected goal ID or `null`;
- at most five verified outcome records;
- latest director reason and state summary;
- invocation counters and configured limits;
- failure code and safe message when applicable.

Outcome records contain goal ID, terminal status, agent run ID, completion timestamp, compact summary, and trusted proof metadata. Raw prompts, full observation histories, chain-of-thought, and unbounded dialogue are not persisted.

The actor's existing state file remains the source of truth for action-level history. Director state never edits trusted agent evidence.

## Agent Generalization

The agent contracts will accept only catalog-resolved goal objects rather than only the original fixed objective. Goal-specific verification remains deterministic and local:

- Placement succeeds only when the identified marker remains a gold block and the block directly above it is an oak log.
- Collection succeeds only when the identified marker remains a gold block, the block directly above it is air, and the actor inventory contains at least one oak log obtained during the run.

The collection goal uses the existing `navigate_to_landmark`, `mine_block`, `observe`, and `finish` actions. No new low-level action is required.

Codex prompts receive the active goal and success condition through the compact decision context. The controller still rejects a `finish` decision unless the adapter verifies the active goal.

## Chat and Runtime Behavior

`director start` is accepted from the same authorized in-game control path as the existing agent commands. It responds in chat with short lifecycle messages:

- director started;
- selected goal summary;
- fast agent started;
- goal succeeded or failed;
- director stopped.

Repeated chat events cannot start overlapping director or agent runs. `agent stop` remains able to interrupt the active fast controller. Closing the runtime aborts the director provider and agent work, releases leases, and preserves the last atomically saved state.

The existing `agent start`, `agent stop`, `agent status`, and `agent reset` commands remain available. The first live test will begin only after scene prerequisites and both persisted states are checked.

## Failure Handling

The workflow stops safely when:

- preceding evidence is missing, simulated, stale for the requested handoff, or unsuccessful;
- no catalog goal has satisfied prerequisites;
- the director provider times out, exits unsuccessfully, or returns invalid output;
- the selected goal becomes ineligible before handoff;
- a runtime lease is already held;
- the agent fails, stops, disconnects, or cannot verify the goal;
- persistence fails.

No failure triggers automatic retries across goals in this increment. A failure is recorded with a stable code and concise message; the user may inspect state and explicitly start again after correcting the prerequisite.

## Testing

Automated tests will cover:

- exact director request and response validation;
- catalog resolution and prerequisite filtering;
- bounded history and serialization;
- atomic director state persistence and lease exclusion;
- provider command isolation, timeout, abort, output limits, and schema handling;
- selection of the collection goal from a successful placement outcome;
- rejection of unsupported or ineligible selections;
- generalized agent state validation for both catalog goals;
- deterministic live-adapter verification of the collection goal;
- orchestration success and every fail-closed boundary;
- chat authorization, duplicate-start suppression, shutdown, and legacy agent command compatibility.

Tests will be written first and observed failing for the intended missing behavior before production changes. The focused LLM-agent/director test files will run after each task, followed by `node --test test/*.test.mjs`.

## Live Validation

The live acceptance test begins from the currently proven world state: a gold marker with an oak log directly above it and a successful persisted placement outcome.

The user enters `director start` in Minecraft chat. Success requires evidence of all of the following:

1. The slow provider selects `collect_oak_log_above_gold_marker` from the eligible catalog.
2. The selection is persisted before agent execution.
3. The fast provider directs the actor to mine the correct oak log.
4. The live server confirms the gold marker remains, the block above is air, and the actor holds an oak log.
5. Agent state ends `succeeded` with live, non-simulated evidence.
6. Director state records the verified outcome and ends `succeeded`.
7. The workflow stops without choosing a third goal.

Passing unit tests alone does not establish live success. Any provider timeout, disconnection, unverifiable action, or incorrect world state leaves the live validation incomplete.

## Future Increments

After this one-handoff MVP works live, later designs may add multiple successive director selections, human goal injection, multiple-choice questions in chat, richer goal templates, several coordinated actors, and distinct fast and slow model configuration. Each capability will retain catalog validation, bounded state, deterministic verification, and explicit stop controls.
