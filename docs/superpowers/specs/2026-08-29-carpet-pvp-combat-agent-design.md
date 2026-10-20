# Carpet PvP Combat Agent Design

Date: 2026-08-29
Status: Approved in conversation

## Purpose

Add realistic player-versus-player combat to the Minecraft LLM architecture without replacing the existing Mineflayer survival actor or coupling the main world to a version-specific server mod. The first proof uses one dedicated Carpet PvP fake player in an isolated Fabric arena. The generated-goal pipeline remains responsible for goals and bounded decisions; deterministic code remains responsible for execution, safety, timing, and proof.

## Chosen Approach

The combat actor is a separate character controlled through a `combat_driver` port. The initial driver translates validated tactical intents into Carpet PvP fake-player actions. Mineflayer remains the general survival actor and may coexist with the combat actor. A coordinator may later assign different characters to survival, dialogue, filming, or combat without changing the goal-contract language.

The first proof does not attempt seamless control handoff for the existing `LlmAgent` identity. It proves that the same bounded LLM system can direct a dedicated combat character realistically and safely.

## Runtime Separation

The existing vanilla Minecraft 1.21.4 world remains unchanged. Carpet PvP requires a compatible Fabric server stack, so the proof runs from a separate directory with its own world, configuration, ports, logs, and state. Starting or stopping the combat server cannot start, stop, upgrade, or edit the existing server.

No mod jar is downloaded or installed until its exact Minecraft, Fabric Loader, Fabric API, Carpet, Java, and Carpet PvP versions have been resolved and recorded. The first implementation checkpoint uses a fake driver and automated tests; the first live checkpoint only boots the isolated Fabric server and verifies a manually spawned fake player.

## Control Layers

1. The slow LLM generates a bounded combat goal contract, such as `win one practice exchange while remaining above eight health`.
2. The fast LLM selects one tactical intent from the contract's allowlist.
3. The combat policy validates target, arena, equipment, timing, budget, and emergency rules.
4. The Carpet driver expands the intent into a deterministic, bounded command sequence.
5. An observation bridge reports authoritative actor and opponent state.
6. A verifier decides whether the action and goal succeeded from observations, never from LLM claims or chat text.

## Tactical Intent Contract

The fast LLM may choose only one of these versioned intents:

- `approach_target`;
- `hold_distance`;
- `strafe_left`;
- `strafe_right`;
- `sprint_attack`;
- `normal_attack`;
- `critical_attack`;
- `raise_shield`;
- `lower_shield`;
- `use_item`;
- `select_hotbar_slot`;
- `retreat_to_anchor`;
- `wait`.

Each intent contains exact fields and symbolic IDs. It cannot contain raw Minecraft commands, Scarpet source, arbitrary coordinates, player selectors, durations above the controller maximum, or unregistered item/target IDs. Unknown fields fail closed.

The initial implementation excludes projectile prediction, crystal PvP, anchors, beds, elytra, mace/wind-charge sequences, inventory management beyond hotbar selection, block placement, and multi-opponent tactics. These may be added individually after live evidence supports the simpler melee slice.

## Combat Policy

The deterministic policy enforces:

- one controlled combat actor and one approved opponent;
- one active tactical sequence at a time;
- an arena region and a controller-owned retreat anchor;
- a maximum 12-block engagement radius;
- a maximum 750-millisecond tactical decision cadence;
- a maximum 20-second exchange and 120 fast decisions per session;
- no attacks on spectators, non-approved players, villagers, animals, or other entities;
- no raw server commands from either LLM;
- immediate stop on disconnect, death, target loss, arena exit, operator stop, or observation staleness;
- automatic disengagement at four health or below unless a smaller configured threshold is explicitly chosen before the run;
- no world editing, item spawning, teleporting, or rule changes through tactical intents.

The server operator may prepare and reset the arena through separate trusted setup commands. Those commands never enter the LLM action surface.

## Observations and Proof

The compact observation includes monotonically increasing version and timestamp, actor and target IDs, positions relative to the arena origin, distance, line of sight, health, selected slot, held-item category, shield state, sprint state, on-ground state, recent damage direction, target validity, arena membership, and cooldown categories. The LLM receives categories and rounded values where exact precision is unnecessary.

Action verification requires a newer observation and intent-specific evidence. Examples include reduced opponent health after an attack, changed relative position after a strafe, selected-slot change after a selection intent, and shield-state change after a shield intent. Goal verification uses trusted health, death, arena, and session records. Chat messages and LLM summaries are never proof.

## Driver Boundary

The stable port is:

```js
createCombatDriver(config) -> {
  connect(),
  spawnActor(actorSpec),
  observe(),
  execute(intent, context),
  cancel(reason),
  resetExchange(resetSpec),
  disconnect()
}
```

The fake driver and Carpet driver return the same versioned observation and execution-result shapes. Carpet command syntax is confined to the Carpet driver. The policy and LLM providers must not import or construct Carpet commands.

## Goal-Pipeline Integration

Combat is an optional capability pack, not a change to the generated-contract safety model. The registry gains combat capabilities, predicates, and constraints only after the generic compiler, evaluator, state store, and fast runner exist. A combat goal contract selects the combat actor and the approved opponent through controller-owned symbolic IDs.

The supervisor still allows only one active contract, one speculative successor, one slow request, and one fast request. The dedicated combat runtime may run beside the survival runtime, but one actor cannot hold two execution leases. Multi-character coordination remains a later coordinator feature.

## Real-World Validation Ladder

1. Automated fake-driver tests prove exact intent validation, policy rejection, cancellation, observation freshness, and deterministic verification.
2. An isolated Fabric server boots with pinned versions and no existing world data.
3. A trusted operator manually spawns one Carpet fake player and verifies movement, look, attack, sprint, shield, and stop actions.
4. The deterministic driver completes one scripted melee exchange without an LLM.
5. The fast LLM completes one bounded exchange against a stationary approved opponent.
6. The fast LLM completes one bounded exchange against a moving approved opponent while the slow LLM prepares the next contract.

Each checkpoint records exact versions, commands, logs, observations, and pass or rejection evidence. Failure at a checkpoint stops expansion; it does not become a partial success claim.

## Acceptance Criteria

The proof succeeds only when a dedicated combat actor completes one live, bounded melee exchange in the isolated arena; every executed action originated from a validated intent; independent observations prove movement and combat effects; stop and emergency disengagement work; no unapproved entity is attacked; and the existing 1.21.4 server and Mineflayer agent remain unchanged and independently runnable.
