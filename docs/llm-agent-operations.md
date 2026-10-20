# LLM agent incremental live validation

## Generated survival-goal pipeline

This is the current multi-goal MVP. One shared `LlmAgent` Mineflayer character is controlled by two separate Codex calls: a 90-second slow planner creates the next bounded contract, and a 30-second fast controller chooses actions inside the current contract. The slow planner may work one goal ahead, but generated text never gains direct Minecraft authority. Code-owned permissions, compilation, action verification, and goal predicates remain in control.

Persistent files:

- Supervisor state: `runtime/llm-goal-pipeline-state/LlmAgent.pipeline.json`
- Controller-owned live evidence: `runtime/llm-goal-pipeline-state/LlmAgent.pipeline.live-evidence.json`
- Slow-provider temporary files: `runtime/llm-goal-pipeline-state/.slow-codex-tmp`
- Fast-provider temporary files: `runtime/llm-goal-pipeline-state/.fast-codex-tmp`

Start the local server in one Terminal:

```sh
npm run server
```

Start the single shared bot host in a second Terminal:

```sh
npm run llm-agent
```

Join Minecraft Java `1.21.4` at `127.0.0.1:25565`. Press `T` to open chat. Only the player `VPNAJ` is authorized to send the following commands, and none has a leading `/`:

```text
pipeline start
pipeline status
pipeline stop
pipeline resume
pipeline reset
pipeline mission survive and progress toward stone tools
pipeline urgent retreat to safety
pipeline answer <choiceId>
```

`pipeline mission ...` changes the mission for subsequent planning. `pipeline urgent ...` also aborts current fast work. If the planner asks a question, answer only with one of the two or three displayed choice IDs; after at most 30 seconds the declared safe default is selected and the planner must create a fresh contract. `pipeline reset` deliberately removes both supervisor state and accumulated live evidence.

The state is bounded to 90 minutes, ten completed goals, 20 slow calls, 400 fast calls, three consecutive goal failures, three consecutive generation failures, five outcomes, ten failure fences, and 40 audit events. One active goal and at most one speculative successor are allowed. The runtime accounts elapsed time across an interrupted running session and does not refresh budgets on resume.

For a safe shutdown, first type `pipeline stop` in Minecraft chat, wait for its confirmation, and then press Ctrl-C in the bot Terminal. Restart `npm run llm-agent` and type `pipeline resume` to continue preserved state. On death, disconnect, a stale contract, or a protected-resource attempt, inspect `pipeline status` and the terminal before resuming. Do not edit the JSON state by hand.

### Generated-pipeline live acceptance

Automated tests establish code behavior, not real Minecraft success. The live test must be user-gated and use a fresh survival clearing separate from the meadow and gold-marker tests. Before starting, independently confirm safe ground and headroom, reachable oak and stone, an empty `LlmAgent` inventory, no nearby hazard, `VPNAJ` online, and exactly one `LlmAgent` process. Then type `pipeline start` yourself in Minecraft chat.

For the default stone-tools mission, the controller stops successfully only after deterministic live evidence proves a stone pickaxe is in inventory. The persisted audit must also prove that successor generation overlapped predecessor execution and that promotion used a newer observation. After independently confirming the final inventory/world state from the server console, run immediately:

```sh
LLM_PIPELINE_WORLD_CHECK=completed-ok npm run llm-pipeline:verify-live
```

Expected classification is `verified-live-generated-pipeline` with all eight checks true. The verifier fails closed for scripted, simulated, stale, actor-mismatched, contract-mismatched, over-budget, non-overlapped, stale-promotion, unverified-extra-goal, or missing server-world evidence. Do not report live acceptance until this command passes against evidence from the real run.

## Bounded LLM director

The director is the slow goal-setting layer above the fast Minecraft action agent. It receives only a compact overall objective, up to five verified outcomes, and eligible IDs from the local goal catalog. It selects one goal, the fast agent executes it, deterministic live checks verify it, and the director stops. It never sends Minecraft actions or invents executable goal text.

