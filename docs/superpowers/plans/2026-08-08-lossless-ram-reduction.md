# Lossless Runtime RAM Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce normal and idle RAM across every long-running Minecraft project runtime while preserving all worlds, settings, bot counts, commands, and gameplay behavior.

**Architecture:** Route long-running commands through one POSIX `exec` launcher that applies adaptive JVM settings and per-mode Node old-space ceilings without leaving a wrapper process resident. Use one testable lifecycle owner for timers and bot teardown, plus benchmark-only telemetry and isolated copied worlds to calibrate and prove the limits.

**Tech Stack:** POSIX shell, Node.js 22 ESM, OpenJDK 25 G1, Mineflayer, `node:test`, macOS `ps`, JDK `jcmd`

## Global Constraints

- Preserve world data, backups, gameplay settings, maximum players, bot counts, commands, actor behavior, production safety gates, and the Java server's existing 2 GiB maximum heap.
- Do not change `server/server.properties`, `server.properties`, any path under `server/world-*`, or the unrelated untracked `TRANSFER_TO_NEW_MAC.md`.
- Keep view distance 5, simulation distance 4, passive spawning disabled, and hostile spawning disabled.
- Default Java settings are `-Xms256M`, `-Xmx2G`, `-XX:+UseG1GC`, `-XX:G1PeriodicGCInterval=60000`, and `-XX:+G1PeriodicGCInvokesConcurrent`.
- Initial Node validation candidates are 384 MiB for the normal bot, 384 MiB for showrunner commands, 768 MiB for `meadow-live`, and 1536 MiB for both movie-war modes.
- Accept a Node ceiling only when it is at least 1.3 times the observed peak V8 `heapUsed` and the matching workload has no OOM, disconnect, repeated new stall warning, or forced shutdown.
- Run automated tests only as `node --test test/*.test.mjs` or a narrower explicit test file.
- Use a fresh temporary server copy and a non-default port for every live benchmark scenario; never start benchmark processes in the active `server` directory.
- Preserve unrelated working-tree changes and stage only files named by the current task.

---

## File Map

- Create `scripts/run-runtime.sh`: validate per-profile environment values and `exec` Java or Node with the selected memory policy.
- Create `test/runtime-memory-launcher.test.mjs`: prove every npm command receives the right defaults, overrides, arguments, and fail-fast validation.
- Modify `package.json`: route only long-running server, bot, meadow, movie-war, and showrunner commands through the launcher.
- Create `src/bot-lifecycle.mjs`: own cancellable intervals/timeouts and perform idempotent bot teardown.
- Create `test/bot-lifecycle.test.mjs`: prove handle cancellation, no post-close callbacks, idempotency, and roster release.
- Modify `src/bot.mjs`: register its intervals and delayed control reset with the lifecycle owner and close on end/signals.
- Modify `src/movie-war.mjs`: give startup and every actor a lifecycle owner, delete ended entries from `roster`, and stop gracefully on both termination signals.
- Create `src/memory-metrics.mjs`: parse RSS/JVM samples, summarize medians and peaks, verify heap headroom, and render a measured report.
- Create `test/memory-metrics.test.mjs`: test parsing, summary math, headroom, and report wording.
- Create `scripts/memory-telemetry-loader.mjs`: emit benchmark-only Node memory samples when loaded with `--import`.
- Create `scripts/measure-memory.mjs`: sample Java/Node RSS plus committed Java heap and combine Node telemetry into one JSON result.
- Create `scripts/render-memory-report.mjs`: render the eight strict JSON results as exact Markdown.
- Create `docs/runtime-memory.md`: record exact measured results and explain immediate savings versus growth safeguards.
- Modify `README.md`: document default limits, override variables, tradeoffs, and safe commands.

---

### Task 1: Central Runtime Memory Launcher

**Files:**
- Create: `scripts/run-runtime.sh`
- Create: `test/runtime-memory-launcher.test.mjs`
- Modify: `package.json:7-20`

**Interfaces:**
- Consumes: existing npm command names and their trailing arguments.
- Produces: launcher profiles `server`, `bot`, `meadow-live`, `movie-war`, `movie-war-fight`, and `showrunner`; environment overrides `MC_SERVER_INITIAL_HEAP`, `MC_SERVER_MAX_HEAP`, `MC_SERVER_PERIODIC_GC_MS`, `MC_BOT_MAX_OLD_SPACE_MB`, `MC_SHOWRUNNER_MAX_OLD_SPACE_MB`, `MC_MEADOW_MAX_OLD_SPACE_MB`, and `MC_MOVIE_WAR_MAX_OLD_SPACE_MB`.

- [ ] **Step 1: Write failing launcher-contract tests**

Create tests that execute `/bin/sh scripts/run-runtime.sh` with each of the six named profiles and `MC_MEMORY_PRINT_ONLY=1`. The print-only contract is one argument per output line, allowing exact assertions without starting a server or bot.

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function printed(profile, overrides = {}, args = []) {
  const result = spawnSync('/bin/sh', ['scripts/run-runtime.sh', profile, ...args], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, MC_MEMORY_PRINT_ONLY: '1', ...overrides }
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n');
}

test('server uses adaptive heap defaults and periodic concurrent G1', () => {
  assert.deepEqual(printed('server').slice(1), [
    '-Xms256M', '-Xmx2G', '-XX:+UseG1GC',
    '-XX:G1PeriodicGCInterval=60000', '-XX:+G1PeriodicGCInvokesConcurrent',
    '-jar', 'server.jar', 'nogui'
  ]);
});

test('long-running Node profiles use independent ceilings', () => {
  assert.match(printed('bot')[1], /^--max-old-space-size=384$/);
  assert.match(printed('showrunner', {}, ['validate', 'episode.yaml'])[1], /^--max-old-space-size=384$/);
  assert.match(printed('meadow-live')[1], /^--max-old-space-size=768$/);
  assert.match(printed('movie-war')[1], /^--max-old-space-size=1536$/);
  assert.match(printed('movie-war-fight')[1], /^--max-old-space-size=1536$/);
});

