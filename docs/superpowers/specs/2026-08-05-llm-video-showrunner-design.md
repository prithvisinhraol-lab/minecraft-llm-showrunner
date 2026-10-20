# LLM Minecraft Video Showrunner Design

Status: approved by creator on 2026-08-05

## Goal

Create a production-oriented way for AI-controlled Minecraft characters to perform scenes for video content. A human creator controls story beats, dialogue style, staging, safety, and required outcomes. AI assists with characterful dialogue and later with bounded improvisation, but deterministic software controls the production.

The first deliverable is intentionally narrow: a repeatable, recordable two-actor dialogue take on one static set. Broader autonomy is deferred until this production loop is reliable.

## Product Principles

1. **Directed, not autonomous.** Required plot transitions come from the episode specification and approved dialogue, never from unconstrained improvisation.
2. **Hard rules are deterministic.** Speaker order, exact wording, approved variants, length, forbidden text, marks, timeouts, and fallbacks are enforced in code.
3. **Style is creator-guided.** Models can propose lines matching a character profile, but the creator approves the finite line bank used by the MVP.
4. **One authority per fact.** Minecraft telemetry decides physical facts, validation and creator approval decide dialogue facts, and take acceptance decides canon.
5. **Safe actions by default.** Actors are non-operator clients with a small typed API. Privileged operations use a separate production controller.
6. **Retries cannot leak.** Every command and event belongs to a production, take, scene, beat, attempt, and cue. Stale work is rejected.
7. **Recording is part of success.** A take is not successful unless the real capture path acknowledges readiness and produces a verified artifact.
8. **Repeatable means controlled.** The same inputs should preserve cue order, constraints, and outcomes; identical pixels or timing are not required.

## Selective Use of Prior Work

The design borrows ideas rather than adopting one project wholesale:

- **Mindcraft:** character profiles, model-provider flexibility, Mineflayer embodiment, and structured tasks.
- **MC-CIV:** brain/body separation, typed model output, interruptible actions, and event-driven coordination.
- **Minecraft Agent Swarm:** production monitoring, per-actor status, and eventual OBS/TTS integration.
- **Minecraft MCP servers:** a small typed boundary between model reasoning and game execution.
- **Voyager:** reusable skills, environment feedback, verification, and failure-informed retries.

The existing Minecraft Java 1.21.4 server and Mineflayer code are the starting environment, but existing chat-command and operator privileges are not the security model for this system.

## MVP: Two-Actor Directed Dialogue Take

The MVP includes:

- One isolated, static, nondestructive set.
- One scene with two actors and two or three sequential cues.
- Dimension-aware named marks.
- Exact lines and creator-approved variants.
- Character profiles and a rehearsal step that generates candidate variants.
- One deterministic in-process showrunner.
- Two non-operator Mineflayer actors.
- A separate privileged production controller.
- One whole-scene retry after a verified reset.
- A fixed or prepositioned real Minecraft client captured by OBS.
- A transcript, structured event log, validation results, selected variants, take status, and recording path.

The MVP explicitly excludes block mutation, crafting, gathering, combat, persistent character memory, durable continuity, TTS, subtitles, a dashboard, dynamic camera operation, multi-scene episodes, and live free improvisation. These are roadmap items, not hidden Phase 1 requirements.

## Authoring Model

### Episode Source

Episodes are versioned YAML source files. Schema errors report the source path and YAML line/column when available. The minimal MVP schema contains:

- Schema version, episode ID, title, and content rating.
- Two actors and their profile references.
- Set identity and baseline-manifest reference.
- One scene and its dimension.
- Named marks with position and facing.
- Ordered cues.
- Dialogue constraints, approved line variants, timeouts, and fallback lines.
- One whole-scene retry policy.

Marks contain `dimension`, `x`, `y`, `z`, `yaw`, `pitch`, `radius`, `dwell_ticks`, and a safe-headroom requirement. Episode loading fails if referenced profiles, marks, manifests, actors, or approved line banks do not exist.

### Example

