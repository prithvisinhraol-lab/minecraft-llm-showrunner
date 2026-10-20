# Bounded Live Meadow Host Design

## Goal

Provide one dedicated process that composes the existing showrunner, Survival
coordinator, authority, and two Mineflayer actor runtimes against the local
Minecraft server so the approved first-day meadow scene can be genuinely test
run in-world.

## Scope

The first delivery is a live **test** host, not the final recording/acceptance
host. It executes the twelve already-approved fixed lines and the eleven
bounded Survival goals. It does not improvise dialogue, accept a take, or claim
OBS evidence. Artifact and recording acceptance remain a later layer.

## Start gate

Starting the host may connect actors, inspect the world, and prepare an
in-memory take, but it must not issue dialogue or world-changing actor commands
until all of these are true:

1. `VPNAJ` is online.
2. The operator sends an explicit start instruction after joining.
3. The current meadow geometry and safe standing positions pass live
   validation.
4. Both actors are connected, non-op, idle, and bound to distinct marks.

If the operator disconnects before or during the run, the host stops issuing
new work, cancels both actors, waits for quiescence, and reports the run
aborted. Rejoining never resumes an old attempt automatically.

## Architecture

`src/showrunner/live-meadow-host.mjs` is the composition root. It owns the two
Mineflayer connections, constructs `ActorRuntime` instances, the Survival
authority and planner, the coordinator, and the deterministic showrunner. A
small command-line wrapper exposes `preflight`, `start`, `status`, and `stop`
without accepting arbitrary Minecraft commands.

The host uses the normalized production episode files as its only authored
scene source. It creates a signed runtime bank only from the exact fixed lines
already present in the episode; the signing key is ephemeral for a test run and
is never written to Git or printed. Every spoken command remains bound to its
cue, authored line ID, speaker, text, episode hash, and attempt.

## Live world validation and calibration

The manifest's old coordinates are not trusted merely because they declare
safe headroom. Preflight observes the real world through Mineflayer and checks:

- solid, non-hazardous support under feet;
- passable feet and head cells;
- distinct actor and camera positions;
- both tree regions contain reachable approved logs;
- the crafting mark is reachable;
- every excavation cell is present, approved, and bounded;
- actors and camera are in `minecraft:overworld`.

Preflight fails closed and emits a concise diagnostic if any condition fails.
It may propose naturally surfaced coordinates but does not edit blocks. Any
accepted coordinate change must update both episode files and the baseline
manifest together and pass the existing cross-file validators.

## Execution flow

1. Load and jointly validate the showrunner and Survival episodes.
2. Connect or adopt exactly `HeroActor` and `RivalActor`; refuse duplicate or
   unexpected identities.
3. Verify `VPNAJ` presence and the live preflight.
4. Reset actor inventory, health, food, effects, position, time, and weather
   through the typed production controller.
5. Create a fresh attempt and start at the first visible beat.
6. For each beat, speak both fixed lines in order, then allow only that beat's
   bounded goals to execute.
7. Stop after the sixth beat and report completed state. Do not accept or
   record the test take as production evidence.

## Error handling

All identity, authorization, observation, deadline, reservation, and delivery
failures use the existing fail-closed paths. Disconnect, death, operator
departure, unsafe terrain, or emergency stop cancels the attempt. Cleanup has a
fixed deadline and failure to prove quiescence prevents retry.

The host never falls back to server-console dialogue, teleport choreography,
legacy `bot` chat commands, or untyped world mutation.

## Testing and completion gate

Unit tests cover CLI parsing, the operator-online gate, no-side-effects-before-
start, disconnect cancellation, exact actor identity, and preflight rejection.
Integration tests compose the real showrunner/coordinator/actor-runtime stack
against bounded fake Mineflayer clients. The complete repository suite and
both episode validators must pass.

Live validation is incremental:

1. connect actors without movement;
2. observe and report positions without mutation;
3. verify operator and scene geometry;
4. perform a reset-only rehearsal;
5. remain armed and idle;
6. start only after `VPNAJ` is online and explicitly instructs the host to
   start.

The scene is reported ready to start only after steps 1-5 pass on the current
server process.