test('invalid Node ceilings fail before a runtime starts', () => {
  const result = spawnSync('/bin/sh', ['scripts/run-runtime.sh', 'bot'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, MC_BOT_MAX_OLD_SPACE_MB: 'many' }
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /MC_BOT_MAX_OLD_SPACE_MB must be a positive integer/);
});

test('package scripts route all persistent runtimes through the launcher', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  for (const name of ['server', 'bot', 'meadow-live', 'movie-war', 'movie-war-fight', 'showrunner', 'showrunner:rehearse', 'showrunner:security-check']) {
    assert.match(scripts[name], /^sh scripts\/run-runtime\.sh /);
  }
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `node --test test/runtime-memory-launcher.test.mjs`

Expected: FAIL because `scripts/run-runtime.sh` does not exist and package scripts still contain direct Java/Node commands.

- [ ] **Step 3: Implement the POSIX launcher**

Create `scripts/run-runtime.sh` with `set -eu`, a `positive_integer` validator, and an `execute` function that either prints arguments or replaces the shell with the target process.

```sh
#!/bin/sh
set -eu

profile=${1:-}
if [ "$#" -gt 0 ]; then shift; fi

positive_integer() {
  name=$1
  value=$2
  case "$value" in
    ''|*[!0-9]*) printf '%s must be a positive integer\n' "$name" >&2; exit 64 ;;
  esac
  if [ "$value" -lt 1 ]; then printf '%s must be a positive integer\n' "$name" >&2; exit 64; fi
}

execute() {
  if [ "${MC_MEMORY_PRINT_ONLY:-0}" = "1" ]; then
    printf '%s\n' "$@"
    exit 0
  fi
  exec "$@"
}
```

Use `${JAVA_BIN:-/opt/homebrew/opt/openjdk/bin/java}` for the server, `${MC_NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}` for bot/meadow/movie profiles, and `${MC_SHOWRUNNER_NODE_BIN:-node}` for showrunner. Before calling `execute`, export the existing default `MC_VERSION=1.21.4`; set `MOVIE_WAR_MODE=fight` only in the fight profile. Preserve all trailing `"$@"` arguments for showrunner commands. Unknown profiles exit 64 and print `unknown runtime profile:` followed by the supplied value.

Implement profile routing with this exact case structure:

```sh
case "$profile" in
  server)
    initial_heap=${MC_SERVER_INITIAL_HEAP:-256M}
    maximum_heap=${MC_SERVER_MAX_HEAP:-2G}
    periodic_gc_ms=${MC_SERVER_PERIODIC_GC_MS:-60000}
    positive_integer MC_SERVER_PERIODIC_GC_MS "$periodic_gc_ms"
    cd server
    execute "${JAVA_BIN:-/opt/homebrew/opt/openjdk/bin/java}" \
      "-Xms$initial_heap" "-Xmx$maximum_heap" -XX:+UseG1GC \
      "-XX:G1PeriodicGCInterval=$periodic_gc_ms" -XX:+G1PeriodicGCInvokesConcurrent \
      -jar server.jar nogui
    ;;
  bot)
    limit=${MC_BOT_MAX_OLD_SPACE_MB:-384}
    positive_integer MC_BOT_MAX_OLD_SPACE_MB "$limit"
    export MC_VERSION=${MC_VERSION:-1.21.4}
    execute "${MC_NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}" "--max-old-space-size=$limit" src/bot.mjs "$@"
    ;;
  meadow-live)
    limit=${MC_MEADOW_MAX_OLD_SPACE_MB:-768}
    positive_integer MC_MEADOW_MAX_OLD_SPACE_MB "$limit"
    export MC_VERSION=${MC_VERSION:-1.21.4}
    execute "${MC_NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}" "--max-old-space-size=$limit" src/showrunner/live-meadow-cli.mjs "$@"
    ;;
  movie-war|movie-war-fight)
    limit=${MC_MOVIE_WAR_MAX_OLD_SPACE_MB:-1536}
    positive_integer MC_MOVIE_WAR_MAX_OLD_SPACE_MB "$limit"
    export MC_VERSION=${MC_VERSION:-1.21.4}
    if [ "$profile" = movie-war-fight ]; then export MOVIE_WAR_MODE=fight; fi
    execute "${MC_NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}" "--max-old-space-size=$limit" src/movie-war.mjs "$@"
    ;;
  showrunner)
    limit=${MC_SHOWRUNNER_MAX_OLD_SPACE_MB:-384}
    positive_integer MC_SHOWRUNNER_MAX_OLD_SPACE_MB "$limit"
    execute "${MC_SHOWRUNNER_NODE_BIN:-node}" "--max-old-space-size=$limit" src/showrunner/cli.mjs "$@"
    ;;
  *) printf 'unknown runtime profile: %s\n' "$profile" >&2; exit 64 ;;
esac
```

- [ ] **Step 4: Route package scripts through the launcher**

Use these exact command shapes:

```json
"bot": "sh scripts/run-runtime.sh bot",
"meadow-live": "sh scripts/run-runtime.sh meadow-live",
"server": "sh scripts/run-runtime.sh server",
"movie-war": "sh scripts/run-runtime.sh movie-war",
"movie-war-fight": "sh scripts/run-runtime.sh movie-war-fight",
"showrunner": "sh scripts/run-runtime.sh showrunner",
"showrunner:rehearse": "sh scripts/run-runtime.sh showrunner rehearse",
"showrunner:security-check": "sh scripts/run-runtime.sh showrunner security-check"
```

Leave `test`, generators, installer, and downloader unchanged.

- [ ] **Step 5: Verify defaults, overrides, and Java flag compatibility**

Run: `node --test test/runtime-memory-launcher.test.mjs`

Expected: all launcher tests PASS.

Run: `MC_MEMORY_PRINT_ONLY=1 MC_SERVER_INITIAL_HEAP=512M MC_SERVER_MAX_HEAP=3G MC_SERVER_PERIODIC_GC_MS=90000 npm run server`

Expected: output contains `-Xms512M`, `-Xmx3G`, and `-XX:G1PeriodicGCInterval=90000`.

Run: `/opt/homebrew/opt/openjdk/bin/java -Xms256M -Xmx2G -XX:+UseG1GC -XX:G1PeriodicGCInterval=60000 -XX:+G1PeriodicGCInvokesConcurrent -version`

Expected: exit 0 and OpenJDK version output.

- [ ] **Step 6: Commit the launcher**

```bash
git add scripts/run-runtime.sh test/runtime-memory-launcher.test.mjs package.json
git commit -m "perf: add bounded runtime launch profiles"
```

---

### Task 2: Idempotent Bot Lifecycle and Normal Bot Cleanup

**Files:**
- Create: `src/bot-lifecycle.mjs`
- Create: `test/bot-lifecycle.test.mjs`
- Modify: `src/bot.mjs:35-53,169-220,430-448,520-559,782-820`

**Interfaces:**
- Produces: `createBotLifecycle({ bot?, onRelease?, timers? })` returning `setInterval`, `clearInterval`, `setTimeout`, `clearTimeout`, `snapshot`, and `close`.
- `close()` returns `{ closedNow: boolean, errors: Error[] }`; repeated calls return `closedNow: false` and perform no repeated bot or release action.

- [ ] **Step 1: Write failing lifecycle tests with fake timers and a fake bot**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotLifecycle } from '../src/bot-lifecycle.mjs';

