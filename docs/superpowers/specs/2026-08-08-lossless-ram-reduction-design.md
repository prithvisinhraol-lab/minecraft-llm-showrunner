# Lossless Runtime RAM Reduction Design

Date: 2026-08-08
Status: Approved for implementation planning

## Summary

Reduce the Minecraft project's normal and idle RAM footprint across every supported runtime without deleting or degrading anything. The optimized project must retain the current world data, backups, gameplay settings, bot counts, commands, actor behavior, and emergency capacity. Slightly slower startup and occasional brief additional garbage-collection work are acceptable.

The work covers the vanilla Java server, the normal Mineflayer bot, the showrunner CLI, the two-actor live meadow host, and the ten-bot movie-war modes. It combines adaptive JVM sizing, measured Node.js heap ceilings, and deterministic resource cleanup. Runtime limits remain operator-overridable.

## Current State

- The development Mac has 8 GiB of physical RAM.
- `npm run server` starts Java with `-Xms1G -Xmx2G`.
- The installed OpenJDK 25 runtime uses G1 by default. G1 periodic collection is supported but disabled because its interval is zero.
- Node.js runtime scripts have no explicit old-space limits.
- `movie-war` creates ten Mineflayer clients in one Node.js process.
- The active server configuration is already conservative: view distance 5, simulation distance 4, and passive and hostile spawning disabled.
- The server and bots were not running during the design audit.
- `TRANSFER_TO_NEW_MAC.md` is an unrelated untracked user file and must remain untouched.

## Goals

1. Lower the Java server's committed and resident memory during startup and idle periods.
2. Bound accidental Node.js heap growth separately for each workload.
3. Release bot, pathfinding, interval, timeout, listener, and roster references when their owning runtime ends.
4. Preserve every current runtime mode and its visible behavior.
5. Measure and report actual before-and-after memory rather than treating configured limits as measured savings.
6. Keep limits easy to override for unusually heavy sessions.

## Non-Goals

- Deleting, pruning, compressing, or rewriting worlds, backups, player data, datapacks, recordings, or artifacts.
- Reducing view distance, simulation distance, maximum players, bot counts, world features, entity behavior, or command capabilities.
- Replacing Mineflayer, the Java server, Node.js, or the showrunner architecture.
- Tuning the Minecraft client, macOS, Codex, browsers, or unrelated applications.
- Claiming that a heap ceiling reduces current RSS when it only limits future growth.

## Design

### 1. Adaptive Java Heap

Change the default server launch from a 1 GiB initial heap to a 256 MiB initial heap while retaining the current 2 GiB maximum heap. Keep G1 and enable its supported periodic concurrent collection at a 60-second interval so an idle server can return unused heap to the operating system.

The launch contract will expose dedicated environment overrides for the initial heap, maximum heap, and periodic collection interval. Defaults will be equivalent to:

```text
-Xms256M
-Xmx2G
-XX:+UseG1GC
-XX:G1PeriodicGCInterval=60000
-XX:+G1PeriodicGCInvokesConcurrent
```

The maximum remains 2 GiB, so a busy server retains its existing emergency headroom. No `server.properties` value changes as part of this work.

### 2. Per-Mode Node.js Heap Policies

Pass `--max-old-space-size` directly to each Node.js runtime through a mode-specific environment-controlled value. Direct arguments avoid replacing unrelated `NODE_OPTIONS` and make each workload independently overridable.

Initial validation candidates are:

| Runtime | Initial candidate |
| --- | ---: |
| Normal bot | 384 MiB |
| Showrunner CLI and validation commands | 384 MiB |
| Two-actor `meadow-live` host | 768 MiB |
| Ten-bot `movie-war` and `movie-war-fight` | 1536 MiB |

These are validation candidates, not automatically accepted final limits. Each candidate must survive the matching isolated workload and retain at least 30 percent headroom above observed peak V8 `heapUsed`. If a candidate lacks that headroom, encounters an out-of-memory failure, or causes repeated workload stalls, increase it by 256 MiB and repeat that profile. A final mode limit is the first tested value satisfying all acceptance checks.

Short-lived generation, installation, download, and test scripts are excluded from persistent heap ceilings because they are not long-running project services. The test command remains scoped to `node --test test/*.test.mjs`.

### 3. Lifecycle Resource Cleanup

Every long-running bot process will use an idempotent cleanup path. Cleanup will:

- stop pathfinding and active control states;
- clear owned intervals and outstanding delayed actions;
- remove owned listeners where the process can remain alive after a disconnect;
- remove ended movie-war entries from the roster;
- release references that otherwise keep ended bot objects and their chunk caches reachable; and
- remain safe when called more than once from disconnect, error, signal, or normal shutdown paths.

