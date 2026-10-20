# Survival Demo In-Game Start Design

## Purpose

Launch the bounded single-actor survival demonstration only after the operator says exact lowercase `start` in Minecraft. No Mineflayer actor is connected while the system is waiting.

## Scene and progression

The actor starts in the existing natural clearing. It must complete these milestones in order using normal Survival mechanics:

1. Break and collect at least three oak logs.
2. Craft and place a crafting table.
3. Craft and equip a wooden pickaxe.
4. Mine and collect at least eight cobblestone.
5. Craft a furnace.
6. Leave the clearing, find a real village, and verify a bell, bed, and villager.
7. Say exactly `This is gonna be great!!!` only after every preceding milestone is verified.

## Start gate

A lightweight process watches only newly appended Minecraft server log records. It begins at the end of the current log so historical messages cannot trigger a run.

The gate accepts only a parsed public chat record whose username is exactly `VPNAJ` and whose message is exactly lowercase `start`. Messages from other players, command output, server messages, whitespace variants, capitalization variants, and repeated starts are ignored. The accepted start is one-shot for the active run.

After accepting `start`, the gate launches the single actor `LlmAgent`, waits for its spawn, and starts the bounded survival runner. The actor is not present before the trigger.

## Stop and failure behavior

While a run is active, exact lowercase `stop` from `VPNAJ` requests cancellation. Cancellation aborts pending Codex work, stops Mineflayer pathfinding, persists a stopped state, and disconnects the actor. Disconnect, death, deadline, malformed model output, stale observation, missing proof, or failed preflight stops the run without inventing success.

If launch or preflight fails after `start`, the gate reports a concise failure code to its local console and returns to a safe stopped state. It never speaks the final line on failure.

## Components

- `survival-demo-log-gate.mjs` tails and strictly parses new chat records, owns the one-shot start/stop lifecycle, and invokes an injected launch function.
- `survival-demo-live-host.mjs` composes Mineflayer, the secure Codex provider, persistent store, verified adapter, real macro executor, and bounded runner.
- `survival-demo-macro-executor.mjs` performs the seven allowlisted macro actions through normal Mineflayer APIs with deadlines and cancellation.
- `survival-demo-cli.mjs` starts the waiting gate and handles process shutdown.
- The existing survival contracts, runner, provider, store, and evidence adapter remain authoritative for ordering and proof.

## World placement and village discovery

Before filming, an operator preflight identifies the clearing start position and confirms that a real village is within the executor's bounded search area. The actor may be placed at the clearing start as scene setup, but it receives no village coordinates, materials, items, or `/locate` result. Village discovery uses visible world evidence and bounded movement.

## Persistence and concurrency

The existing atomic state store and exclusive lease prevent simultaneous runs. A completed or stopped record is retained. A deliberate reset is required before replaying from the first milestone; repeated chat cannot reset state implicitly.

## Verification

Automated tests cover exact chat parsing, ignoring historical log content, duplicate start suppression, stop during launch and execution, actor cleanup, all macro actions, cancellation, evidence integrity, and composition. The full `test/llm-agent-*.test.mjs` suite must pass.

Live validation proceeds incrementally: gate-only chat test, actor join/stop test, clearing wood test, crafting/mining test, village-discovery test, then one complete rehearsal. The filming run is not declared ready until the complete rehearsal produces every trusted proof in order.