function fakeTimers() {
  let next = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    intervals, timeouts,
    setInterval(fn) { const id = next++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn) { const id = next++; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    fireTimeout(id) { const fn = timeouts.get(id); timeouts.delete(id); fn?.(); }
  };
}

test('close cancels owned work and releases a bot exactly once', () => {
  const timers = fakeTimers();
  const calls = [];
  const roster = new Map([['KingSteel', {}]]);
  const bot = {
    pathfinder: { stop() { calls.push('stop'); } },
    clearControlStates() { calls.push('controls'); },
    deactivateItem() { calls.push('item'); }
  };
  const lifecycle = createBotLifecycle({ bot, timers, onRelease() { roster.delete('KingSteel'); calls.push('release'); } });
  lifecycle.setInterval(() => calls.push('interval'), 10);
  lifecycle.setTimeout(() => calls.push('timeout'), 10);
  assert.deepEqual(lifecycle.snapshot(), { closed: false, intervals: 1, timeouts: 1 });
  assert.equal(lifecycle.close().closedNow, true);
  assert.equal(lifecycle.close().closedNow, false);
  assert.deepEqual(lifecycle.snapshot(), { closed: true, intervals: 0, timeouts: 0 });
  assert.equal(roster.size, 0);
  assert.deepEqual(calls, ['stop', 'controls', 'item', 'release']);
});
```

Add these focused cases for timeout removal, explicit cancellation, post-close suppression, and cleanup-error isolation:

```js
test('fired and cancelled handles leave no owned work', () => {
  const timers = fakeTimers();
  const calls = [];
  const lifecycle = createBotLifecycle({ timers });
  const interval = lifecycle.setInterval(() => calls.push('interval'), 10);
  const timeout = lifecycle.setTimeout(() => calls.push('timeout'), 10);
  lifecycle.clearInterval(interval);
  timers.fireTimeout(timeout);
  assert.deepEqual(calls, ['timeout']);
  assert.deepEqual(lifecycle.snapshot(), { closed: false, intervals: 0, timeouts: 0 });
});

test('close suppresses callbacks and continues after a cleanup error', () => {
  const timers = fakeTimers();
  const calls = [];
  const lifecycle = createBotLifecycle({
    timers,
    bot: { pathfinder: { stop() { throw new Error('stop failed'); } }, clearControlStates() { calls.push('controls'); } },
    onRelease() { calls.push('release'); }
  });
  const timeout = lifecycle.setTimeout(() => calls.push('timeout'), 10);
  const result = lifecycle.close();
  timers.fireTimeout(timeout);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(calls, ['controls', 'release']);
});
```

- [ ] **Step 2: Run the lifecycle test and verify the red state**

Run: `node --test test/bot-lifecycle.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/bot-lifecycle.mjs`.

- [ ] **Step 3: Implement the lifecycle owner**

Use `Set` collections for handles. Wrapped timeouts delete their handle before invoking the callback and skip callbacks after closure. `close()` marks closed first, clears all handles, then attempts `pathfinder.stop`, `clearControlStates`, `deactivateItem`, and `onRelease` independently while collecting thrown errors.

```js
export function createBotLifecycle({ bot, onRelease = () => {}, timers = globalThis } = {}) {
  const intervals = new Set();
  const timeouts = new Set();
  let closed = false;

  function setOwnedTimeout(callback, delay) {
    if (closed) return null;
    let handle;
    handle = timers.setTimeout(() => {
      timeouts.delete(handle);
      if (!closed) callback();
    }, delay);
    timeouts.add(handle);
    return handle;
  }

  return Object.freeze({
    setInterval(callback, delay) { if (closed) return null; const handle = timers.setInterval(callback, delay); intervals.add(handle); return handle; },
    clearInterval(handle) { if (handle !== null) timers.clearInterval(handle); intervals.delete(handle); },
    setTimeout: setOwnedTimeout,
    clearTimeout(handle) { if (handle !== null) timers.clearTimeout(handle); timeouts.delete(handle); },
    snapshot() { return { closed, intervals: intervals.size, timeouts: timeouts.size }; },
    close() {
      if (closed) return { closedNow: false, errors: [] };
      closed = true;
      for (const handle of intervals) timers.clearInterval(handle);
      for (const handle of timeouts) timers.clearTimeout(handle);
      intervals.clear();
      timeouts.clear();
      const errors = [];
      for (const action of [() => bot?.pathfinder?.stop(), () => bot?.clearControlStates?.(), () => bot?.deactivateItem?.(), onRelease]) {
        try { action(); } catch (error) { errors.push(error); }
      }
      return { closedNow: true, errors };
    }
  });
}
```

- [ ] **Step 4: Integrate the lifecycle into the normal bot**

Import `createBotLifecycle`, construct it immediately after `bot.loadPlugin(pathfinder)`, and replace the four persistent interval creations/clears plus the fire-and-forget jump timeout with lifecycle methods. Keep short awaited `sleep()` delays unchanged because they cannot retain the process beyond 1.4 seconds and changing their resolution semantics would alter commands.

Add one idempotent shutdown function:

```js
const lifecycle = createBotLifecycle({ bot });

