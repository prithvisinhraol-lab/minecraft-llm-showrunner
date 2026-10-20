# Meadow Beat Orchestration Design

## Purpose

Keep the approved six visible story beats while allowing each beat to own as
many bounded Survival goals as genuine execution requires. Dialogue begins the
visible beat, no Survival action runs while that dialogue is held, and the next
visible beat cannot begin until every internal goal in the current beat has an
authoritative completion proof.

## Compatibility

The existing schema-v1 `dialogue_boundaries` and cue `goalId` contract remains
supported without semantic changes. The meadow episode moves to schema version
2 and uses the new beat model. Existing dialogue-only and schema-v1 Survival
episodes continue to use their current state-machine and coordinator paths.

## Schema-v2 beat model

A schema-v2 Survival episode declares exactly six ordered visible beats:

```yaml
beats:
  - id: arrival
    goal_ids: []
  - id: first_priorities
    goal_ids: []
  - id: two_trees
    goal_ids: [gather_hero_logs, gather_rival_logs]
  - id: crafting
    goal_ids:
      - regroup_hero_at_crafting_table
      - regroup_rival_at_crafting_table
      - place_crafting_table
      - craft_hero_wooden_pickaxe
      - craft_rival_wooden_pickaxe
      - equip_hero_wooden_pickaxe
      - equip_rival_wooden_pickaxe
  - id: breaking_ground
    goal_ids: [excavate_hero_lane, excavate_rival_lane]
  - id: hook
    goal_ids: []
```

Every goal appears exactly once. Flattened `goal_ids` must equal the authored
goal order, so a beat cannot skip, duplicate, or reorder internal work. Beat IDs
are unique. The six meadow showrunner cues carry matching `survivalBeatId`
values; schema-v1 cues may continue to carry a single `goalId`.

## Dialogue-first lifecycle

The schema-v2 coordinator starts in `awaiting_dialogue` and issues no actor
command. The showrunner speaks the current cue and retains its completed speech
proof. It sends a beat-scoped `dialogueCompleted` handshake to the coordinator
without advancing the cue.

For an empty beat, the coordinator immediately emits authoritative
`beatCompleted`. For a nonempty beat, it executes only that beat's internal
goals through the existing observe, plan, authorize, reserve, dispatch, prove,
and re-observe loop. It emits `beatCompleted` only after all goal groups in that
beat complete. The showrunner then commits the held speech to the transcript and
advances to the next visible cue. The next cue therefore cannot overlap the
previous beat's Survival critical work.

`beatCompleted` is fenced to production, take, scene, cue, beat, attempt, causal
sequence, and authoritative proof. Stale, wrong-beat, premature, and duplicate
handshakes or completions do not advance either component.

## Genuine two-actor resource flow

Both actors gather three logs from separate approved tree regions. During
Crafting, both regroup at the table, Hero places the table, each actor crafts one
wooden pickaxe from its own gathered inventory, and each equips its own tool.
There are no item grants, server-command fallbacks, or fabricated final states.

Breaking Ground has two actor-scoped excavation goals and two non-overlapping
regions. Hero owns the six approved cells in the first lane; Rival owns the five
approved cells in the second lane. Each goal uses an actor-inventory completion
predicate, so one actor's cobblestone cannot satisfy the other's work. The final
mutation set must equal the union of both authored lanes.

## Artifact absence integrity

New schema-v2 decisions list the evidence files included in their acceptance
digest. Verification checks each listed file's size and SHA-256 and also checks
that every known optional Survival evidence file omitted from the manifest is
still absent. This check runs on every `verify()` call after acceptance, so
injecting either optional file or the pair after sealing fails closed with
`ARTIFACT_EVIDENCE_MISMATCH`.

The atomic decision commit continues to compare optional-file absence observed
before sealing. Schema-v1 acceptance verification remains compatible with its
recorded evidence keys.

## Verification

Tests must prove dialogue-first ordering, empty-beat completion, multiple goals
within one visible beat, no action during held dialogue, stale-event fencing,
per-actor crafting and equipment, separate-lane excavation, exact mutations,
resource conservation, and post-acceptance optional-evidence injection failure.
The focused Task 6 tests, full repository suite, schema-v2 CLI validation, and
diff hygiene must all pass before commit.
