# Showrunner Resume Note

Date saved: 2026-08-10

## Current state

- Branch: `main`
- Checkpoint parent commit: `bfe3312` (`docs: checkpoint partial meadow rehearsal`)
- The bounded first-day meadow host is implemented and merged.
- Start authority is exactly the in-game word `begin` from online player `VPNAJ`.
- The take contains exactly 12 authored dialogue lines and 11 bounded Survival goals.
- A repeated `begin`, another player, actor death/disconnect, or `stop` fails closed.
- The deterministic meadow datapack is installed at
  `server/world-1.21.4/datapacks/codex_meadow`.
- The live meadow was rebuilt successfully. The last verified idle actor marks were:
  - `HeroActor`: `48.5 65.0 48.5`
  - `RivalActor`: `56.5 65.0 48.5`
- A live take started at `2026-08-08 14:09:16` after `VPNAJ` said `begin`.
  It spoke the first six authored lines through the `two_trees` exchange, then
  aborted before Survival execution with `PLANNER_OBSERVATION_INVALID`.
  `HeroActor` and `RivalActor` disconnected immediately after the fail-closed
  abort. Treat this as a discarded partial rehearsal, not a completed take.
- Live startup on 2026-08-08 proved the host reaches `ARMED` with all three
  players online after `VPNAJ` is placed on solid ground in Creative mode.
- The host now waits for the complete operator entity before preflight and
  accepts this offline server's unsigned `<VPNAJ> begin` chat format.
- macOS/iCloud initially materialized `node_modules` very slowly. The required
  Mineflayer dependencies were read successfully during the live startup; do
  not launch a duplicate host if module loading is quiet but its process exists.
- Full automated verification passed 449/449 before the final connection-recovery
  adjustment. After that adjustment, all 17 live-host tests and the new initial-death
  regression test passed. A later heavily parallel full run had one unrelated timing
  assertion fail; that exact test passed when rerun alone.
- This resume note is committed so the next session can recover the exact state.
- `TRANSFER_TO_NEW_MAC.md` remains an unrelated untracked user file.

## 2026-08-10 rehearsal fix checkpoint

- The failed rehearsal has two confirmed code causes:
  1. `src/showrunner/survival-planner.mjs` defines JSON-safe numbers as safe
     integers, but live Mineflayer positions and Euclidean target distances are
     finite decimals (for example `48.5` and `sqrt(3)`). This causes the first
     live observation to fail with `PLANNER_OBSERVATION_INVALID`.
  2. `createServerSpeechObserver` confirms chat delivery but applies no hold
     after a line, so successive dialogue proofs release almost immediately.
- Both production fixes are implemented:
  - the planner accepts all finite JSON numbers while retaining integer checks
    on fields that semantically require integers;
  - server-observed actor chat now holds each line for a readable word-based
    0.9 to 3.5 second interval before releasing the next proof (2520 ms for the
    first line).
- The lightweight server speech observer now lives in
  `src/showrunner/server-speech-observer.mjs`; the production module re-exports
  it, so behavior is unchanged at existing call sites while tests avoid the
  expensive Mineflayer import.
- Verification on 2026-08-10:
  - focused planner and speech tests: 51/51 passed;
  - coordinator, observer, host, and full genuine Survival integration passed;
  - full command `node --test test/*.test.mjs`: 455/455 passed.
- The code is ready for a new live rehearsal, but no live take has been started.
  Start only when `VPNAJ` is online and says exactly `begin`.

## Next-session start procedure

Run these steps incrementally and stop at the first mismatch:

1. Start the server from the repository root:

   ```bash
   npm run server
   ```

2. Wait for the server to report `Done` and verify port `25565`.
3. Start the dedicated owned-actor host:

   ```bash
   npm run meadow-live
   ```

4. Wait for both `HeroActor` and `RivalActor` to join. The host may report
   `WAITING` while `VPNAJ` is offline. Do not use the legacy `npm run bot` actors.
5. From the server console, reset the online actors and set together:

   ```text
   execute in minecraft:overworld run function codex_meadow:build
   ```

6. Verify both actor positions are the two idle marks listed above and that neither
   actor speaks or moves.
   Do not continue from the discarded partial rehearsal; this must be a fresh
   take from the rebuilt idle marks.
7. Join as `VPNAJ`. Stand on safe solid ground in the overworld.
   For the verified camera mark use Creative mode at `52.5 65 46.5`.
8. In Minecraft chat, say exactly `begin`. From `WAITING`, this first command runs
   live preflight and then starts; from `ARMED`, it starts immediately.
9. Say exactly `stop` to abort. Rebuild the set and restart the host after any abort.

## Important files

- `src/showrunner/live-meadow-cli.mjs`
- `src/showrunner/live-meadow-production.mjs`
- `src/showrunner/server-speech-observer.mjs`
- `src/showrunner/live-meadow-host.mjs`
- `src/showrunner/live-meadow-set.mjs`
- `production/episodes/first-day-meadow.yaml`
- `production/episodes/first-day-meadow.survival.yaml`
- `production/scripts/first-day-meadow.md`
- `docs/showrunner-operations.md`
- `docs/superpowers/specs/2026-08-07-bounded-live-meadow-host-design.md`
- `docs/superpowers/plans/2026-08-07-bounded-live-meadow-host.md`

## Shutdown completed for this checkpoint

- The owned live meadow host exited fail-closed after the partial take described
  above; there is no remaining actor-host process.
- The Minecraft server received `save-all` before shutdown.
- Restart from the procedure above; no implementation work needs to be repeated.