function closeBot(reason) {
  const result = lifecycle.close();
  for (const error of result.errors) console.error(`Bot cleanup failed (${reason}):`, error);
  return result.closedNow;
}

function shutdown(signal) {
  closeBot(signal);
  bot.end(signal);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
```

Call `closeBot('end')` in the existing `end` listener before logging. Do not change chat command dispatch, combat timing, or error/kick policy.

- [ ] **Step 5: Verify lifecycle and existing bot behavior tests**

Run: `node --test test/bot-lifecycle.test.mjs test/command-parser.test.mjs test/mace-combat.test.mjs test/rod-strike.test.mjs test/tnt-minecart-combat.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit normal-bot cleanup**

```bash
git add src/bot-lifecycle.mjs src/bot.mjs test/bot-lifecycle.test.mjs
git commit -m "fix: release normal bot runtime resources"
```

---

### Task 3: Movie-War Roster and Timer Cleanup

**Files:**
- Modify: `src/movie-war.mjs:34,224-321`
- Modify: `test/bot-lifecycle.test.mjs`

**Interfaces:**
- Consumes: `createBotLifecycle` from Task 2.
- Produces: one root lifecycle for staggered actor creation and one lifecycle per roster entry with `onRelease: () => roster.delete(config.username)`.

- [ ] **Step 1: Extend the test for movie-war release semantics**

Use this exact test with ten fake roster keys and ten lifecycle owners. It closes three actors, asserts exactly those keys disappear, then closes every lifecycle twice and asserts the roster is empty.

```js
test('movie-war style release removes only ended actors and remains idempotent', () => {
  const roster = new Map();
  const lifecycles = [];
  for (let index = 0; index < 10; index += 1) {
    const username = `Actor${index}`;
    roster.set(username, {});
    lifecycles.push(createBotLifecycle({ onRelease: () => roster.delete(username), timers: fakeTimers() }));
  }
  lifecycles[1].close();
  lifecycles[4].close();
  lifecycles[8].close();
  assert.deepEqual([...roster.keys()], ['Actor0', 'Actor2', 'Actor3', 'Actor5', 'Actor6', 'Actor7', 'Actor9']);
  for (const lifecycle of lifecycles) { lifecycle.close(); lifecycle.close(); }
  assert.equal(roster.size, 0);
});
```

- [ ] **Step 2: Run the focused lifecycle test**

Run: `node --test test/bot-lifecycle.test.mjs`

Expected: PASS for the generic lifecycle contract; movie-war integration is not present yet.

- [ ] **Step 3: Give movie-war startup and entries lifecycle ownership**

Import `createBotLifecycle`. Create `const startupLifecycle = createBotLifecycle()` beside `roster`. Replace staggered bot-creation `setTimeout` calls with `startupLifecycle.setTimeout`.

After creating each `entry`, attach:

```js
entry.lifecycle = createBotLifecycle({
  bot,
  onRelease: () => roster.delete(config.username)
});
```

Replace fight-start, shield-raise, respawn, and fight-loop timers with `entry.lifecycle` methods. When clearing `entry.interval`, use `entry.lifecycle.clearInterval(entry.interval)` and set `entry.interval = null`.

- [ ] **Step 4: Make disconnect and signal shutdown graceful**

In the `end` handler call `entry.lifecycle.close()` before logging. Replace the SIGINT-only immediate exit with this shared function and register it once for both signals:

```js
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  startupLifecycle.close();
  for (const entry of [...roster.values()]) {
    entry.lifecycle.close();
    entry.bot.end(signal);
  }
  process.exitCode = 0;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
```

Do not call `process.exit()`. Do not alter the ten configurations, combat cadence, three-death rule, staging commands, or target selection.

- [ ] **Step 5: Verify lifecycle and movie-war behavior helpers**

Run: `node --test test/bot-lifecycle.test.mjs test/mace-combat.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit movie-war cleanup**

```bash
git add src/movie-war.mjs test/bot-lifecycle.test.mjs
git commit -m "fix: release ended movie war actors"
```

---

### Task 4: Benchmark-Only Memory Telemetry and Metrics

**Files:**
- Create: `src/memory-metrics.mjs`
- Create: `test/memory-metrics.test.mjs`
- Create: `scripts/memory-telemetry-loader.mjs`
- Create: `scripts/measure-memory.mjs`
- Create: `scripts/render-memory-report.mjs`

**Interfaces:**
- Produces: `parseRssKib(text)`, `parseG1HeapInfo(text)`, `summarizeSamples(samples)`, `hasRequiredHeadroom(limitMib, peakHeapUsedBytes)`, and `renderMemoryReport(results)`.
- `scripts/memory-telemetry-loader.mjs` consumes `MC_MEMORY_TELEMETRY_FILE` and optional `MC_MEMORY_SAMPLE_MS`.
- `scripts/measure-memory.mjs` consumes `--label`, `--java-pid`, optional `--node-pid`, optional `--node-telemetry`, optional `--node-limit-mib`, `--samples`, `--interval-ms`, and `--output`.
- `scripts/render-memory-report.mjs` consumes exactly eight result JSON paths and prints Markdown to stdout.

- [ ] **Step 1: Write failing parser, headroom, and report tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRequiredHeadroom, parseG1HeapInfo, parseRssKib, renderMemoryReport, summarizeSamples } from '../src/memory-metrics.mjs';

test('parses macOS RSS and G1 committed heap', () => {
  assert.equal(parseRssKib(' 412672\n'), 412672);
  assert.deepEqual(parseG1HeapInfo('garbage-first heap   total 1048576K, used 312442K'), {
    committedKib: 1048576, usedKib: 312442
  });
});

test('summaries use median RSS and peak heap usage', () => {
  assert.deepEqual(summarizeSamples([
    { rssKib: 300, heapUsedBytes: 20 },
    { rssKib: 100, heapUsedBytes: 40 },
    { rssKib: 200, heapUsedBytes: 30 }
  ]), { medianRssKib: 200, peakRssKib: 300, peakHeapUsedBytes: 40 });
});

test('requires a full thirty percent of Node heap headroom', () => {
  assert.equal(hasRequiredHeadroom(130, 100 * 1024 * 1024), true);
  assert.equal(hasRequiredHeadroom(129, 100 * 1024 * 1024), false);
});

test('report distinguishes measured RSS savings from heap growth safeguards', () => {
  const report = renderMemoryReport([
    { label: 'baseline-bot', medianTotalRssKib: 900 * 1024, peakHeapUsedBytes: 80 * 1024 * 1024 },
    { label: 'optimized-bot', medianTotalRssKib: 700 * 1024, peakHeapUsedBytes: 90 * 1024 * 1024, nodeLimitMib: 384 }
  ]);
  assert.match(report, /Measured RSS reduction/);
  assert.match(report, /900\.0 MiB/);
  assert.match(report, /700\.0 MiB/);
  assert.match(report, /Growth safeguard/);
});
```

- [ ] **Step 2: Run the metrics test and verify the red state**

Run: `node --test test/memory-metrics.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement pure metrics and report rendering**

Reject blank/non-numeric RSS, reject non-G1 heap text, calculate medians from sorted values, and implement headroom as `limitMib * 1024 * 1024 >= peakHeapUsedBytes * 1.3`.

```js
export function parseRssKib(text) {
  const value = Number(String(text).trim());
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('RSS_SAMPLE_INVALID');
  return value;
}

export function parseG1HeapInfo(text) {
  const match = String(text).match(/garbage-first heap\s+total\s+(\d+)K,\s+used\s+(\d+)K/);
  if (!match) throw new Error('G1_HEAP_SAMPLE_INVALID');
  return { committedKib: Number(match[1]), usedKib: Number(match[2]) };
}

export function hasRequiredHeadroom(limitMib, peakHeapUsedBytes) {
  return limitMib * 1024 * 1024 >= peakHeapUsedBytes * 1.3;
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('MEMORY_SAMPLES_REQUIRED');
  const rssValues = samples.map(({ rssKib }) => rssKib).sort((left, right) => left - right);
  const middle = Math.floor(rssValues.length / 2);
  const medianRssKib = rssValues.length % 2 ? rssValues[middle] : (rssValues[middle - 1] + rssValues[middle]) / 2;
  return {
    medianRssKib,
    peakRssKib: Math.max(...rssValues),
    peakHeapUsedBytes: Math.max(...samples.map(({ heapUsedBytes = 0 }) => heapUsedBytes))
  };
}
```

`renderMemoryReport` must pair labels by their `baseline-`/`optimized-` prefix, show exact MiB rounded to one decimal, Java committed-heap change, Node peak `heapUsed`, accepted ceiling, and whether the ceiling is immediate savings or only a growth safeguard.

```js
function mib(kib) { return `${(kib / 1024).toFixed(1)} MiB`; }

export function renderMemoryReport(results) {
  const byLabel = new Map(results.map((result) => [result.label, result]));
  const lines = [
    '# Runtime Memory Results', '',
    '| Scenario | Baseline RSS | Optimized RSS | Measured RSS reduction | Java committed change | Node peak heapUsed | Accepted ceiling | Classification |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const scenario of ['server', 'bot', 'meadow', 'movie']) {
    const baseline = byLabel.get(`baseline-${scenario}`);
    const optimized = byLabel.get(`optimized-${scenario}`);
    if (!baseline || !optimized) continue;
    const rssReduction = baseline.medianTotalRssKib - optimized.medianTotalRssKib;
    const javaChange = (baseline.medianJavaCommittedKib ?? 0) - (optimized.medianJavaCommittedKib ?? 0);
    const nodePeak = optimized.peakHeapUsedBytes === undefined ? 'n/a' : `${(optimized.peakHeapUsedBytes / 1024 / 1024).toFixed(1)} MiB`;
    const ceiling = optimized.nodeLimitMib === undefined ? 'n/a' : `${optimized.nodeLimitMib} MiB`;
    const classification = rssReduction > 0 ? 'Measured RSS reduction' : 'Growth safeguard';
    lines.push(`| ${scenario} | ${mib(baseline.medianTotalRssKib)} | ${mib(optimized.medianTotalRssKib)} | ${mib(rssReduction)} | ${mib(javaChange)} | ${nodePeak} | ${ceiling} | ${classification} |`);
  }
  lines.push('', 'Node ceilings are reported as a Growth safeguard unless the paired RSS measurement also decreases.', '');
  return lines.join('\n');
}
```

- [ ] **Step 4: Implement benchmark-only Node telemetry**

The loader must refuse to run without `MC_MEMORY_TELEMETRY_FILE`, validate a positive sample interval, write an initial NDJSON sample, use an unref'ed interval, and append a final synchronous sample on exit.

```js
import { appendFileSync } from 'node:fs';

const output = process.env.MC_MEMORY_TELEMETRY_FILE;
const intervalMs = Number(process.env.MC_MEMORY_SAMPLE_MS ?? 1000);
if (!output) throw new Error('MC_MEMORY_TELEMETRY_FILE_REQUIRED');
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('MC_MEMORY_SAMPLE_MS_INVALID');

function writeSample() {
  appendFileSync(output, `${JSON.stringify({ timestampMs: Date.now(), pid: process.pid, ...process.memoryUsage() })}\n`);
}

writeSample();
const interval = setInterval(writeSample, intervalMs);
interval.unref();
process.once('exit', () => { clearInterval(interval); writeSample(); });
```

The loader is used only through `NODE_OPTIONS="--import=$(pwd)/scripts/memory-telemetry-loader.mjs"` during benchmarks; normal npm runs do not load it.

Extend the test imports with `mkdtempSync`, `readFileSync`, and `rmSync` from `node:fs`, `tmpdir` from `node:os`, `join` and `resolve` from `node:path`, and `spawnSync` from `node:child_process`. Add this child-process test:

```js
test('benchmark loader emits complete Node memory samples', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'minecraft-memory-telemetry-'));
  const output = join(directory, 'samples.ndjson');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    '--import', resolve('scripts/memory-telemetry-loader.mjs'),
    '-e', 'setTimeout(() => {}, 25)'
  ], {
    encoding: 'utf8',
    env: { ...process.env, MC_MEMORY_TELEMETRY_FILE: output, MC_MEMORY_SAMPLE_MS: '5' }
  });
  assert.equal(result.status, 0, result.stderr);
  const samples = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(samples.length >= 2);
  for (const sample of samples) {
    for (const key of ['pid', 'rss', 'heapTotal', 'heapUsed', 'external']) assert.ok(sample[key] > 0, key);
    assert.ok(sample.arrayBuffers >= 0, 'arrayBuffers');
  }
});
```

- [ ] **Step 5: Implement the sampler CLI**

Use `execFile` rather than a shell. For each sample, execute `ps -o rss= -p "$MC_NODE_PID"` and `ps -o rss= -p "$MC_JAVA_PID"` for the supplied process IDs, plus `${JCMD_BIN:-/opt/homebrew/opt/openjdk/bin/jcmd} "$MC_JAVA_PID" GC.heap_info` for Java.

```js
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCallback);