```yaml
schema_version: 1
episode: stolen_map
title: The Stolen Map
content_rating: family

actors:
  hero: profiles/hero.yaml
  rival: profiles/rival.yaml

set:
  id: city_square_dialogue
  baseline_manifest: sets/city_square_dialogue.v1.json

scene:
  id: confrontation
  dimension: minecraft:overworld
  marks:
    hero_start:
      position: {x: 532.5, y: 92, z: 44.5}
      facing: {yaw: -90, pitch: 0}
      radius: 0.8
      dwell_ticks: 10
      safe_headroom: true
    rival_start:
      position: {x: 540.5, y: 92, z: 44.5}
      facing: {yaw: 90, pitch: 0}
      radius: 0.8
      dwell_ticks: 10
      safe_headroom: true

  dialogue_policy:
    maximum_words_per_line: 18
    forbidden_literals: ["subscribe now"]
    forbidden_patterns: ["(?i)modern internet slang"]
    allow_overlap: false

  cues:
    - id: rival_reveal
      speaker: rival
      mark: rival_start
      required_intent: reveal possession of the stolen map and challenge the hero
      approved_variants:
        - "Looking for this map? Come take it from me."
        - "Your precious map is mine. Try to reclaim it."
      fallback_line: "I have the map. Come and take it."
      timeout_seconds: 12

    - id: hero_reply
      speaker: hero
      mark: hero_start
      required_intent: refuse to surrender and promise to recover the map
      approved_variants:
        - "Keep smiling. I'm still taking that map back."
        - "You won't hold it for long."
      fallback_line: "I will take the map back."
      timeout_seconds: 12

retry:
  whole_scene_attempts: 2
```

`required_intent` guides rehearsal generation and creator review. At runtime it is metadata; it does not permit an unapproved model-generated line to satisfy a cue.

### Character Profiles

Each profile defines:

- Identity and relationship to the other actor.
- Voice, vocabulary, cadence, and humor.
- Emotional range and scene-specific attitude.
- Preferred and forbidden subjects or phrases.
- Maximum line length.
- Positive examples showing the desired dialogue style.
- Model and generation settings used during rehearsal.

Policy precedence is deterministic, from strongest to weakest:

1. Content-rating rules.
2. Global safety rules.
3. Character-profile restrictions.
4. Scene policy.
5. Cue policy.
6. Exact or approved fallback line.

A weaker rule cannot override a stronger one.

## Dialogue Workflow

### Rehearsal

Required-intent and guided-improvisation prompts run before the take. The system:

1. Combines the character profile, scene context, required intent, and constraints.
2. Requests a bounded number of candidate lines.
3. Applies deterministic hard validation.
4. Displays valid candidates and soft style assessments to the creator.
5. Stores only creator-approved candidates in the take's finite variant bank.

The rehearsal record stores provider, model, prompt-template version, prompt hash, token usage, latency, validation results, and creator decision. Provider calls have explicit input/output token limits, timeout, retry count, and candidate-count budgets.

### Runtime

The runtime selects an exact line, an approved variant, or the authored fallback. It never asks an LLM for a required line during an active take.

Hard validation checks:

- Line belongs to the approved bank or equals the authored exact/fallback line.
- Correct speaker and cue order.
- Maximum word and Minecraft chat-length limits.
- Literal and regular-expression bans.
- No leading slash, newline, control character, or command-like payload.
- Content-rating and safety rules.
- The line can be split only according to an authored split plan; otherwise it is rejected.

Tone, humor, exposition, and character fit are soft review scores. They inform rehearsal and creator approval but do not masquerade as deterministic truth. A future semantic evaluator must support confidence, abstention, labeled evaluation cases, and a human gate before it can affect required plot transitions.

Live free improvisation may later be used for optional flavor, but it cannot carry required intent or advance a beat until separately approved.

## Runtime Architecture

### Showrunner

The showrunner is one in-process deterministic state machine and the sole writer of production state. It:

1. Validates the episode, profiles, approved line bank, and baseline manifest.
2. Creates a production and take epoch.
3. Invokes a verified baseline reset.
4. Waits for both actors and capture readiness.
5. Places actors at marks and verifies position, orientation, headroom, and dwell.
6. Dispatches one cue at a time.
7. Waits for acknowledged completion and authoritative observations.
8. Completes, retries, or aborts the take according to bounded policy.
9. Verifies the recording artifact.
10. Writes final artifacts and waits for creator acceptance.

The MVP has one speaker token and no overlapping dialogue. Future parallel cues must declare an explicit parallel group and completion barrier.

### Actor Runtime

Each Mineflayer actor is non-operator and exposes only:

- `moveToMark(mark)`
- `lookAt(target)`
- `speak(validatedLine)`
- `observe(scope)`
- `cancel(attemptId)`

