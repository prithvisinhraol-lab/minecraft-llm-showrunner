# First Day in the Meadow Scene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a readable, filmable two-character Minecraft opening script with dialogue and explicit cues for meadow arrival, movement, tree gathering, crafting, and the start of a mine.

**Architecture:** Store the deliverable as a Markdown shooting script under `production/scripts/`. Use consistent beat, camera, actor-action, dialogue, completion, and recovery labels so a human can film it now and a later showrunner action extension can translate the cues without rewriting the story.

**Tech Stack:** Markdown, Node.js built-in test runner, repository showrunner terminology

## Global Constraints

- The scene is family-friendly, natural, and lightly comedic.
- The practical character uses dry understatement and task-focused observations.
- The energetic character uses confident guesses, quick reactions, and harmless self-correction.
- Dialogue lines generally remain under 16 words.
- The scene contains exactly six ordered beats: Arrival, First Priorities, Two Trees, Crafting, Breaking Ground, and Hook.
- Every beat includes camera direction, separate actor cues, dialogue, a completion condition, and recovery behavior.
- Action cues use `prepare -> execute -> observe -> confirm` semantics and never grant operator or arbitrary-command access.
- The document must distinguish currently filmable direction from mining/crafting cues that require a future safe action-runtime extension.

---

### Task 1: Author and validate the production script

**Files:**
- Create: `production/scripts/first-day-meadow.md`
- Create: `test/first-day-meadow-script.test.mjs`

**Interfaces:**
- Consumes: the approved design in `docs/superpowers/specs/2026-08-06-first-day-meadow-scene-design.md`
- Produces: a shooting script whose stable section labels are `## Beat N`, `**Camera**`, `**Practical action**`, `**Energetic action**`, `**Dialogue**`, `**Complete when**`, and `**Recovery**`

- [ ] **Step 1: Write the failing structural test**

Create `test/first-day-meadow-script.test.mjs` with these assertions:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const scriptPath = new URL('../production/scripts/first-day-meadow.md', import.meta.url);

test('first-day meadow script contains six complete production beats', async () => {
  const script = await readFile(scriptPath, 'utf8');
  const beats = script.split(/^## Beat \d+ — /m).slice(1);

  assert.equal(beats.length, 6);
  assert.deepEqual(
    [...script.matchAll(/^## Beat \d+ — (.+)$/gm)].map((match) => match[1]),
    ['Arrival', 'First Priorities', 'Two Trees', 'Crafting', 'Breaking Ground', 'Hook']
  );

  for (const beat of beats) {
    for (const label of ['**Camera**', '**Practical action**', '**Energetic action**', '**Dialogue**', '**Complete when**', '**Recovery**']) {
      assert.ok(beat.includes(label), `missing ${label}`);
    }
  }
});

test('dialogue and action cues cover the required first-day progression', async () => {
  const script = await readFile(scriptPath, 'utf8');

  for (const required of [
    'nearest_reachable_oak_log',
    'inventory oak_log >= 3',
    'craft oak_planks',
    'place crafting_table',
    'craft wooden_pickaxe',
    'inventory cobblestone >= 11',
    'prepare -> execute -> observe -> confirm'
  ]) assert.match(script, new RegExp(required));

  assert.match(script, /Current runtime boundary/);
  assert.doesNotMatch(script, /\b(?:TBD|TODO|PLACEHOLDER)\b/);
});
```

- [ ] **Step 2: Run the focused test and verify the missing-script failure**

Run: `node --test test/first-day-meadow-script.test.mjs`

Expected: FAIL with `ENOENT` for `production/scripts/first-day-meadow.md`.

- [ ] **Step 3: Write the six-beat shooting script**

Create `production/scripts/first-day-meadow.md`. Begin with the title, cast descriptions, set description, runtime boundary, and cue legend. Use the exact stable labels from the interface block in every beat.

The required story progression is:

1. Arrival establishes the meadow and contrasting personalities.
2. First Priorities establishes sunset as the deadline and wood as the immediate goal.
3. Two Trees sends each character to a reserved `nearest_reachable_oak_log` until each reaches `inventory oak_log >= 3`.
4. Crafting regroups both characters and cues `craft oak_planks`, `place crafting_table`, and `craft wooden_pickaxe`.
5. Breaking Ground creates a safe two-wide mine entrance and continues until shared inventory reaches `inventory cobblestone >= 11`.
6. Hook uses a coal discovery or animal interruption to transition toward shelter-building.

Write two to four short spoken lines per beat. Put optional improvisation guidance after the fixed exchange, but keep plot advancement in the authored lines. Each recovery section must name a concrete fallback: alternate target selection, safe-mark reset, item pickup, or retry without duplicate crafting.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test test/first-day-meadow-script.test.mjs`

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Review the script as dialogue and production direction**

Run:

```bash
rg -n '^## Beat|^\*\*(Camera|Practical action|Energetic action|Dialogue|Complete when|Recovery)\*\*' production/scripts/first-day-meadow.md
rg -n '\b(TBD|TODO|PLACEHOLDER)\b' production/scripts/first-day-meadow.md
git diff --check
```

Expected: six beat headings; all six labels appear once in each beat; the placeholder scan has no output; `git diff --check` has no output.

- [ ] **Step 6: Run the repository test suite**

Run: `node --test test/*.test.mjs`

Expected: all tests pass with 0 failures.

- [ ] **Step 7: Commit the script and its structural test**

```bash
git add production/scripts/first-day-meadow.md test/first-day-meadow-script.test.mjs
git commit -m "feat: add first-day meadow shooting script"
```