async function rssKib(pid) {
  const { stdout } = await execFile('ps', ['-o', 'rss=', '-p', String(pid)]);
  return parseRssKib(stdout);
}

async function javaHeap(pid) {
  const jcmd = process.env.JCMD_BIN || '/opt/homebrew/opt/openjdk/bin/jcmd';
  const { stdout } = await execFile(jcmd, [String(pid), 'GC.heap_info']);
  return parseG1HeapInfo(stdout);
}
```

After the final interval, read telemetry NDJSON, summarize all series with the pure functions, and write one strict JSON object to `--output` with this shape:

```js
{
  label,
  sampleCount,
  medianJavaRssKib,
  medianNodeRssKib,
  medianTotalRssKib,
  medianJavaCommittedKib,
  peakJavaUsedKib,
  peakHeapUsedBytes,
  nodeLimitMib,
  headroomAccepted
}
```

Server-only results omit Node-only fields. When `--node-limit-mib` is present, calculate `headroomAccepted` with `hasRequiredHeadroom`. Exit nonzero for a missing process, malformed sample, empty telemetry file, or missing output path.

Implement `scripts/render-memory-report.mjs` as a thin CLI:

```js
import { readFileSync } from 'node:fs';
import { renderMemoryReport } from '../src/memory-metrics.mjs';