Actors cannot execute arbitrary chat commands, shell commands, generated code, RCON, or server-console operations. Player chat is untrusted observation and never a director-control channel.

### Production Controller

A separate privileged principal performs typed, allowlisted operations required to prepare and reset a take. It does not accept natural-language commands. Parameters are validated and converted to fixed command templates; untrusted text is never interpolated into a server command.

Its MVP operations are limited to:

- Teleporting named production actors to validated safe marks.
- Restoring actor position, orientation, inventory, health, food, and effects.
- Setting declared time and weather.
- Removing entities tagged with the active production ID.
- Reading and verifying the set baseline manifest.
- Starting an emergency stop that revokes the active attempt.

Actor accounts must be removed from `server/ops.json` before LLM-directed execution. Server-side region protection must enforce the static set boundary independently of actor cooperation.

## Causal Event and Command Protocol

Every command and event carries:

- `production_id`
- `take_id`
- `scene_id`
- `beat_id`
- `attempt_id`
- `cue_id`
- `event_id`
- `causal_sequence`
- `monotonic_timestamp`

Commands also carry an idempotency key. The state writer rejects duplicate keys, duplicate event IDs, events with a stale attempt epoch, and events whose causal sequence violates the current cue state. Wall-clock time may be logged for humans but never orders production events.

Dispatch follows a central serialized scheduler:

1. Issue one typed command.
2. Receive an acknowledgement tied to its idempotency key.
3. Receive completion or failure tied to the same attempt and cue.
4. Verify the resulting authoritative observation.
5. Cross a completion barrier before dispatching the next cue.

Late model results, navigation results, chat events, timers, and disconnect callbacks from a revoked attempt are recorded as stale and cannot mutate active state.

## Reset and Retry Semantics

The MVP uses an isolated static set and prohibits block mutation. It does not claim to snapshot and restore an arbitrary Minecraft world.

The versioned baseline manifest records:

- Set identifier, version, dimension, protected region, and expected checksum or sampled block assertions.
- Actor marks, facing, inventories, health, food, and effects.
- Time, weather, and applicable gamerules.
- Allowed persistent entities and production-tag cleanup rules.

A retry is transactional:

1. Revoke the active attempt epoch.
2. Cancel actor commands and timers.
3. Wait for bounded quiescence acknowledgements.
4. Restore the declared actor and environment baseline.
5. Remove production-tagged entities.
6. Verify the baseline manifest and safe headroom.
7. Create a new attempt epoch.
8. Re-arm capture and begin from the first cue.

If cancellation, quiescence, restoration, or verification fails, the take aborts. The MVP does not resume after a process crash; restart means abort, perform a hard verified reset, and create a new take.

## Camera and Recording Contract

A Mineflayer bot does not render usable video. The MVP camera is the creator's real Minecraft client, manually placed at a declared fixed shot or prepositioned before the take, with OBS performing capture.

The capture handshake is:

1. Showrunner declares the intended take and recording filename.
2. Creator positions the real client and starts OBS.
3. Creator sends an out-of-band `recording_ready` acknowledgement containing the take ID and output path.
4. Showrunner waits for the configured pre-roll before the first cue.
5. On take completion or abort, showrunner emits `recording_stop_requested`.
6. Creator or capture adapter acknowledges `recording_stopped`.
7. Showrunner verifies that the artifact exists, is non-empty, and covers the take's monotonic start/end interval through capture metadata or sidecar timestamps.

The event log is the timing source for cue order. Future TTS and subtitles must use a stable `utterance_id`; subtitle timing derives from acknowledged audio playback start/end, not from text-generation time.

## Failure Policy

- **Invalid episode or line bank:** do not arm the take.
- **Actor unavailable or misplaced:** abort preparation; no dialogue is sent.
- **Actor stuck:** cancel the attempt and perform the single whole-scene retry.
- **Actor death or disconnect:** revoke the attempt and retry or abort.
- **Cue timeout:** use the authored fallback only if the speaker is still valid and no conflicting speech was emitted; otherwise retry the whole scene.
- **Duplicate, late, or out-of-order event:** record and ignore it.
- **Reset verification failure:** abort and require human inspection.
- **Capture not ready or artifact verification failure:** the take cannot be accepted.
- **Provider failure during rehearsal:** use already approved variants or authored fallbacks; no provider call is required during the take.
- **Emergency stop:** revoke the attempt, fence all pending work, cancel actors, and abort the take.

