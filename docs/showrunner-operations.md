# Showrunner Operations and Live Acceptance Runbook

This is the operator procedure for the two-actor Showrunner MVP. It implements
the safety and evidence requirements in the [approved specification](superpowers/specs/2026-08-05-llm-video-showrunner-design.md) and the [implementation plan](superpowers/plans/2026-08-05-two-actor-showrunner-mvp.md).

## Current gate status: DONE_WITH_CONCERNS

The repository has tested showrunner components and a fail-closed CLI contract.
It is **not a live-production host**. In particular, a live take cannot be run
from `node src/showrunner/cli.mjs` alone, because no native production host is
composed into that process. Consequently, no approval, artifact, recording, or
world evidence is created by the instructions below until the required host is
provided. This is intentional: pathname-based filesystem approximations must
not be substituted for the required rooted interfaces.

The source module exports `createProductionController`, but no dedicated,
independently deployed `ProductionController` principal or production-host
adapter is present. A future operator must not treat the module, a legacy bot,
or a Minecraft chat command as that privileged principal.

Do not mark the MVP accepted until all live acceptance evidence listed in
[Final evidence](#final-evidence-and-acceptance) has been collected and
reviewed by the creator.

## Required production-host adapters

Before a human may proceed beyond the fail-closed checks, an authorized
production deployment must supply all of the following. These are deployment
requirements, not instructions to improvise inside the live world.

- A `productionHost` for the CLI that implements `rehearse`, `run`,
  `recordingReady`, `recordingStopped`, `inspectTake`, `verifyCapture`,
  `accept`, and `reject`. It must compose the deterministic state machine,
  non-op Mineflayer actor runtimes, and the typed controller; its commands and
  events must carry the causal attempt fence.
- A separately privileged, authenticated `ProductionController` deployment
  with an allowlisted transport. It may perform only the typed operations in
  the specification: validated actor placement/reset, declared environment
  changes, tagged-entity cleanup, baseline verification, and emergency stop.
  It must not accept arbitrary text, Minecraft chat, or an LLM command.
- A native rooted artifact filesystem port for `artifacts/showrunner`. It must
  atomically traverse from a trusted root without following symlinks and supply
  descriptor-derived proof for reads/writes, atomic writes, append, status
  compare-and-swap, state snapshots, and atomic final-decision transactions.
- A distinct native rooted recording filesystem port. Its `openBeneath` must
  open the recording and `.showrunner.json` sidecar read-only with no-follow
  traversal, return the descriptor-derived root/path/device/inode proof, and
  allow verification against that already-open handle. A `realpath`, `lstat`,
  then pathname `open` sequence is not sufficient.
- A capture integration that gives the recording file monotonic coverage
  timestamps and writes the matching sidecar. Manual OBS start/stop and the
  creator's acknowledgement are human steps; OBS automation is not assumed.
- Live server policy proving `HeroActor` and `RivalActor` are non-op, while the
  separately controlled `ProductionController` is level 4. Static region
  protection must also protect the authored set independently of the actors.

Until these adapters exist, the live commands below must fail with
`LIVE_ADAPTER_NOT_CONFIGURED` (or a preceding input error such as a missing
approved bank). That refusal is the expected safe state, not a reason to add a
weaker fallback.

## Preflight: safe automated checks

Run these checks in the listed order before touching a live world or OBS. The
permission gate reads the actual, already-existing live `ops.json`, but does
not modify it; `npm test` uses only temporary test fixtures.

```bash
export SHOWRUNNER_OPS_PATH=/absolute/path/to/server/ops.json
npm test
git diff --check
npm run showrunner:security-check -- --actors HeroActor,RivalActor --controller ProductionController --ops-path "$SHOWRUNNER_OPS_PATH" --dry-run
node src/showrunner/cli.mjs validate production/episodes/stolen-map.yaml
```

Expected result: all tests pass; `git diff --check` has no output; the dry-run
reports `Dry-run actor removals: (none)` and `Dry-run controller confirmed:
ProductionController (level 4)`; and validation prints the episode, both
profile paths, and baseline-manifest path. Any actor removal listed means an
actor is still op and the take is blocked. Do not substitute a fixture or a
copied `ops.json` for the live permission gate.

`--apply-live` writes a backup and changes `ops.json`; it requires explicit
owner authorization and is outside this runbook's non-mutating acceptance
preparation.

### Fail-closed bare-command demonstration

The task's original bare security-check invocation is retained only as a
separate demonstration that the CLI refuses an ambiguous operation:

```bash
npm run showrunner:security-check -- --actors HeroActor,RivalActor --controller ProductionController
```

The current CLI deliberately refuses that command with
`SHOWRUNNER_SECURITY_CHECK_FAILED APPLY_LIVE_REQUIRED`; it will not read or
write `ops.json` without an explicit mode. This demonstration does **not**
prove the live actor/controller permissions; only the preceding explicit
dry-run gate does.

## Rehearsal and approved banks

Rehearsal occurs before runtime. The current CLI has no built-in model provider
or bank writer, so the following command is a production-host integration
contract and fails closed until that adapter is installed:

```bash
npm run showrunner:rehearse -- production/episodes/stolen-map.yaml
```

For the default profile, have the configured rehearsal provider generate the
finite candidate budget, run hard validation, and obtain an explicit creator
decision for every candidate. Write only the signed finite approved bank to
`production/approvals/stolen-map.approved.json` (that runtime output is
ignored by Git). Record, per candidate/bank: provider, model,
prompt-template version, prompt hash, input/output usage, latency, hard
validation result, soft scores, candidate ID, selected variant ID, and creator
approval/rejection decision.

Repeat with a real, versioned profile change such as cadence or humor. Keep the
same safety policy and hard constraints. The two approved banks must both pass
hard validation, contain only explicit creator approvals, and have visibly
different approved text. Preserve both rehearsal records with the evidence;
do not overwrite the first record or claim visual difference from a profile
file alone.

## Human camera and OBS preparation

The real Minecraft client is the camera; Mineflayer does not produce the
recording. Before arming a take, the creator must:

1. Start the local server and the two named non-op actor runtimes through the
   authorized production host.
2. Place the real client at the declared fixed camera mark, orient it for the
   authored shot, and leave it there for the take. Camera placement is a human
   approval step, not an actor command.
3. Open OBS, choose the intended recording destination under the configured
   recording root, start recording, and wait for the configured pre-roll.
4. Confirm the intended take ID and exact recording path out of band before
   acknowledging readiness. Never send readiness or director instructions via
   Minecraft chat.

The host must record monotonic ready/start/stop timing. Readiness must precede
the first cue by the configured pre-roll; a later acknowledgement makes the
take ineligible for acceptance.

## Live take command sequence

After the required adapters, a signed approved bank, security preflight, and
human camera/OBS preparation all exist, use this sequence. These are exact
operator commands; they are not evidence that the current repository can run a
take on its own.

```bash
: "${SHOWRUNNER_OPS_PATH:?set SHOWRUNNER_OPS_PATH to the absolute live server/ops.json path}"
npm test
git diff --check
npm run showrunner:security-check -- --actors HeroActor,RivalActor --controller ProductionController --ops-path "$SHOWRUNNER_OPS_PATH" --dry-run
node src/showrunner/cli.mjs validate production/episodes/stolen-map.yaml
npm run showrunner:rehearse -- production/episodes/stolen-map.yaml
npm run showrunner -- run production/episodes/stolen-map.yaml --bank production/approvals/stolen-map.approved.json
TAKE_ID=take-id-printed-by-the-run-command
npm run showrunner -- recording-ready --take "$TAKE_ID" --path "recordings/$TAKE_ID.mkv"
npm run showrunner -- recording-stopped --take "$TAKE_ID" --path "recordings/$TAKE_ID.mkv"
npm run showrunner -- accept --take "$TAKE_ID"
```

The `run` command must print a concrete `Take ID: ...` value. Copy that exact
value and assign it literally (for example, `TAKE_ID='take-2026-08-06-001'`);
do not use the placeholder text, infer an ID, or reuse an earlier take. The
security command in the block is the explicit, read-only live permission gate;
it requires `SHOWRUNNER_OPS_PATH` to name the authorized live `ops.json` from
[Preflight](#preflight-safe-automated-checks). `--apply-live` is a separately
authorized server-administration action.

Expected live states are: rehearsal produces reviewed candidates; `run` creates
and prints one take ID but does not begin dialogue before capture readiness;
`recording-ready` records the exact ID/path and satisfies pre-roll before the
first cue; `recording-stopped` follows the host's stop request; and `accept`
is possible only from `completed` after rooted recording verification. Any
failure, missing acknowledgement, mismatched ID/path, unapproved bank, or
failed baseline/capture verification aborts or leaves the take unaccepted.

## Evidence inspection

For a completed take, inspect the host-created directory:

```text
artifacts/showrunner/{production_id}/{take_id}/
  events.ndjson
  planner-decisions.ndjson      # required for a Survival take
  survival-observations.ndjson  # required for a Survival take
  transcript.json
  validation.json
  baseline-report.json
  capture.json
  status.json
  decision.json              # created only after accept or reject
```

Use the host's rooted read interface or an authorized read-only inspection
environment; do not edit any file in a take directory. Confirm the following:

- `events.ndjson` explains each state change, causal sequence, command/event,
  revocation, and any ignored stale event.
- For a Survival take, `planner-decisions.ndjson` and
  `survival-observations.ndjson` must both exist. Every line must be strict
  schema-versioned JSON bound to this production and take and must carry the
  scene, beat, attempt, cue, goal, actor, event ID, causal sequence, monotonic
  timestamp, and observation version. Event IDs must be unique for the take;
  causal sequence numbers must not repeat within the complete identity fence.
  File order, causal time, and per-attempt/per-goal observation versions must
  not move backward.
- Inspect `planner-decisions.ndjson` for the complete deterministic chain from
  each trusted observation through `action`, `completed`, or `blocked`,
  including its reason, replan count, reservation snapshot, and selected typed
  action. Inspect `survival-observations.ndjson` for authoritative `before` and
  `after` state, including the actor's dimension, position, inventory, and
  equipment. Reconcile each decision's observation version with the matching
  observation; do not infer completion from a resolved Mineflayer promise.
- `transcript.json` has each chosen approved variant exactly once and in cue
  order; it must show no overlapping speech for this episode.
- `validation.json` records the approved-bank and hard-validation provenance.
- `baseline-report.json` verifies declared dimensions, marks, facing,
  headroom/dwell, actor state, and set baseline before dialogue continues.
- `capture.json` is `ok: true` and identifies the acknowledged recording; the
  recording is non-empty and its sidecar proves coverage from ready through
  stop using monotonic timestamps.
- `status.json` reaches `completed` before a creator decision. An accepted
  `decision.json` seals the evidence digest/size and projects `accepted` into
  `status.json`. For a Survival take, confirm the decision lists and seals both
  Survival NDJSON files. Re-run verification after the decision: verification
  must revalidate record semantics as well as every evidence digest and size.

## Required live acceptance exercises

### Happy path

Run a take using the camera and OBS steps above. From the immutable artifacts,
verify both actors reached their dimension-aware marks, faced within tolerance,
and dwelled for the configured ticks. Verify every approved line appears once
in cue order with no overlap, and that the verified recording covers the full
take. Creator acceptance is a human decision only after this review.

### Retry fencing

Use a host test fixture/fault injection to time out the first attempt while a
delayed completion callback remains pending. Do not inject a raw chat command.
The event log must show, in order: attempt revocation; actor cancellation;
quiescence acknowledgements; restoration and cleanup; successful baseline
verification; a new attempt ID; rejection of the delayed old event as
`STALE_ATTEMPT`; then second-attempt dialogue. The second attempt must start
from the first cue and must not reuse the revoked attempt's dialogue result.

### Hostile dialogue and emergency stop

In the rehearsal/host test harness, submit `/op HeroActor`, a newline command,
a profile-forbidden literal, and an unapproved line. Preserve validation/event
evidence showing each was rejected before Minecraft chat; do not test this by
sending any of them to a live server.

During a movement command, invoke the authenticated host emergency-stop
control. There is no standalone CLI emergency-stop command in this repository.
The evidence must prove the active attempt was revoked **before** actor
cancellation, all pending work was fenced, the take became aborted, and a late
completion could not change it.

## Hard reset and recovery

After any crash, failed reset, disconnect, actor death, or failed capture, do
not resume the take. Mark it aborted, retain its evidence, and have the
privileged host perform a hard verified reset: revoke the old epoch, cancel and
quiesce both actors, restore the declared actor/environment baseline, remove
the active production tag, and verify the manifest including safe headroom.
Only then create a new take and re-arm capture from the first cue. If reset or
verification fails, stop and require human inspection of the protected set.

Do not use legacy bot commands, combat scripts, arbitrary server-console
commands, or Minecraft chat as a recovery mechanism. They are outside the
typed production contract and cannot provide the required causal evidence.

## Final evidence and acceptance

The acceptance package must contain the generated event log, transcript,
validation/rehearsal provenance, baseline report, capture report and verified
recording/sidecar for the happy-path take; both planner-decision and Survival-
observation logs for every Survival take; the retry-fencing evidence; and the
hostile-dialogue/emergency-stop evidence. It must demonstrate every Live MVP
Acceptance bullet in the specification, including visibly distinct approved
style banks. If any item is missing, report `DONE_WITH_CONCERNS` (or leave the
take unaccepted), never "accepted."

Before committing documentation, run:

```bash
npm test
git diff --check
git status --short
```

Only intentional source/documentation changes may be committed. Runtime
approvals, artifacts, recordings, worlds, logs, backups, and secrets are
ignored and must not be staged.

Copy-on-write continuity is deferred until Phase 2. An accepted MVP take does
not promote persistent continuity; any future continuity branch must be
creator-approved and atomically promoted by the later Phase 2 design.

## Filming-day preflight

Use small, observable real-world validation steps. Do not treat an automated
simulation as proof that a live Minecraft host, OBS bridge, actor login, or set
is ready.

1. Run `npm test` and require zero failures.
2. Run `node src/showrunner/cli.mjs validate production/episodes/first-day-meadow.yaml`.
3. Run `node src/showrunner/cli.mjs validate production/episodes/first-day-meadow.survival.yaml`.
4. Start the local server and verify the Minecraft port accepts a connection.
5. Join as the camera player, confirm safe solid-ground placement and frame the
   meadow without entering either actor's work lane.
6. Connect the two actor runtimes without starting a take. Verify actor names,
   dimension, baseline inventory, meadow marks, animals, trees, and headroom.
7. Arm OBS and make a short disposable recording. Verify the resulting video
   and sidecar before running dialogue.
8. Run one non-recorded rehearsal through the first visible beat. Inspect the
   transcript, planner decisions, Survival observations, and reset result.
9. Reset to the declared baseline, reverify it, then start the filming take.

Stop at the first mismatch. Preserve its evidence, correct one boundary, and
repeat that step before moving to the next. A scene is filming-ready only after
all nine checks pass in the current world and current host process.

## Bounded first-day meadow live test

This test host is intentionally separate from the production/OBS acceptance
path above. It owns only `HeroActor` and `RivalActor`, uses the fixed twelve
authored lines, runs the eleven signed Survival goals, and labels capture as
`test-no-recording`. It does not create footage or satisfy filming acceptance.

1. Stop any legacy `src/bot.mjs` processes using either actor name.
2. Generate the deterministic meadow datapack with `npm run install-meadow-set`.
3. On the server console run `/reload`, then
   `/execute in minecraft:overworld run function codex_meadow:build`.
4. Run `npm run meadow-live`. If `VPNAJ` is offline it reports `WAITING` and
   keeps the actors idle; join as `VPNAJ` in the overworld.
5. Require an `ARMED` message, or say the first `begin` from the documented
   `WAITING` state to run preflight immediately before the take. Connecting
   and waiting must produce no actor movement and no actor dialogue.
6. In Minecraft chat, say exactly `begin`. A visitor, an offline operator, or
   a repeated `begin` cannot start or replay the take.
7. Say exactly `stop` to abort. Actor disconnect or death also aborts and
   requires rebuilding the set and starting a new host process.

Do not send `begin` through the server console and do not use legacy bot chat
commands to choreograph this scene. The in-game `VPNAJ` chat event is the only
start authority.