const paths = process.argv.slice(2);
if (paths.length !== 8) throw new Error('EIGHT_MEMORY_RESULTS_REQUIRED');
const results = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
process.stdout.write(renderMemoryReport(results));
```

- [ ] **Step 6: Run focused and full non-live verification**

Run: `node --test test/memory-metrics.test.mjs test/runtime-memory-launcher.test.mjs test/bot-lifecycle.test.mjs`

Expected: all tests PASS.

Run: `node --check scripts/measure-memory.mjs`

Expected: exit 0.

- [ ] **Step 7: Commit telemetry and metrics**

```bash
git add src/memory-metrics.mjs scripts/memory-telemetry-loader.mjs scripts/measure-memory.mjs scripts/render-memory-report.mjs test/memory-metrics.test.mjs
git commit -m "test: add isolated runtime memory measurement"
```

---

### Task 5: Isolated Calibration Across All Runtime Modes

**Files:**
- Modify if calibration requires a higher accepted ceiling: `scripts/run-runtime.sh`
- Modify if a default changes: `test/runtime-memory-launcher.test.mjs`
- Create: `docs/runtime-memory.md`

**Interfaces:**
- Consumes: launcher, telemetry loader, sampler CLI, and report renderer from Tasks 1-4.
- Produces: eight JSON results under one temporary benchmark directory and the exact summarized `docs/runtime-memory.md` report.

- [ ] **Step 1: Record production-state hashes and confirm no live project process**

Run these read-only checks before creating temporary copies:

```bash
shasum -a 256 server/server.properties > /tmp/minecraft-server-properties-before.sha256
find server/world-1.21.4 -type f -exec shasum -a 256 {} + | sort > /tmp/minecraft-world-before.sha256
ps -axo pid,command | rg 'server\.jar|src/(bot|movie-war)|live-meadow-cli'
```

Expected: the process search shows only the search command. If a real project process exists, stop and resolve it safely before benchmarking.

- [ ] **Step 2: Create eight fresh temporary server copies on ports 25665-25672**

Run: `mktemp -d /private/tmp/minecraft-ram-bench.XXXXXX`

Save the printed absolute path as `MC_BENCH_ROOT`. For each label `baseline-server`, `optimized-server`, `baseline-bot`, `optimized-bot`, `baseline-meadow`, `optimized-meadow`, `baseline-movie`, and `optimized-movie`, copy `server` to `$MC_BENCH_ROOT/$MC_BENCH_LABEL` and mechanically replace `server-port=25565` and `query.port=25565` only inside that copy with its assigned port. Confirm every copy contains `server.jar`, `eula.txt`, and `world-1.21.4` before starting it.

Use this exact copy loop after exporting `MC_BENCH_ROOT` to the absolute path returned by `mktemp`:

```bash
while IFS=: read -r MC_BENCH_LABEL MC_BENCH_PORT; do
  cp -R server "$MC_BENCH_ROOT/$MC_BENCH_LABEL"
  perl -0pi -e "s/^server-port=25565$/server-port=$MC_BENCH_PORT/m; s/^query\.port=25565$/query.port=$MC_BENCH_PORT/m" "$MC_BENCH_ROOT/$MC_BENCH_LABEL/server.properties"
  test -f "$MC_BENCH_ROOT/$MC_BENCH_LABEL/server.jar"
  test -f "$MC_BENCH_ROOT/$MC_BENCH_LABEL/eula.txt"
  test -d "$MC_BENCH_ROOT/$MC_BENCH_LABEL/world-1.21.4"