All retries, model calls, tokens, commands, and wall time are bounded. Paused provider time is relevant only during rehearsal and does not extend a live take deadline.

## Take Artifacts and Acceptance

Each take produces:

- Versioned episode and profile references.
- Production, take, and attempt identifiers.
- NDJSON command/event log.
- Dialogue transcript with cue IDs and chosen variant IDs.
- Hard-validation results and rehearsal approval provenance.
- Actor mark and dwell verification.
- Reset/baseline verification results.
- Capture acknowledgements and recording artifact path.
- Final state: prepared, completed, aborted, rejected, or accepted.

Failed and retried attempts remain in the production log but cannot become canon. Persistent memory and continuity are deferred. When later introduced, each take will use a copy-on-write branch; creator acceptance atomically promotes eligible continuity, while rejection discards the branch.

## Test Strategy

### Unit Tests

- Versioned YAML and profile validation with source locations.
- Policy precedence and hard dialogue constraints.
- Chat injection rejection and line-splitting rules.
- State transitions, retry budgets, and timeout handling.
- Idempotency, stale-attempt rejection, and causal sequencing.
- Predicate scoping to actor, attempt, cue, dimension, radius, and dwell window.

### Contract Tests

- Actor acknowledgements, completion, cancellation, and observation results.
- Production-controller allowlists and validated command construction.
- Capture readiness, stop acknowledgement, and artifact metadata.
- Baseline restore and manifest verification.

### Simulation Tests

- Duplicate and out-of-order events.
- A completion arriving after its attempt is revoked.
- Emergency stop while movement or speech is pending.
- Forbidden dialogue candidate rejected before chat.
- Fallback behavior stays within declared bounds.
- Retry produces a new epoch and ignores every prior-epoch callback.
- Reset mismatch prevents a new attempt.

### Live MVP Acceptance

The MVP is accepted only when all of the following are demonstrated:

- Both actors reach the correct dimension-aware marks, face within the declared tolerance, and dwell for the specified ticks.
- Each approved line is spoken exactly once and in cue order.
- No speech overlaps unless a future episode explicitly declares a parallel group.
- A forbidden or command-like candidate is rejected before Minecraft chat.
- A deliberately delayed prior-attempt event is ignored after retry.
- A retry restores and verifies the versioned baseline before dialogue resumes.
- `recording_ready` precedes the first cue, and the verified recording artifact covers the take.
- Changing a character style profile yields a visibly different but still compliant approved variant bank and take.
- The transcript and event log explain every state transition and selected line.

## Delivery Roadmap

### Phase 0: Repository and Security Baseline

- Inventory tracked and untracked source, tests, scripts, configuration, and lockfiles.
- Establish a reproducible test baseline using the repository's scoped test command.
- Remove actor accounts from operator privileges.
- Define the privileged production-controller identity and server-side set protection.
- Freeze one isolated static set and create its versioned baseline manifest.

### Phase 1: Two-Actor Directed Dialogue Take

- Versioned episode and character-profile schemas.
- Rehearsal candidate generation and creator approval workflow.
- Deterministic showrunner, causal protocol, and bounded whole-scene retry.
- Two non-operator actor runtimes with the five-action API.
- Typed production adapter and verified baseline reset.
- Real-client/OBS readiness handshake and artifact verification.
- NDJSON logs, transcript, validation evidence, and take status.

### Phase 2: Production Workflow

- Dashboard and explicit creator controls.
- Multiple scenes and richer shot planning.
- Automated OBS adapter.
- TTS and subtitles based on playback acknowledgements.
- Take review and copy-on-write continuity promotion.

### Phase 3: Expanded Agency

- Optional live flavor improvisation that cannot gate plot progress.
- Evaluated semantic validation with confidence and abstention.
- Bounded gameplay skills and nondestructive interaction.
- Dynamic camera clients and multi-actor ensembles.
- Persistent memory and relationship development.
- Evaluation of an MCP-compatible external control interface.

### Phase 4: Destructive or Combat Scenes

- Snapshot/restore strategy proven against the supported world scope.
- Server-enforced region and damage controls.
- Planned combat choreography and deterministic outcome verification.
- Dedicated safety and reset acceptance tests before production use.

## Decision Gate

The approved implementation plan must map every Phase 0 and Phase 1 requirement to repository files, tests, verification commands, and migration steps for the current bot privileges and chat-command interface.
