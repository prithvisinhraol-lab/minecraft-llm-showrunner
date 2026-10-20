# Nether Hub Litematic Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste the Nether Hub litematic into the Nether with natural terrain support under and around it.

**Architecture:** Use a generated datapack to paste the litematic in scheduled batches. Use server-console commands for site preparation, natural supports, datapack reload/function execution, teleport, verification, cleanup, and saving.

**Tech Stack:** Node.js, prismarine-nbt, Minecraft Java 1.21.4 datapack functions, server console.

## Global Constraints

- Paste in `minecraft:the_nether`.
- Keep a safe landing point at `300.5 80 300.5`.
- Paste minimum corner is `255 78 256`.
- Map `minecraft:iron_chain` to `minecraft:chain`.
- Make the build look naturally supported, not floating.
- Save the world after construction.

---

### Task 1: Generate Datapack

- [ ] Create `server/world-1.21.4/datapacks/codex_nether_hub_paste` with a pack file and scheduled functions.
- [ ] Decode `/Users/jayraol/Downloads/Nether Hub.litematic`.
- [ ] Emit only non-air `setblock` commands in batches of 900 commands.
- [ ] Add final verification, safe teleport, force-load cleanup, and `save-all`.

### Task 2: Prepare Natural Site

- [ ] Force-load the paste area in the Nether.
- [ ] Clear the bounding volume enough for the hub.
- [ ] Add uneven blackstone/basalt/netherrack support below the footprint.
- [ ] Keep the landing pad clear.

### Task 3: Paste And Verify

- [ ] Reload datapacks.
- [ ] Run `function codex_nether_hub:paste/start`.
- [ ] Wait for scheduled batches to finish.
- [ ] Verify the completion message and saved game.