done <<'BENCHMARKS'
baseline-server:25665
optimized-server:25666
baseline-bot:25667
optimized-bot:25668
baseline-meadow:25669
optimized-meadow:25670
baseline-movie:25671
optimized-movie:25672
BENCHMARKS
```

Do not remove the benchmark root during this task; keep it for evidence and let normal temporary-directory cleanup handle it later.

- [ ] **Step 3: Measure baseline and optimized server-only scenarios**

Start the baseline copy with the original Java policy:

```bash
/opt/homebrew/opt/openjdk/bin/java -Xms1G -Xmx2G -jar server.jar nogui
```

Start the optimized copy with the five approved Java flags. For each, wait for `Done`, then run six samples at ten-second intervals:

```bash
node scripts/measure-memory.mjs --label baseline-server --java-pid "$MC_JAVA_PID" --samples 6 --interval-ms 10000 --output "$MC_BENCH_ROOT/baseline-server.json"
```

Use the matching optimized label/output for the second run. Send `stop` through Java stdin, require `All dimensions are saved`, and require process exit 0.

- [ ] **Step 4: Measure normal bot, meadow, and ten-bot movie-war pairs**

For each remaining copied server, start the matching baseline or optimized Java policy and wait for `Done`. Start baseline Node directly with no `--max-old-space-size`; start optimized Node through the explicitly listed `bot`, `meadow-live`, or `movie-war` launcher command below so both sides have one direct Node process and npm-wrapper RSS cannot bias the comparison. In both cases set the copied server port and benchmark telemetry:

```bash
MC_PORT=25667 MC_VERSION=1.21.4 MC_MEMORY_TELEMETRY_FILE="$MC_BENCH_ROOT/baseline-bot.ndjson" NODE_OPTIONS="--import=$(pwd)/scripts/memory-telemetry-loader.mjs" /opt/homebrew/opt/node@22/bin/node src/bot.mjs
MC_PORT=25668 MC_MEMORY_TELEMETRY_FILE="$MC_BENCH_ROOT/optimized-bot.ndjson" NODE_OPTIONS="--import=$(pwd)/scripts/memory-telemetry-loader.mjs" /bin/sh scripts/run-runtime.sh bot
MC_PORT=25669 MC_VERSION=1.21.4 MC_MEMORY_TELEMETRY_FILE="$MC_BENCH_ROOT/baseline-meadow.ndjson" NODE_OPTIONS="--import=$(pwd)/scripts/memory-telemetry-loader.mjs" /opt/homebrew/opt/node@22/bin/node src/showrunner/live-meadow-cli.mjs
MC_PORT=25670 MC_MEMORY_TELEMETRY_FILE="$MC_BENCH_ROOT/optimized-meadow.ndjson" NODE_OPTIONS="--import=$(pwd)/scripts/memory-telemetry-loader.mjs" /bin/sh scripts/run-runtime.sh meadow-live
MC_PORT=25671 MC_VERSION=1.21.4 MOVIE_WAR_MODE=hold MC_MEMORY_TELEMETRY_FILE="$MC_BENCH_ROOT/baseline-movie.ndjson" NODE_OPTIONS="--import=$(pwd)/scripts/memory-telemetry-loader.mjs" /opt/homebrew/opt/node@22/bin/node src/movie-war.mjs
MC_PORT=25672 MOVIE_WAR_MODE=hold MC_MEMORY_TELEMETRY_FILE="$MC_BENCH_ROOT/optimized-movie.ndjson" NODE_OPTIONS="--import=$(pwd)/scripts/memory-telemetry-loader.mjs" /bin/sh scripts/run-runtime.sh movie-war
```

Readiness requirements are:

- normal bot: `CodexBot connected`;
- meadow: both actors connected and `[meadow-live] WAITING`, with no `begin` command;
- movie-war: all ten distinct `joined team` messages in hold mode, with no fight mode.

After readiness, collect six ten-second samples with both `--java-pid`, `--node-pid`, and `--node-telemetry`. Stop Node with SIGTERM, require graceful exit for optimized runs, send `stop` to Java stdin, and require the saved-dimensions marker. Any forced termination rejects the optimized candidate.

Use this optimized bot measurement shape; substitute the matching label, process IDs, telemetry filename, output filename, and accepted candidate `768` or `1536` for meadow and movie-war:

```bash
node scripts/measure-memory.mjs --label optimized-bot --java-pid "$MC_JAVA_PID" --node-pid "$MC_NODE_PID" --node-telemetry "$MC_BENCH_ROOT/optimized-bot.ndjson" --node-limit-mib 384 --samples 6 --interval-ms 10000 --output "$MC_BENCH_ROOT/optimized-bot.json"
```

- [ ] **Step 5: Evaluate candidate ceilings and repeat only rejected optimized profiles**

For each optimized Node JSON, require `headroomAccepted` to be exactly `true`. Also search both server and Node logs for `OutOfMemoryError`, `JavaScript heap out of memory`, unexpected disconnects, and new repeated `Can't keep up` warnings.

