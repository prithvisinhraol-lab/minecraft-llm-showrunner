# Bounded LLM Director Resume

Saved: 2026-08-28 18:25 America/Chicago

## Current durable state

- The bounded LLM director implementation is merged into local `main`.
- Merged implementation and live-evidence commit: `1afb006`.
- Full regression result: 598 passed, 0 failed, 0 cancelled, 0 skipped.
- Live verifier classification: `verified-live-director-handoff`; all six checks passed.
- Director run: `eeaaaad0-4cc3-4f55-8400-3a413f363de4`.
- Fast-agent run: `2ec016c8-2099-40d9-b9eb-8570a569df35`.
- Detailed evidence: `docs/llm-agent-operations.md`.
- Persistent live state remains under `persistent-llm-agent.nosync/runtime/`.
- Existing unrelated edits and untracked project artifacts in the main workspace were preserved.
- Recovery stash `pre-director-merge tracked user changes` remains as an additional backup; its changes are already restored in the main working tree.

## Safe shutdown completed

- Ran `save-all flush`; all dimensions reported saved.
- Stopped `LlmAgent` cleanly.
- Stopped the Minecraft server through its console; players and all dimensions were saved again.

## Resume commands

From `/Users/jayraol/Documents/Minecraft`, start the server:

```sh
npm run server
```

After the server reports `Done`, start the combined fast-agent/director runtime from the preserved `.nosync` worktree:

```sh
cd /Users/jayraol/Documents/Minecraft/persistent-llm-agent.nosync
npm run llm-agent
```

Join Minecraft at `localhost:25565`. Director commands are Minecraft chat text from `VPNAJ`, without `/`:

```text
director status
director start
director stop
director reset
```

Do not use `director start` again until the collection goal's prerequisite is deliberately restored: the gold marker must remain at `(54, 65, 52)` and an oak log must again be directly above it at `(54, 66, 52)`.

## 2026-09-16 survival-demo checkpoint

- Active worktree: `/Users/jayraol/Documents/Minecraft/persistent-llm-agent.nosync`
- Active branch: `codex/persistent-llm-agent`
- Latest commit: `f2ddf6e` (`fix: collect elevated tree drops reliably`)
- Earlier launcher/fix commits in this worktree: `3393f66`, `4fbbe79`, and `8a14f73`.
- The demo is a single continuous scene: collect wood, place a crafting table,
  craft a wooden pickaxe, mine eight exposed stone blocks, craft a furnace,
  walk along the set trail into the nearby village, and say exactly
  `This is gonna be great!!!`.
- The natural set is staged at the existing clearing. It includes two trees,
  eight exposed stone blocks, a walkable trail, a bell, beds, and a villager.
- The offline-mode `[Not Secure] <VPNAJ> start` chat format is accepted.
- Automated verification after the latest changes: 170/170 LLM-agent tests passed.
- A live isolated wood-only probe with `GatherCheck3` succeeded and collected
  exactly three oak logs after the elevated-log and canopy-selector fixes.
- The later full take (`runId` `9805501a-7f54-46db-b103-7909fea4cc59`) still
  failed before its first verified milestone with
  `SURVIVAL_DEMO_ITEM_NOT_COLLECTED`. Do not call the full scene filming-ready.
- Preserve the failed evidence under `runtime/survival-demo-state/`. The older
  water-route and wood-pickup failures are in its `history/` directory.
- Next session: compare the successful isolated `GatherCheck3` execution with
  the full host execution at the action boundary. Add diagnostics for selected
  log position, pre/post-dig inventory, drop entity position, actor position,
  and every path goal before making another production fix.
- Start commands after the issue is diagnosed and the scene is reset:

  ```sh
  cd /Users/jayraol/Documents/Minecraft
  npm run server
  ```

  Then, from the worktree:

  ```sh
  cd /Users/jayraol/Documents/Minecraft/persistent-llm-agent.nosync
  SURVIVAL_DEMO_LOG_PATH=/Users/jayraol/Documents/Minecraft/server-local.nosync/logs/latest.log npm run survival-demo
  ```

- The trigger is Minecraft chat text from `VPNAJ`, without `/`: `start`.
- Stop the launcher with Ctrl-C or use Minecraft chat text without `/`: `stop`.

## 2026-09-23 survival-demo live success

- Branch: `codex/persistent-llm-agent` in
  `/Users/jayraol/Documents/Minecraft/persistent-llm-agent.nosync`.
- Fixed live item collection by following the newly spawned matching drop and
  waiting for the inventory increase, rather than walking only to the broken
  block coordinate.
- Fixed slow/failed digging by waiting for Mineflayer physics to report the
  actor grounded before each dig.
- Fixed furnace crafting by returning within two blocks of the placed crafting
  table, waiting until grounded, and revalidating the live table before craft.
- Fixed final-line verification by waiting up to three seconds for the server's
  asynchronous echo of the actor's exact chat line.
- Automated verification: `node --test test/llm-agent*.test.mjs` passed all
  173 tests; `git diff --check` passed.
- Fresh live rehearsal succeeded with run ID
  `62a11167-44a0-4040-8ce5-db572567b8df`. The persisted state is `succeeded`
  after exactly seven decisions and contains all seven verified milestones:
  `wood_collected`, `crafting_table_placed`, `wooden_pickaxe_crafted`,
  `stone_mined`, `furnace_crafted`, `village_found`, and
  `final_line_spoken`.
- The server log independently contains the exact line from `LlmAgent`:
  `This is gonna be great!!!`.
- Failed diagnostic and rehearsal evidence remains preserved under
  `runtime/survival-demo-state/history/`; runtime evidence is intentionally
  untracked.
- The Minecraft server remained running after verification on local port 25565.