- Fast state: `runtime/llm-agent-state/LlmAgent.json`
- Director state: `runtime/llm-director-state/LlmAgent.json`
- Director history: at most five verified outcomes
- One `director start`: exactly one selection and at most one fast-agent run

Exact Minecraft chat commands, with no `/`, are `director start`, `director status`, `director stop`, and `director reset`. Only `VPNAJ` may issue them.

The current MVP requires trusted live evidence that an oak log was placed above the gold marker. It then selects `collect_oak_log_above_gold_marker`, runs the fast agent, verifies gold below/air above/oak log in inventory, records the paired outcome, and stops.

After independently checking the server world, run the appropriate verifier:

```sh
LLM_DIRECTOR_WORLD_CHECK=preflight-ok node scripts/verify-llm-director-live.mjs --phase preflight
LLM_DIRECTOR_WORLD_CHECK=completed-ok node scripts/verify-llm-director-live.mjs --phase completed
```

The environment flag records the separate server-console check; JSON state cannot supply it. Automated tests alone do not establish live success.

### Verified live director handoff — 2026-08-28

The first user-gated live acceptance run passed at `2026-08-28T21:40:15Z`:

- Authorized Minecraft chat input: `VPNAJ` sent `director start` with no slash at 16:39:50 America/Chicago.
- Server lifecycle messages: `LlmAgent` reported `LLM director started`, then `LLM director succeeded` at 16:40:15 America/Chicago.
- Director run: `eeaaaad0-4cc3-4f55-8400-3a413f363de4`; terminal status `succeeded`; exactly one selection; selected `collect_oak_log_above_gold_marker`.
- Fast-agent run: `2ec016c8-2099-40d9-b9eb-8570a569df35`; terminal status `succeeded`; provider `codex`; evidence source `mineflayer-live`; simulated `false`.
- Independent server-console check at marker `(54, 65, 52)`: `gold_block` remained at the marker, `(54, 66, 52)` was `air`, and `LlmAgent` inventory contained one `minecraft:oak_log`.
- Completed verifier classification: `verified-live-director-handoff`; all six checks passed: director success, exactly one selection, actor success, matching run, live collection proof, and independent server-world verification.
- Full automated regression immediately before live acceptance: 598 tests passed, 0 failed, 0 cancelled, 0 skipped.

This evidence proves one bounded slow-director-to-fast-agent handoff. It does not claim autonomous multi-goal looping, multiple actors, arbitrary generated goals, or director questions.

This guide validates one isolated `LlmAgent` against a local Minecraft server. It does not modify the meadow runtime or use its test area. Unit tests and scripted-provider runs are useful preparation, but they are not real-server evidence.

## Automated preflight

In Terminal, from the repository root:

```sh
npm test
```

Expected output ends with zero failures. A successful test suite does not establish a live run.

## Ordered live validation — follow steps 1 through 8 in order

Do not start the normal Codex host before completing scripted validation. At any time, run only one `LlmAgent` bot: scripted and Codex hosts share its Minecraft username and actor-state path.

## 1. Start the server and prepare the isolated area — no actor host yet

In a dedicated Terminal window, from the repository root:

```sh
npm run server
```

Expected output includes `Done` and the server remains running. Join as `VPNAJ`. In an area not claimed by the meadow scene, place at least one reachable `oak_log` and exactly one reachable `gold_block` marker with clear headroom directly above it. Keep actor and blocks within the 32-block scan radius, and confirm normal walking access. Do not start any `LlmAgent` host in this step.

## 2. Launch the scripted host — still no Codex host

In Terminal, from the repository root, launch one deliberately prepared JSON decision array:

```sh
LLM_AGENT_SCRIPT_PATH=/absolute/path/to/one-action-decisions.json npm run llm-agent
```

Wait for the scripted `LlmAgent` to join. Do not launch `npm run llm-agent` without `LLM_AGENT_SCRIPT_PATH` yet.

## 3. Start scripted validation in Minecraft chat

As `VPNAJ`, use these Minecraft chat commands — no leading `/`:

```text
agent start
```