If a profile fails, raise only that profile's default by exactly 256 MiB in `scripts/run-runtime.sh`, update its exact launcher test, rerun that test, and repeat the matching optimized benchmark on a fresh copied server. Never lower view distance, simulation distance, player count, actor count, or bot count.

- [ ] **Step 6: Generate and review the exact report**

Render the final eight JSON objects in a fixed order:

```bash
node scripts/render-memory-report.mjs \
  "$MC_BENCH_ROOT/baseline-server.json" "$MC_BENCH_ROOT/optimized-server.json" \
  "$MC_BENCH_ROOT/baseline-bot.json" "$MC_BENCH_ROOT/optimized-bot.json" \
  "$MC_BENCH_ROOT/baseline-meadow.json" "$MC_BENCH_ROOT/optimized-meadow.json" \
  "$MC_BENCH_ROOT/baseline-movie.json" "$MC_BENCH_ROOT/optimized-movie.json" \
  > "$MC_BENCH_ROOT/runtime-memory.md"
```

Review the generated Markdown, then use `apply_patch` to add its exact content as `docs/runtime-memory.md` and append these operator facts:

- benchmark date and OpenJDK/Node versions;
- temporary ports and the fact that copied worlds were used;
- exact accepted default and override variable for each runtime;
- whether each difference is measured RSS savings or only a maximum-growth safeguard;
- any rejected candidate and the exact reason it was raised.

Do not include raw world data, logs, secrets, temporary absolute paths, or player UUID data.

- [ ] **Step 7: Recheck production hashes and commit calibration evidence**

Run:

```bash
shasum -a 256 server/server.properties > /tmp/minecraft-server-properties-after.sha256
find server/world-1.21.4 -type f -exec shasum -a 256 {} + | sort > /tmp/minecraft-world-after.sha256
diff -u /tmp/minecraft-server-properties-before.sha256 /tmp/minecraft-server-properties-after.sha256
diff -u /tmp/minecraft-world-before.sha256 /tmp/minecraft-world-after.sha256
```

Expected: both diffs have no output.

Run the focused tests again, then commit only the report and any calibrated launcher/test change:

```bash
git add docs/runtime-memory.md scripts/run-runtime.sh test/runtime-memory-launcher.test.mjs
git commit -m "docs: record verified runtime memory limits"
```

If launcher defaults did not change, omit those two files from `git add`.

---

### Task 6: Operator Documentation and Final Verification

**Files:**
- Modify: `README.md:80-108,123`
- Verify: every file changed by Tasks 1-5

**Interfaces:**
- Consumes: accepted limits and exact metrics in `docs/runtime-memory.md`.
- Produces: operator-facing startup/override documentation and final acceptance evidence.

- [ ] **Step 1: Add the runtime-memory section to README**

Document that normal commands use safe defaults automatically, show the exact accepted values from `docs/runtime-memory.md`, link that report, and include override examples:

```sh
MC_SERVER_INITIAL_HEAP=512M npm run server
MC_BOT_MAX_OLD_SPACE_MB=512 npm run bot
MC_MEADOW_MAX_OLD_SPACE_MB=1024 npm run meadow-live
MC_MOVIE_WAR_MAX_OLD_SPACE_MB=2048 npm run movie-war
MC_SHOWRUNNER_MAX_OLD_SPACE_MB=512 npm run showrunner -- validate production/episodes/stolen-map.yaml
```

State that increasing limits does not alter worlds, that lowering below verified defaults is experimental, and that the only expected default tradeoff is slightly slower startup or occasional additional garbage collection.

- [ ] **Step 2: Run the complete automated suite**

Run: `node --test test/*.test.mjs`

Expected: zero failed tests. Record the exact pass/fail totals in the final handoff; do not reuse a previous run.

- [ ] **Step 3: Run static and repository-scope checks**

Run:

```bash
git diff --check
git status --short
git diff --name-only HEAD~5..HEAD
```

Expected: no whitespace errors; `TRANSFER_TO_NEW_MAC.md` remains untracked and unstaged; no world, backup, log, artifact, recording, secret, or server-properties path appears in the implementation commits.

- [ ] **Step 4: Re-run optimized print-only and process-exit checks**

Run every launcher profile with `MC_MEMORY_PRINT_ONLY=1` and verify its accepted flags. Then run one final copied-world optimized server + meadow smoke check, wait for `[meadow-live] WAITING`, send SIGTERM to meadow, send `stop` to Java, and verify both processes exit without forced termination. Do not issue `begin`.

- [ ] **Step 5: Commit README and any final report correction**

```bash
git add README.md docs/runtime-memory.md
git commit -m "docs: explain verified RAM-saving controls"
```

If `docs/runtime-memory.md` has no Task 6 correction, stage only `README.md`.

- [ ] **Step 6: Perform verification-before-completion review**

Compare the final diff line-by-line with all eight acceptance criteria in `docs/superpowers/specs/2026-08-08-lossless-ram-reduction-design.md`. Report exact Java committed-heap and RSS change, each Node peak/limit/headroom result, automated test totals, graceful shutdown evidence, unchanged production hashes, and any remaining concern. Do not claim that a Node ceiling saved current RSS unless the measured optimized RSS is lower.
