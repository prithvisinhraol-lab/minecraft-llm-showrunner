# AI Minecraft Server README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the README so it clearly documents the project's AI-play mission, current interaction architecture, completed world work, and future unified-interface direction.

**Architecture:** Keep the README as the single introductory project document. Preserve working setup and bot-command instructions while reorganizing them beneath the mission, current architecture, capabilities, world locations, and future-direction sections.

**Tech Stack:** Markdown, Minecraft Java 1.21.4, Mineflayer, vanilla server console, Minecraft datapacks.

## Global Constraints

- State that the purpose is to let a player play and collaborate with an AI inside a persistent Minecraft server.
- Describe Mineflayer, server-console commands, and datapacks as separate current interaction paths.
- Present a unified safety-controlled AI bridge as a direction to evaluate, not an implemented capability.
- Preserve Java version `1.21.4`, address `127.0.0.1:25565`, setup commands, bot commands, and the local-only security warning.
- Include known completed-build coordinates.

---

### Task 1: Rewrite and Verify the README

**Files:**
- Modify: `README.md`
- Modify: `package.json` (scope the documented test command to repository tests so archived dependencies are excluded)

**Interfaces:**
- Consumes: the approved design in `docs/superpowers/specs/2026-08-05-ai-server-readme-design.md`.
- Produces: a self-contained project overview and operational quick start.

- [ ] **Step 1: Rewrite the README structure**

Replace the generic opening with sections named `Mission`, `How AI Interacts Today`, `Current Capabilities`, `World Projects`, `Future Direction`, `Quick Start`, `In-Game Bot Commands`, and `Security Notes`. Preserve all valid commands from the existing README.

- [ ] **Step 2: Check required facts**

Run:

```sh
rg -n 'play alongside|Mineflayer|server console|datapack|unified|1\.21\.4|127\.0\.0\.1:25565|532 92 44|5044 65 2348|300 80 300|900 86 -360|online-mode=false' README.md
```

Expected: every required mission, architecture, location, version, address, and safety term appears.

- [ ] **Step 3: Check formatting and repository tests**

Run: `git diff --check -- README.md && npm test`

Expected: no whitespace errors and all tests pass.

- [ ] **Step 4: Commit**

Run:

```sh
git add README.md
git commit -m "Update README with AI server mission"
```