Cleanup must not run while a bot is healthy or change combat, staging, respawn, dialogue, survival, or command behavior. The showrunner's existing close paths will be reused where they already satisfy the contract; code will change only where measurement or tests identify retained resources.

### 4. Operator Overrides

Each default limit will have a clearly named project-specific environment variable. Invalid Java values may fail at Java startup; invalid Node numeric values must fail before connecting a bot. Overrides must not require editing source or world configuration.

The README will document defaults, the accepted tradeoff, and examples for raising a limit. Lowering limits below the validated defaults is allowed for experimentation but is not part of the verified configuration.

## Measurement Method

All runtime benchmarking will use a temporary copy of the server and world on an alternate port. The production world, logs, session lock, player data, and server properties will not be opened by benchmark processes.

For fair comparison, each baseline and optimized scenario starts from an equivalent fresh temporary copy. Scenarios run sequentially:

1. server only;
2. server plus normal bot;
3. server plus two-actor meadow host while waiting for the operator; and
4. server plus movie-war in hold mode with all ten bots connected.

For each scenario:

1. start the server and wait for its ready marker;
2. start the matching runtime and wait for its expected connection marker;
3. allow a fixed warmup period;
4. sample process-tree RSS and Java committed heap at regular intervals;
5. capture Node `rss`, `heapTotal`, `heapUsed`, `external`, and `arrayBuffers` through benchmark-only telemetry;
6. allow an idle observation period;
7. stop the Node runtime and server gracefully; and
8. verify that all child processes exit.

Repeat a scenario when measurements vary by more than 10 percent or when expected readiness evidence is missing. Compare like-for-like medians and retain the raw measurements in a temporary report; do not commit generated world copies or runtime logs.

## Error Handling and Safety

- Any out-of-memory error, unexpected bot disconnect, missing readiness marker, repeated new stall warning, or forced shutdown rejects that candidate configuration.
- A rejected Node candidate is raised by 256 MiB; features and bot counts are never reduced to make the candidate pass.
- If periodic G1 collection is unsupported by a replacement Java runtime, Java must fail visibly rather than silently starting with unknown flags. The operator can override the interval only after recognizing the compatibility issue.
- Benchmark cleanup first requests graceful shutdown. A forced termination is a failed benchmark and cannot be used as preservation evidence.
- No benchmark uses the active server directory or the normal port.
- No implementation commit may include world data, logs, artifacts, secrets, the untracked transfer note, or unrelated user changes.

## Verification

### Automated tests

- Add focused tests for memory-setting parsing or validation introduced by the implementation.
- Add lifecycle tests proving cleanup is idempotent, intervals stop, and ended movie-war entries become unreachable from the roster.
- Run `node --test test/*.test.mjs` and require zero failures.
- Run `git diff --check` and require no whitespace errors.

### Runtime checks

- Verify the Java process starts with a 256 MiB default initial heap and retains a 2 GiB maximum.
- Verify periodic G1 collection is active with the configured interval.
- Verify each long-running Node mode receives its accepted heap ceiling and honors its override.
- Verify the normal bot connects and retains all chat commands.
- Verify both meadow actors connect and the host waits for `VPNAJ`; the benchmark must not issue `begin`.
- Verify all ten movie-war bots connect in hold mode; the benchmark must not start a fight.
- Verify signals and disconnects invoke cleanup and leave no owned child process running.
- Verify the active world and active `server.properties` remain byte-for-byte unchanged by benchmarking.

## Acceptance Criteria

The implementation is accepted only when all of the following are true:

1. The scoped automated test suite passes in full.
2. Every runtime mode starts and reaches its expected safe state using the optimized defaults.
3. No world, backup, gameplay setting, command, actor count, bot count, or production safety gate changes.
4. Java idle committed heap is lower than the baseline, and total server RSS shows a repeatable reduction under the server-only scenario.
5. Every Node ceiling has at least 30 percent measured `heapUsed` headroom in its matching scenario.
6. No optimized scenario introduces an out-of-memory error, unexpected disconnect, repeated new stall warning, or forced shutdown.
7. Cleanup releases ended bot resources and all benchmark processes terminate gracefully.
8. The final report distinguishes immediate measured savings from maximum-growth safeguards and includes exact before-and-after figures.

## Expected Tradeoff

The server may start slightly more slowly and perform occasional additional concurrent garbage-collection work after becoming idle. Node processes may collect garbage earlier as their heaps approach the tested ceilings. These costs are acceptable only while gameplay behavior and runtime reliability remain unchanged.