Expected chat output: `LLM agent started`. Use this status command as useful during scripted validation — no leading `/`:

```text
agent status
```

## 4. Complete deterministic per-action validation, then stop the scripted host

Run and inspect one isolated action at a time: observation, movement, mining, selection, placement, and finish verification. Confirm each actual block/inventory change. A scripted provider proves the deterministic live action path only; it is never autonomous Codex evidence.

When scripted validation is complete, stop the scripted host with Ctrl-C and wait for its disconnect. Do not launch any Codex host before the scripted bot has disconnected.

## 5. Restore the world and reset the actor state with one host only

After the scripted host disconnects, restore the isolated tree and gold-marker area. The Codex autonomous run must not reuse scripted persistent state or scripted world mutations. Confirm no `LlmAgent` is connected, then launch exactly one temporary scripted host with the step-2 command solely to transport the reset command. Once it joins, issue this Minecraft chat command as `VPNAJ` — no leading `/`:

```text
agent reset
```

Wait for the Minecraft chat confirmation `LLM agent reset`. Then stop and fully close that temporary host with Ctrl-C, confirm `LlmAgent` is no longer online in the server player list, and only then continue. Never overlap a reset host with the Codex host.

## 6. Launch the normal Codex host — no script environment

Only after the reset host is fully closed and no `LlmAgent` is online, start the normal host in a clean Terminal environment (no `LLM_AGENT_SCRIPT_PATH`):

```sh
npm run llm-agent
```

Wait for `LlmAgent` to join.

## 7. Start Codex, complete the goal, then request final status

As `VPNAJ`, start the Codex run in Minecraft chat — no leading `/`:

```text
agent start
```

Run the complete goal with a reachable oak and one gold marker. Midway through a run, interrupt the actor process with Ctrl-C, start it again with `npm run llm-agent`, then use this exact Minecraft chat command as `VPNAJ` — no leading `/`:

```text
agent resume
```

The controller takes a fresh observation on resume; do not assume an interrupted action completed. Repeat complete successful runs in a freshly prepared isolated area. At terminal state, immediately issue this Minecraft chat command as `VPNAJ` — no leading `/`:

```text
agent status
```

Expected output begins `LLM agent succeeded` and reports the completed phase, milestones, and last result.

## 8. Run the verifier immediately after final status

In Terminal, from the repository root:

```sh
npm run llm-agent:verify-live -- runtime/llm-agent-state/LlmAgent.json
```

Expected real-run output contains:

```json
{
  "ok": true,
  "classification": "real-server-evidence",
  "checks": {
    "controllerSucceeded": true,
    "minedOakLog": true,
    "oakLogAboveGoldMarker": true,
    "liveObservation": true
  }
}
```

The verifier is read-only: it does not connect to Minecraft or mutate the world. It requires a succeeded controller state, exactly one verified `mined_oak_log` milestone and mining receipt, a verified placement receipt matching the same stable gold-marker world identity, fresh exact-UTC Mineflayer evidence (five minutes or less), and a controller-owned `codex` provider record. Mocked, scripted-only, simulated, stale, malformed, or actor/run-mismatched state is always reported as `not-verified`; the verifier cannot convert it into real-server evidence.

## Recovery

- Provider timeout or provider failure: inspect the terminal error and persisted status. Fix the provider/configuration, restart `npm run llm-agent`, then use Minecraft chat `agent resume` (no leading `/`) only after confirming the actor and test area are still safe.
- Invalid state: do not edit the JSON file. Preserve a copy for diagnosis, then use Minecraft chat `agent reset` (no leading `/`) and start a new run. Reset deliberately erases that actor's persistent state.
- Actor death: make the test area safe, restart the actor if needed, then use Minecraft chat `agent resume` (no leading `/`). The controller will not assume the previous action succeeded.
- Disconnect: restart the Minecraft server and `npm run llm-agent`, confirm `LlmAgent` reconnects, then use Minecraft chat `agent resume` (no leading `/`).
- To abandon history and begin cleanly, use Minecraft chat `agent reset` (no leading `/`), then `agent start` (no leading `/`).
