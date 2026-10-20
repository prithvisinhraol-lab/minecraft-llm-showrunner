# Bounded Survival Task Planner Design

Status: approved in conversation on 2026-08-06; written-spec review pending

## Goal

Extend the two-actor showrunner so characters can genuinely complete reusable Minecraft Survival goals while remaining directed, safe, observable, and filmable. The first acceptance scene is First Day in the Meadow: both actors gather wood, craft starter equipment, and begin a mine using their own inventories and ordinary Survival mechanics.

## Architecture

The showrunner owns story order, dialogue authorization, take state, retries, and acceptance. A deterministic task planner converts an authored goal into a bounded sequence of typed actions. The existing non-operator actor runtime executes one action at a time through Mineflayer. Authoritative observations of inventory, blocks, position, and equipped items decide whether a step or goal completed.

The planner is not an unconstrained LLM agent. It cannot generate JavaScript, shell commands, Minecraft commands, chat instructions, or new action names. It selects only from a fixed action catalog and receives normalized observations rather than raw privileged interfaces.

## Authored Goal Model

An executable scene adds ordered action goals alongside dialogue cues. The first goal vocabulary is:

- `gather`: obtain a declared count of one allowlisted block-derived item within an approved region;
- `craft`: produce a declared count of one allowlisted recipe output using the actor's inventory and an approved crafting-table mark when required;
- `place`: place one allowlisted block at an approved mark;
- `equip`: equip an allowlisted inventory item in the declared destination;
- `excavate`: remove blocks inside an explicit approved volume until its declared material/count condition is met;
- `regroup`: move to and dwell at an approved mark.

Every goal declares an actor, region or mark, allowlisted targets, required count, timeout, retry budget, and completion predicate. Counts are positive bounded integers. The episode loader rejects unknown fields, actions, recipes, blocks, actors, marks, and predicates.

## Planner

The planner is a pure state transition:

```text
plan(goal, normalizedObservation, reservationSnapshot) -> next typed action or terminal result
```

It uses recipe dependency data and bounded local search. For example, `craft wooden_pickaxe` may produce `craft oak_planks`, `craft stick`, move to the approved table, and `craft wooden_pickaxe`. It does not silently expand a goal into unrelated exploration.

Planning terminates with one of `action`, `completed`, or `blocked`. Each decision includes a stable reason code and references the observation version used. Identical inputs produce the same decision. The showrunner limits total replans per goal and aborts or invokes authored recovery when the limit is reached.

## Typed Survival Actions

The actor runtime adds these allowlisted operations:

- `moveNearTarget(targetReceipt)`
- `lookAtTarget(targetReceipt)`
- `digTarget(targetReceipt, expectedBlock)`
- `collectItem(itemReceipt)`
- `craftRecipe(recipeReceipt, count, tableReceipt?)`
- `placeAtMark(item, markReceipt)`
- `equipItem(item, destination)`
- `observeSurvival(scope)`

Target and recipe receipts come from trusted validators, are bound to the production/take/attempt/goal, and expire when the observed world version changes. The runtime rejects raw coordinates or block references for destructive actions. Movement used during gathering may approach validated targets but cannot dig incidentally.

## Genuine Survival Semantics

Actors remain in Survival mode and non-operator. Gathering uses normal pathfinding, line of sight, tool selection, `bot.dig`, and collection of actual dropped item entities. Crafting uses Mineflayer recipe resolution and the actor's actual inventory. Placement consumes an inventory item. Excavation breaks only blocks inside the approved volume.

The system never gives items, teleports around an action failure, changes game mode, uses `/fill`, or directly edits world state to claim success. A production reset may restore the authored baseline between whole-scene attempts, but reset evidence is separate from action completion evidence.

## Target Selection and Reservations

A trusted target resolver finds reachable candidates inside the goal region, filters them by allowlisted block type, validates line of sight and support constraints, and returns immutable receipts. Selection is deterministic by path cost, then distance, then coordinates.

Before dispatch, the showrunner reserves the target for one actor. The other actor cannot plan against the same log, dropped item, crafting-table placement mark, or excavation cell. Reservations expire on completion, cancellation, target mutation, disconnect, or attempt revocation.

Tree gathering preserves scenery predictably: each actor receives a separate tree region, gathers exactly the declared log count, and stops. The planner does not remove leaves or unrelated blocks.

## Verification

Every action follows `prepare -> execute -> observe -> confirm`:

1. Validate and reserve the target or recipe.
2. Execute one bounded Mineflayer operation.
3. Read fresh authoritative state.
4. Confirm both the direct effect and the goal predicate.

Examples include verifying that a dug coordinate no longer contains the expected log, the corresponding drop was collected, inventory count increased, crafting ingredients decreased, output increased, a placed table occupies the approved mark, and excavated cells are passable. A Mineflayer promise resolving is never sufficient evidence by itself.

Observations include a monotonically increasing version. Late results from cancelled or previous attempts are fenced out using the existing production/take/scene/beat/attempt/cue identity.

## Dialogue and Timing

Dialogue remains authored and signed through the existing approval bank. The showrunner may schedule dialogue only before an action, after a confirmed action, or at an authored interruptible wait point. It does not speak while an actor is in an uncancellable inventory transaction or mid-dig.

The meadow episode preserves the six approved beats. Action-goal completion advances each beat; dialogue alone cannot advance a Survival beat. Optional reaction lines may be selected only from the approved bank.

## Failure and Recovery

The planner distinguishes transient failures from terminal blockers. Transient failures include path invalidation, another entity obstructing a route, or an item drop moving; these permit a bounded re-observation and replan. Terminal blockers include no valid targets, missing recipe support, region escape, unexpected protected block mutation, exhausted retry budget, or mismatched inventory deltas.

Cancellation immediately stops pathfinding and digging, clears control states, closes inventory windows when possible, releases reservations, and waits for quiescence proof. The showrunner then runs the authored beat recovery or retries the whole scene from a verified baseline. It never substitutes server commands for failed genuine actions.

## First Acceptance Scene

First Day in the Meadow succeeds only when live evidence proves:

1. Both actors independently gather at least three reserved oak logs.
2. The actors regroup at the approved crafting mark.
3. Planks, sticks, one crafting table, and two wooden pickaxes are crafted from gathered materials.
4. The table is genuinely placed at its approved mark.
5. Both actors equip wooden pickaxes.
6. They excavate only the approved two-wide entrance.
7. Their combined verified inventory contains at least eleven cobblestone.
8. All authored dialogue occurs in order at safe action boundaries.
9. The take produces the existing transcript, event, validation, baseline, and capture evidence plus planner decisions and Survival observations.

## Testing

Unit tests cover goal/schema rejection, deterministic planning, recipe dependencies, target ordering, receipt expiry, reservations, inventory deltas, block-change verification, cancellation, and retry bounds. Actor-runtime tests use fake Mineflayer interfaces and prove that raw or stale destructive targets are rejected. Integration tests run both actors through the complete meadow plan, including target contention, one transient path failure, and cancellation of an in-flight dig.

Live acceptance runs on the local Java 1.21.4 server with two non-op actors in Survival mode. Completion requires inspecting the resulting world, inventories, ordered transcript, planner trace, and capture artifact; automated tests alone do not prove live readiness.

## Scope Boundary

This phase does not add combat, unrestricted exploration, arbitrary construction, furnace smelting, food management, tool upgrades beyond wooden pickaxes, LLM-generated action plans, or server-command fallbacks. Those capabilities require separately authored goals, policies, validation, tests, and creator approval.

