import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { createShowrunner } from '../src/showrunner/state-machine.mjs';
import { signApprovedBank, sourceEpisodeHash } from '../src/showrunner/approved-bank.mjs';

const { privateKey: approvalPrivateKey, publicKey: approvalPublicKey } = generateKeyPairSync('ed25519');

function approvedBank(episode) {
  const episodeHash = sourceEpisodeHash(episode);
  const hardValidation = { ok: true, violations: [] };
  const variants = [
    { id: 'rival-approved', cueId: 'rival_reveal', speaker: 'rival', text: 'Your map is mine.', hardValidation, softScores: {}, decision: { candidateId: 'rival-candidate', approved: true, variantId: 'rival-approved', creator: 'Jay' } },
    { id: 'hero-approved', cueId: 'hero_reply', speaker: 'hero', text: 'Not for long.', hardValidation, softScores: {}, decision: { candidateId: 'hero-candidate', approved: true, variantId: 'hero-approved', creator: 'Jay' } }
  ];
  const fallbacks = episode.scene.cues.map((cue) => ({
    id: `fallback:${cue.id}`, cueId: cue.id, speaker: cue.speaker, text: cue.fallbackLine, hardValidation,
    decision: { approved: true, kind: 'authored-fallback', lineId: `fallback:${cue.id}`, creator: 'Jay' }
  }));
  const sealed = signApprovedBank({
    schemaVersion: 2,
    creator: 'Jay',
    sourceEpisodeHash: episodeHash,
    provenance: {
      provider: 'test', model: 'test', promptTemplateVersion: 'v2', promptHash: 'a'.repeat(64),
      tokens: { input: 1, output: 1 }, latencyMs: 1, sourceEpisodeHash: episodeHash
    },
    variants,
    fallbacks
  }, approvalPrivateKey);
  assert.equal(sealed.ok, true);
  return sealed.bank;
}

function input(overrides = {}) {
  const episode = {
    schemaVersion: 1,
    episode: 'stolen-map',
    actors: { hero: {}, rival: {} },
    set: { baselineManifest: { actorBaselines: { hero: { mark: 'hero_start' }, rival: { mark: 'rival_start' } } } },
    scene: {
      id: 'confrontation',
      dialoguePolicy: { maximumWordsPerLine: 18, forbiddenLiterals: [], forbiddenPatterns: [] },
      marks: {
        hero_start: { dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 1 }, facing: { yaw: 0, pitch: 0 }, radius: 1, dwellTicks: 2, safeHeadroom: true },
        rival_start: { dimension: 'minecraft:overworld', position: { x: 3, y: 64, z: 1 }, facing: { yaw: 180, pitch: 0 }, radius: 1, dwellTicks: 2, safeHeadroom: true }
      },
      cues: [
        { id: 'rival_reveal', speaker: 'rival', mark: 'rival_start', approvedVariants: ['rival-approved'], fallbackLine: 'I have the map.', timeoutSeconds: 12 },
        { id: 'hero_reply', speaker: 'hero', mark: 'hero_start', approvedVariants: ['hero-approved'], fallbackLine: 'I will take it back.', timeoutSeconds: 12 }
      ]
    },
    retry: { wholeSceneAttempts: 2 }
  };
    return {
    productionId: 'production-a',
    takeId: 'take-a',
    episode,
    approvedBank: approvedBank(episode),
    selectedLines: {
      rival_reveal: { id: 'rival-approved', text: 'Your map is mine.' },
      hero_reply: { id: 'hero-approved', text: 'Not for long.' }
    },
    ...overrides
  };
}

function fakeRig(options = {}) {
  let now = 100;
  const commands = [];
  const commandSinks = new Map();
  const spokenCueIds = [];
  const fallbackCueIds = [];
  const spokenLineIds = [];
  const background = [];
  const completedForTest = new Set();

  function proofFor(command) {
    if (command.kind === 'prepareTake') {
      return { kind: 'preparation', authoritative: true, prepared: true, actors: command.payload.actors };
    }
    if (command.kind === 'armCapture') {
      return { kind: 'captureArm', authoritative: true, armed: true, takeId: command.takeId };
    }
    if (command.kind === 'moveToMark') {
      return {
        kind: 'mark', authoritative: true, actor: command.target.actor, markId: command.payload.markId,
        dimension: command.payload.mark.dimension, radius: true, facing: true, safeHeadroom: true,
        dwellTicks: command.payload.mark.dwellTicks
      };
    }
    if (command.kind === 'speak') {
      return {
        kind: 'speech', authoritative: true, observed: true, speaker: command.target.actor,
        cueId: command.cueId, text: command.payload.text
      };
    }
    if (command.kind === 'cancel') {
      return { kind: 'quiescence', authoritative: true, quiescent: true, targetAttemptId: command.payload.targetAttemptId };
    }
    if (command.kind === 'cancelTimer') {
      return { kind: 'quiescence', authoritative: true, quiescent: true, resourceKind: 'timer', resourceId: command.payload.timerId };
    }
    if (command.kind === 'cancelCapture') {
      return {
        kind: 'quiescence', authoritative: true, quiescent: true, resourceKind: 'capture',
        resourceId: command.payload.captureCommandId
      };
    }
    if (command.kind === 'stopCapture') {
      return {
        kind: 'capture', authoritative: true, ok: true, takeId: command.takeId,
        path: `/recordings/${command.takeId}.mkv`,
        coverage: { complete: true, startMonotonicTimestamp: 1, endMonotonicTimestamp: 2 }
      };
    }
    if (command.kind === 'resetBaseline') {
      const number = Number(command.payload.failedAttemptId.match(/:attempt:(\d+)/)?.[1] ?? 0) + 1;
      return {
        kind: 'reset', authoritative: true, verified: true,
        nextAttempt: { id: `${command.takeId}:attempt:${number}`, number }
      };
    }
    throw new Error(`No proof fixture for ${command.kind}`);
  }

  function send(sink, kind, payload = {}) {
    return sink.emit(sink.createEvent(kind, payload));
  }

  const autoBarrier = (command, sink) => {
    const work = send(sink, 'commandAcknowledged', { commandId: command.commandId })
      .then(() => send(sink, 'commandCompleted', { commandId: command.commandId }))
      .then(() => send(sink, 'observationVerified', {
        commandId: command.commandId,
        proof: proofFor(command)
      }));
    background.push(work);
  };

  const record = (target) => ({ execute(command, sink) {
    commands.push({ target, command });
    commandSinks.set(command.commandId, sink);
    if (command.kind === 'speak') {
      spokenCueIds.push(command.cueId);
      spokenLineIds.push(command.payload.authoredLineId ?? command.cueId);
      if (command.payload.fallback) fallbackCueIds.push(command.cueId);
      return;
    }
    if (command.kind === 'moveToMark') return;
    if (command.kind === 'preRoll' || command.kind === 'cueTimeout' || command.kind === 'cleanupTimeout') {
      if (options.failTimerAction === command.kind) return Promise.reject(new Error(`${command.kind}-schedule-failed`));
      const scheduling = send(sink, 'commandAcknowledged', { commandId: command.commandId })
        .then(() => send(sink, 'commandCompleted', { commandId: command.commandId }));
      if (command.kind === 'preRoll' && !options.manualPreRollFire) {
        background.push(scheduling.then(() => send(sink, 'timerFired', { commandId: command.commandId })));
      } else {
        background.push(scheduling);
      }
      return;
    }
    if (command.kind === 'cancelTimer' && options.manualTimerCancel) return;
    if (command.kind === 'cancelTimer' && options.failTimerCancel && command.payload.reason === 'cue-complete') {
      return Promise.reject(new Error('timer-cancel-failed'));
    }
    if (options.manualRetryCleanup && ['cancel', 'cancelTimer', 'cancelCapture'].includes(command.kind)) return;
    if (command.kind === 'armCapture' && options.manualCaptureArm) return;
    autoBarrier(command, sink);
  } });

  const dependencies = {
    actors: { hero: record('actor:hero'), rival: record('actor:rival') },
    production: record('production'),
    capture: record('capture'),
    timers: record('timers'),
    clock: { now: () => now++ },
    ids: {
      attempt: ({ takeId, number }) => `${takeId}:attempt:${number}`,
      command: ({ attemptId, number }) => `${attemptId}:command:${number}`,
      event: () => 'unused-source-event-id'
    },
    approvalPublicKey,
    ...options.dependencies
  };

  let runner;
  async function flush() {
    while (background.length > 0) await background.shift();
    await runner.dispatch({ kind: 'flush' });
  }

  function find(kind, predicate = () => true) {
    return [...commands].reverse().find(({ command }) => command.kind === kind && predicate(command))?.command;
  }

  async function emitBarrier(command, { ack = true, completion = true, observation = true } = {}) {
    const sink = commandSinks.get(command.commandId);
    if (ack) await send(sink, 'commandAcknowledged', { commandId: command.commandId });
    if (completion) await send(sink, 'commandCompleted', { commandId: command.commandId });
    if (observation) await send(sink, 'observationVerified', { commandId: command.commandId, proof: proofFor(command) });
    await flush();
  }

  const rig = {
    dependencies,
    input: input(),
    commands,
    spokenCueIds,
    spokenLineIds,
    fallbackCueIds,
    proofFor,
    attach(value) { runner = value; },
    flush,
    async ackCapture(overrides = {}) {
      await flush();
      const snapshot = runner.snapshot();
      await runner.dispatch(fencedEvent(snapshot, 'captureReady', {
        takeId: overrides.takeId ?? snapshot.takeId,
        path: overrides.path ?? `/recordings/${snapshot.takeId}.mkv`
      }, overrides));
      await flush();
    },
    async completeMark(actor, options) {
      await flush();
      const command = find('moveToMark', (candidate) => candidate.target.actor === actor && !completedForTest.has(candidate.commandId));
      assert.ok(command, `missing mark command for ${actor}`);
      completedForTest.add(command.commandId);
      await emitBarrier(command, options);
    },
    async completeCue(cueId, options) {
      await flush();
      const command = find('speak', (candidate) => candidate.cueId === cueId && !completedForTest.has(candidate.commandId));
      assert.ok(command, `missing cue command for ${cueId}`);
      completedForTest.add(command.commandId);
      await emitBarrier(command, options);
    },
    async finishCuePart(cueId, kind) {
      await flush();
      const command = find('speak', (candidate) => candidate.cueId === cueId);
      const sink = commandSinks.get(command.commandId);
      const payload = kind === 'observationVerified'
        ? { commandId: command.commandId, proof: proofFor(command) }
        : { commandId: command.commandId };
      await send(sink, kind, payload);
      await flush();
    },
    async emitFor(command, kind, payload = {}) {
      const sink = commandSinks.get(command.commandId);
      const eventPayload = kind === 'observationVerified' && payload.proof === undefined
        ? { commandId: command.commandId, proof: proofFor(command) }
        : { commandId: command.commandId, ...payload };
      await send(sink, kind, eventPayload);
      await flush();
    },
    async failCurrentCue(reason = 'actor-stuck') {
      await flush();
      const command = find('speak', (candidate) => candidate.commandId === runner.snapshot().speakerToken?.commandId);
      const sink = commandSinks.get(command.commandId);
      await send(sink, 'commandFailed', { commandId: command.commandId, reason });
      await flush();
      return { command, sink };
    },
    async fireCueTimeout() {
      await flush();
      const token = runner.snapshot().speakerToken;
      const command = find('cueTimeout', (candidate) => candidate.payload.speechCommandId === token?.commandId);
      assert.ok(command, 'missing current cue timeout');
      await send(commandSinks.get(command.commandId), 'timerFired', { commandId: command.commandId });
      await flush();
    }
  };

  runner = createShowrunner(dependencies);
  return { rig, runner };
}

function fencedEvent(snapshot, kind, payload, overrides = {}) {
  return {
    kind,
    productionId: overrides.productionId ?? snapshot.productionId,
    takeId: overrides.takeId ?? snapshot.takeId,
    sceneId: overrides.sceneId ?? snapshot.sceneId,
    beatId: overrides.beatId ?? snapshot.beatId,
    attemptId: overrides.attemptId ?? snapshot.attemptId,
    cueId: overrides.cueId ?? snapshot.cueId,
    eventId: overrides.eventId ?? `manual-${snapshot.causalSequence + 1}`,
    causalSequence: overrides.causalSequence ?? snapshot.causalSequence + 1,
    monotonicTimestamp: overrides.monotonicTimestamp ?? 500,
    payload
  };
}

async function reachFirstCue(rig, runner) {
  await runner.startTake(rig.input);
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');
}

function survivalInput() {
  const source = input();
  source.episode.title = 'Stolen Map';
  source.episode.scene.cues[0].goalId = 'gather-hero';
  source.survivalEpisode = {
    schemaVersion: 1,
    episode: source.episode.episode,
    title: source.episode.title,
    actors: ['hero', 'rival'],
    dialogueBoundaries: ['gather-hero']
  };
  source.approvedBank = approvedBank(source.episode);
  return source;
}

function parallelSurvivalInput() {
  const source = input();
  source.episode.title = 'Stolen Map';
  source.episode.scene.cues[0].goalId = 'gather-hero';
  source.episode.scene.cues[1].goalId = 'gather-rival';
  source.survivalEpisode = {
    schemaVersion: 1,
    episode: source.episode.episode,
    title: source.episode.title,
    actors: ['hero', 'rival'],
    dialogueBoundaries: ['gather-hero', 'gather-rival']
  };
  source.approvedBank = approvedBank(source.episode);
  return source;
}

function sealSchemaTwoDialogue(source, exchanges) {
  exchanges = [...exchanges];
  while (exchanges.length < 6) {
    const number = exchanges.length + 1;
    const cueId = `filming_pad_${number}`;
    exchanges.push({
      id: cueId, survivalBeatId: cueId, survivalGoalIds: [], timeoutSeconds: 12,
      dialogue: [{
        id: `${cueId}_hero`, cueId, speaker: 'hero', mark: 'hero_start', requiredIntent: 'continue the scene',
        approvedVariants: [`Continue ${number}.`], fallbackLine: `Continue ${number}.`
      }]
    });
  }
  source.episode.schemaVersion = 2;
  source.episode.title = 'Stolen Map';
  source.episode.scene.cues = exchanges;
  source.survivalEpisode = {
    schemaVersion: 2,
    episode: source.episode.episode,
    title: source.episode.title,
    actors: ['hero', 'rival'],
    marks: {},
    beats: exchanges.map(({ id, survivalGoalIds }) => ({ id, goalIds: survivalGoalIds })),
    goals: exchanges.flatMap(({ survivalGoalIds }) => survivalGoalIds.map((id) => ({ id })))
  };
  const hardValidation = { ok: true, violations: [] };
  const lines = exchanges.flatMap(({ dialogue }) => dialogue);
  const episodeHash = sourceEpisodeHash(source.episode);
  const sealed = signApprovedBank({
    schemaVersion: 2,
    creator: 'Jay',
    sourceEpisodeHash: episodeHash,
    provenance: {
      provider: 'test', model: 'test', promptTemplateVersion: 'v2', promptHash: 'b'.repeat(64),
      tokens: { input: 1, output: 1 }, latencyMs: 1, sourceEpisodeHash: episodeHash
    },
    variants: lines.map((line) => ({
      id: `${line.id}-approved`, cueId: line.cueId, authoredLineId: line.id, speaker: line.speaker,
      text: line.approvedVariants[0], hardValidation, softScores: {},
      decision: {
        candidateId: `${line.id}-candidate`, approved: true, variantId: `${line.id}-approved`, creator: 'Jay'
      }
    })),
    fallbacks: lines.map((line) => ({
      id: `fallback:${line.id}`, cueId: line.cueId, authoredLineId: line.id, speaker: line.speaker,
      text: line.fallbackLine, hardValidation,
      decision: { approved: true, kind: 'authored-fallback', lineId: `fallback:${line.id}`, creator: 'Jay' }
    }))
  }, approvalPrivateKey);
  assert.equal(sealed.ok, true);
  source.approvedBank = sealed.bank;
  source.selectedLines = Object.fromEntries(lines.map((line) => [
    line.id, { id: `${line.id}-approved`, text: line.approvedVariants[0] }
  ]));
  return source;
}

function beatSurvivalInput() {
  const source = input();
  return sealSchemaTwoDialogue(source, source.episode.scene.cues.map((cue, index) => ({
    id: cue.id,
    survivalBeatId: cue.id,
    survivalGoalIds: [],
    timeoutSeconds: cue.timeoutSeconds,
    dialogue: [{ ...cue, id: `${cue.id}_line`, cueId: cue.id }]
  })));
}

function multilineBeatSurvivalInput() {
  const source = input();
  const exchanges = [
    {
      id: 'rival_reveal',
      survivalBeatId: 'rival_reveal',
      survivalGoalIds: [],
      timeoutSeconds: 12,
      dialogue: [
        {
          id: 'rival_reveal_rival', cueId: 'rival_reveal', speaker: 'rival', mark: 'rival_start',
          requiredIntent: 'claim the map', approvedVariants: ['Your map is mine.'], fallbackLine: 'I have the map.'
        },
        {
          id: 'rival_reveal_hero', cueId: 'rival_reveal', speaker: 'hero', mark: 'hero_start',
          requiredIntent: 'reject the claim', approvedVariants: ['Not for long.'], fallbackLine: 'I will take it back.'
        }
      ]
    },
    {
      id: 'hero_reply',
      survivalBeatId: 'hero_reply',
      survivalGoalIds: [],
      timeoutSeconds: 12,
      dialogue: [
        {
          id: 'hero_reply_hero', cueId: 'hero_reply', speaker: 'hero', mark: 'hero_start',
          requiredIntent: 'promise recovery', approvedVariants: ['I will recover it.'], fallbackLine: 'I will recover it.'
        },
        {
          id: 'hero_reply_rival', cueId: 'hero_reply', speaker: 'rival', mark: 'rival_start',
          requiredIntent: 'hold position', approvedVariants: ['Then come and try.'], fallbackLine: 'Then come and try.'
        }
      ]
    }
  ];
  return sealSchemaTwoDialogue(source, exchanges);
}

test('serializes preparation, capture, marks, cues, and completion', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);

  await runner.startTake(rig.input);
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');
  await rig.completeCue('rival_reveal');
  await rig.completeCue('hero_reply');

  assert.equal(runner.snapshot().state, 'completed');
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal', 'hero_reply']);
});

test('rejects capture readiness for another take without advancing', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await runner.startTake(rig.input);
  await rig.flush();

  const before = runner.snapshot();
  await runner.dispatch(fencedEvent(before, 'captureReady', { takeId: 'take-b', path: '/recordings/take-b.mkv' }, { takeId: 'take-b' }));

  assert.equal(runner.snapshot().state, 'awaiting_capture');
  assert.equal(runner.snapshot().ignoredEvents.at(-1).reason, 'WRONG_TAKE');
});

test('does not await capture readiness until capture arming crosses its full barrier', async () => {
  const { rig, runner } = fakeRig({ manualCaptureArm: true });
  rig.attach(runner);
  await runner.startTake(rig.input);
  await rig.flush();
  const arm = rig.commands.find(({ command }) => command.kind === 'armCapture').command;

  assert.equal(runner.snapshot().state, 'preparing');
  await runner.dispatch(fencedEvent(runner.snapshot(), 'captureReady', {
    takeId: runner.snapshot().takeId,
    path: '/recordings/take-a.mkv'
  }));
  assert.equal(runner.snapshot().state, 'preparing');

  await rig.emitFor(arm, 'commandAcknowledged');
  await rig.emitFor(arm, 'commandCompleted');
  assert.equal(runner.snapshot().state, 'preparing');
  await rig.emitFor(arm, 'observationVerified');
  assert.equal(runner.snapshot().state, 'awaiting_capture');
});

test('cancels capture when emergency stop interrupts a partially acknowledged arm', async (t) => {
  for (const [name, events] of [
    ['acknowledged', ['commandAcknowledged']],
    ['completed', ['commandAcknowledged', 'commandCompleted']]
  ]) {
    await t.test(name, async () => {
      const { rig, runner } = fakeRig({ manualCaptureArm: true, manualRetryCleanup: true });
      rig.attach(runner);
      await runner.startTake(rig.input);
      await rig.flush();
      const arm = rig.commands.find(({ command }) => command.kind === 'armCapture').command;
      for (const event of events) await rig.emitFor(arm, event);

      assert.equal(runner.snapshot().captureLifecycle.status, 'pending');
      await runner.emergencyStop(`stop-after-${name}`);
      const cancellation = rig.commands.find(({ command }) => command.kind === 'cancelCapture').command;
      assert.equal(cancellation.payload.captureCommandId, arm.commandId);
      assert.equal(runner.snapshot().captureLifecycle.status, 'cancelling');

      await rig.emitFor(cancellation, 'commandAcknowledged');
      await rig.emitFor(cancellation, 'commandCompleted');
      await rig.emitFor(cancellation, 'observationVerified');
      assert.equal(runner.snapshot().captureLifecycle.status, 'inactive');
    });
  }
});

test('does not issue a cue until both mark commands have authoritative dwell verification', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await runner.startTake(rig.input);
  await rig.ackCapture();

  await rig.completeMark('hero');
  assert.deepEqual(rig.spokenCueIds, []);
  await rig.completeMark('rival', { observation: false });
  assert.deepEqual(rig.spokenCueIds, []);

  const rivalMove = [...rig.commands].reverse().find(({ command }) => command.kind === 'moveToMark' && command.target.actor === 'rival').command;
  await rig.emitFor(rivalMove, 'observationVerified');
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);
});

test('does not start authored dialogue during a Survival critical section', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  rig.input = survivalInput();
  await runner.startTake(rig.input);
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');

  assert.deepEqual(rig.spokenCueIds, []);
  await runner.dispatch(fencedEvent(runner.snapshot(), 'safeDialogueBoundary', {
    goalId: 'gather-hero', proof: { authoritative: true, interruptible: true }
  }));
  await rig.flush();
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);
});

test('does not advance a Survival beat on verified speech alone', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  rig.input = survivalInput();
  await runner.startTake(rig.input);
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');
  await runner.dispatch(fencedEvent(runner.snapshot(), 'safeDialogueBoundary', {
    goalId: 'gather-hero', proof: { authoritative: true, interruptible: true }
  }));
  await rig.completeCue('rival_reveal');

  assert.equal(runner.snapshot().cueIndex, 0);
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);
  await runner.dispatch(fencedEvent(runner.snapshot(), 'goalCompleted', {
    goalId: 'gather-hero', observationVersion: 8,
    proof: { authoritative: true, completionSatisfied: true }
  }));
  await rig.flush();

  assert.equal(runner.snapshot().cueIndex, 1);
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal', 'hero_reply']);
});

test('buffers later parallel goal proof and consumes its boundary when that cue becomes current', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  rig.input = parallelSurvivalInput();
  await runner.startTake(rig.input);
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');

  for (const [kind, payload] of [
    ['goalCompleted', {
      goalId: 'gather-rival', observationVersion: 9,
      proof: { authoritative: true, completionSatisfied: true }
    }],
    ['safeDialogueBoundary', {
      goalId: 'gather-rival', proof: { authoritative: true, interruptible: true }
    }],
    ['goalCompleted', {
      goalId: 'gather-hero', observationVersion: 8,
      proof: { authoritative: true, completionSatisfied: true }
    }],
    ['safeDialogueBoundary', {
      goalId: 'gather-hero', proof: { authoritative: true, interruptible: true }
    }]
  ]) await runner.dispatch(fencedEvent(runner.snapshot(), kind, payload));

  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);
  assert.equal(runner.snapshot().survivalGoals['gather-rival'].completed, true);
  assert.equal(runner.snapshot().survivalGoals['gather-rival'].safe, true);
  await rig.completeCue('rival_reveal');

  assert.equal(runner.snapshot().cueIndex, 1);
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal', 'hero_reply']);
  await rig.completeCue('hero_reply');
  assert.equal(runner.snapshot().state, 'completed');
});

test('sends fenced dialogue completion with the next showrunner identity to the Survival coordinator', async () => {
  const handshakes = [];
  const { rig, runner } = fakeRig({
    dependencies: { survivalCoordinator: { async handle(event) { handshakes.push(event); } } }
  });
  rig.attach(runner);
  rig.input = survivalInput();
  await runner.startTake(rig.input);
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');
  await runner.dispatch(fencedEvent(runner.snapshot(), 'goalCompleted', {
    goalId: 'gather-hero', observationVersion: 8,
    proof: { authoritative: true, completionSatisfied: true }
  }));
  await runner.dispatch(fencedEvent(runner.snapshot(), 'safeDialogueBoundary', {
    goalId: 'gather-hero', proof: { authoritative: true, interruptible: true }
  }));
  await rig.completeCue('rival_reveal');

  assert.equal(handshakes.length, 1);
  assert.equal(handshakes[0].kind, 'dialogueCompleted');
  assert.equal(handshakes[0].cueId, 'rival_reveal');
  assert.equal(handshakes[0].payload.goalId, 'gather-hero');
  assert.equal(handshakes[0].payload.nextIdentity.cueId, 'hero_reply');
  assert.deepEqual(handshakes[0].payload.proof, { authoritative: true, dialogueCompleted: true });
});

test('holds dialogue-first beat speech until authoritative matching beat completion', async () => {
  const handshakes = [];
  const { rig, runner } = fakeRig({
    dependencies: { survivalCoordinator: { async handle(event) { handshakes.push(event); } } }
  });
  rig.attach(runner);
  rig.input = beatSurvivalInput();
  await reachFirstCue(rig, runner);

  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);
  await rig.completeCue('rival_reveal');

  assert.equal(runner.snapshot().cueIndex, 0);
  assert.equal(runner.snapshot().survivalBeats.rival_reveal.dialogueCompleted, true);
  assert.equal(runner.snapshot().transcript.length, 0);
  assert.equal(handshakes.length, 1);
  assert.equal(handshakes[0].payload.beatId, 'rival_reveal');
  assert.deepEqual(handshakes[0].payload.proof, { authoritative: true, dialogueCompleted: true });
  assert.equal(handshakes[0].causalSequence, runner.snapshot().causalSequence);

  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatCompleted', {
    beatId: 'rival_reveal', goalIds: ['not-authored'], proof: { authoritative: true, completed: true }
  }));
  assert.equal(runner.snapshot().cueIndex, 0);
  assert.equal(runner.snapshot().ignoredEvents.at(-1).reason, 'SURVIVAL_BEAT_GOALS_MISMATCH');

  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatCompleted', {
    beatId: 'hero_reply', goalIds: [], proof: { authoritative: true, completed: true }
  }));
  assert.equal(runner.snapshot().cueIndex, 0);
  assert.equal(runner.snapshot().ignoredEvents.at(-1).reason, 'SURVIVAL_BEAT_UNKNOWN');

  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatCompleted', {
    beatId: 'rival_reveal', goalIds: [], proof: { authoritative: true, completed: true }
  }));
  await rig.flush();

  assert.equal(runner.snapshot().cueIndex, 1);
  assert.deepEqual(runner.snapshot().transcript.map(({ cueId }) => cueId), ['rival_reveal']);
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal', 'hero_reply']);
});

test('executes every signed line in a visible beat before dialogue completion and commits them in order', async () => {
  const handshakes = [];
  const { rig, runner } = fakeRig({
    dependencies: { survivalCoordinator: { async handle(event) { handshakes.push(event); } } }
  });
  rig.attach(runner);
  rig.input = multilineBeatSurvivalInput();
  await reachFirstCue(rig, runner);

  assert.deepEqual(rig.spokenLineIds, ['rival_reveal_rival']);
  await rig.completeCue('rival_reveal');
  assert.equal(runner.snapshot().cueIndex, 0);
  assert.equal(runner.snapshot().transcript.length, 0);
  assert.equal(handshakes.length, 0);
  assert.deepEqual(rig.spokenLineIds, ['rival_reveal_rival', 'rival_reveal_hero']);

  await rig.completeCue('rival_reveal');
  assert.equal(runner.snapshot().cueIndex, 0);
  assert.equal(runner.snapshot().transcript.length, 0);
  assert.equal(handshakes.length, 1);
  assert.deepEqual(rig.commands
    .filter(({ command }) => command.kind === 'speak' && command.cueId === 'rival_reveal')
    .map(({ command }) => ({
      lineId: command.payload.authoredLineId,
      signedLineId: command.payload.authorization.authoredLineId,
      speaker: command.target.actor
    })), [
    { lineId: 'rival_reveal_rival', signedLineId: 'rival_reveal_rival', speaker: 'rival' },
    { lineId: 'rival_reveal_hero', signedLineId: 'rival_reveal_hero', speaker: 'hero' }
  ]);

  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatCompleted', {
    beatId: 'rival_reveal', goalIds: [], proof: { authoritative: true, completed: true }
  }));
  await rig.flush();

  assert.deepEqual(runner.snapshot().transcript.map(({ cueId, lineId, speaker, text }) => ({ cueId, lineId, speaker, text })), [
    { cueId: 'rival_reveal', lineId: 'rival_reveal_rival', speaker: 'rival', text: 'Your map is mine.' },
    { cueId: 'rival_reveal', lineId: 'rival_reveal_hero', speaker: 'hero', text: 'Not for long.' }
  ]);
  assert.deepEqual(rig.spokenLineIds, ['rival_reveal_rival', 'rival_reveal_hero', 'hero_reply_hero']);
});

test('drops a partially completed fixed exchange when its next line forces a whole-scene retry', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  rig.input = multilineBeatSurvivalInput();
  await reachFirstCue(rig, runner);
  await rig.completeCue('rival_reveal');
  assert.deepEqual(rig.spokenLineIds, ['rival_reveal_rival', 'rival_reveal_hero']);

  await rig.failCurrentCue('second-line-failed');
  const snapshot = runner.snapshot();
  assert.equal(snapshot.attemptNumber, 2);
  assert.deepEqual(snapshot.transcript, []);
  assert.equal(snapshot.completedSpeech, null);
  assert.deepEqual(snapshot.discardedAttempts.flatMap(({ transcript }) => transcript), []);
});

test('refuses to arm schema v2 when its complete cross-file beat partition is absent or mismatched', async () => {
  for (const mode of ['absent', 'mismatched', 'not-six-beats']) {
    const { rig, runner } = fakeRig();
    rig.attach(runner);
    const source = multilineBeatSurvivalInput();
    if (mode === 'absent') delete source.survivalEpisode;
    else if (mode === 'mismatched') source.survivalEpisode.beats[0].id = 'spoofed_beat';
    else {
      source.episode.scene.cues.pop();
      source.survivalEpisode.beats.pop();
    }

    await assert.rejects(runner.startTake(source), { code: 'EPISODE_COMPOSITION_INVALID' });
    assert.deepEqual(rig.commands, []);
  }
});

test('refuses to arm schema v1 when authored goal_id bindings are absent or mismatched', async () => {
  for (const mode of ['absent', 'mismatched', 'unbound']) {
    const { rig, runner } = fakeRig();
    rig.attach(runner);
    const source = survivalInput();
    if (mode === 'absent') delete source.survivalEpisode;
    else if (mode === 'mismatched') source.survivalEpisode.dialogueBoundaries = ['another-goal'];
    else source.episode.scene.cues.forEach((cue) => { delete cue.goalId; });

    await assert.rejects(runner.startTake(source), { code: 'EPISODE_COMPOSITION_INVALID' });
    assert.deepEqual(rig.commands, []);
  }
});

test('rejects a manually constructed unsupported episode schema before issuing commands', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  const source = input();
  source.episode.schemaVersion = 3;
  await assert.rejects(runner.startTake(source), TypeError);
  assert.deepEqual(rig.commands, []);
});

test('rejects beat completion before dialogue and fails the attempt on an authoritative internal blocker', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  rig.input = beatSurvivalInput();
  rig.input.episode.scene.cues[0].survivalGoalIds = ['internal-goal'];
  rig.input.episode.retry.wholeSceneAttempts = 1;
  sealSchemaTwoDialogue(rig.input, rig.input.episode.scene.cues);
  await reachFirstCue(rig, runner);

  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatCompleted', {
    beatId: 'rival_reveal', goalIds: ['internal-goal'], proof: { authoritative: true, completed: true }
  }));
  assert.equal(runner.snapshot().cueIndex, 0);
  assert.equal(runner.snapshot().ignoredEvents.at(-1).reason, 'SURVIVAL_BEAT_DIALOGUE_PENDING');

  await rig.completeCue('rival_reveal');
  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatBlocked', {
    beatId: 'rival_reveal', goalId: 'internal-goal', observationVersion: 1, reason: 'NO_VALID_TARGET',
    proof: { authoritative: true, terminal: true }
  }));
  await rig.flush();

  assert.equal(runner.snapshot().state, 'aborted');
  assert.equal(runner.snapshot().lastError, 'NO_VALID_TARGET');
});

test('rebinds the Survival coordinator to attempt two only after verified retry cleanup and reset', async () => {
  const rebinds = [];
  const cancellations = [];
  let rig;
  const survivalCoordinator = {
    async expectDialogue() {},
    async handle() {},
    async cancel(attemptId) {
      cancellations.push({
        attemptId,
        actorCancelCommandsAlreadyDelivered: rig.commands.filter(({ command }) => command.kind === 'cancel').length
      });
    },
    async rebind(request) { rebinds.push(request); }
  };
  const setup = fakeRig({ dependencies: { survivalCoordinator } });
  ({ rig } = setup);
  const { runner } = setup;
  rig.attach(runner);
  rig.input = beatSurvivalInput();
  rig.input.episode.scene.cues[0].survivalGoalIds = ['internal-goal'];
  sealSchemaTwoDialogue(rig.input, rig.input.episode.scene.cues);
  await reachFirstCue(rig, runner);
  await rig.completeCue('rival_reveal');

  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatBlocked', {
    beatId: 'rival_reveal', goalId: 'internal-goal', observationVersion: 1, reason: 'NO_VALID_TARGET',
    proof: { authoritative: true, terminal: true }
  }));
  await rig.flush();

  assert.equal(runner.snapshot().attemptNumber, 2);
  assert.deepEqual(cancellations, [{
    attemptId: 'take-a:attempt:1',
    actorCancelCommandsAlreadyDelivered: 0
  }]);
  assert.equal(rebinds.length, 1);
  assert.equal(rebinds[0].previousAttemptId, 'take-a:attempt:1');
  assert.equal(rebinds[0].nextIdentity.attemptId, 'take-a:attempt:2');
  assert.equal(rebinds[0].nextIdentity.beatId, 'rival_reveal');
  assert.deepEqual(rebinds[0].proof, {
    authoritative: true, cleanupVerified: true, resetVerified: true
  });
});

test('cancels the Survival coordinator before actor cleanup when a non-coordinator speech failure retries', async () => {
  const cancellations = [];
  const rebinds = [];
  let rig;
  const survivalCoordinator = {
    async expectDialogue() {},
    async handle() {},
    async cancel(attemptId) {
      cancellations.push({
        attemptId,
        actorCancelCommandsAlreadyDelivered: rig.commands.filter(({ command }) => command.kind === 'cancel').length
      });
    },
    async rebind(request) { rebinds.push(request); }
  };
  const setup = fakeRig({ dependencies: { survivalCoordinator } });
  ({ rig } = setup);
  const { runner } = setup;
  rig.attach(runner);
  rig.input = beatSurvivalInput();
  sealSchemaTwoDialogue(rig.input, rig.input.episode.scene.cues);
  await reachFirstCue(rig, runner);

  const speech = rig.commands.find(({ command }) => command.kind === 'speak').command;
  await rig.emitFor(speech, 'commandFailed', { reason: 'speech-transport-failed' });
  await rig.flush();

  assert.deepEqual(cancellations, [{
    attemptId: 'take-a:attempt:1',
    actorCancelCommandsAlreadyDelivered: 0
  }]);
  assert.equal(rebinds.length, 1);
  assert.equal(rebinds[0].previousAttemptId, 'take-a:attempt:1');
  assert.equal(rebinds[0].nextIdentity.attemptId, 'take-a:attempt:2');
  assert.equal(runner.snapshot().attemptNumber, 2);
});

test('cancels the Survival coordinator on a terminal showrunner abort', async () => {
  const cancellations = [];
  const survivalCoordinator = {
    async handle() {},
    async cancel(attemptId) { cancellations.push(attemptId); }
  };
  const { rig, runner } = fakeRig({ dependencies: { survivalCoordinator } });
  rig.attach(runner);
  rig.input = beatSurvivalInput();
  rig.input.episode.retry.wholeSceneAttempts = 1;
  sealSchemaTwoDialogue(rig.input, rig.input.episode.scene.cues);
  await reachFirstCue(rig, runner);

  await runner.emergencyStop('operator-stop');
  await rig.flush();

  assert.deepEqual(cancellations, ['take-a:attempt:1']);
  assert.equal(runner.snapshot().state, 'aborted');
});

test('requires authoritative completion of every authored internal goal before closing a beat', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  rig.input = beatSurvivalInput();
  rig.input.episode.scene.cues[0].survivalGoalIds = ['internal-goal'];
  sealSchemaTwoDialogue(rig.input, rig.input.episode.scene.cues);
  await reachFirstCue(rig, runner);
  await rig.completeCue('rival_reveal');

  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatCompleted', {
    beatId: 'rival_reveal', goalIds: ['internal-goal'], proof: { authoritative: true, completed: true }
  }));
  assert.equal(runner.snapshot().cueIndex, 0);
  assert.equal(runner.snapshot().ignoredEvents.at(-1).reason, 'SURVIVAL_BEAT_GOALS_INCOMPLETE');

  await runner.dispatch(fencedEvent(runner.snapshot(), 'goalCompleted', {
    goalId: 'internal-goal', observationVersion: 1,
    proof: { authoritative: true, completionSatisfied: true }
  }));
  await runner.dispatch(fencedEvent(runner.snapshot(), 'beatCompleted', {
    beatId: 'rival_reveal', goalIds: ['internal-goal'], proof: { authoritative: true, completed: true }
  }));
  await rig.flush();

  assert.equal(runner.snapshot().survivalGoals['internal-goal'].completed, true);
  assert.equal(runner.snapshot().cueIndex, 1);
});

test('tracks timer scheduling until timer-fired supplies the authoritative observation', async () => {
  const { rig, runner } = fakeRig({ manualPreRollFire: true });
  rig.attach(runner);
  await runner.startTake(rig.input);
  await rig.ackCapture();
  const timer = rig.commands.find(({ command }) => command.kind === 'preRoll').command;
  const pending = runner.snapshot().pendingCommands[timer.commandId];

  assert.equal(pending.acknowledged, true);
  assert.equal(pending.completed, true);
  assert.equal(pending.observed, false);
  assert.equal(rig.commands.some(({ command }) => command.kind === 'moveToMark'), false);

  await rig.emitFor(timer, 'observationVerified', { proof: { kind: 'timer', authoritative: true } });
  assert.ok(runner.snapshot().pendingCommands[timer.commandId]);
  assert.equal(rig.commands.some(({ command }) => command.kind === 'moveToMark'), false);

  await rig.emitFor(timer, 'timerFired');
  assert.equal(runner.snapshot().pendingCommands[timer.commandId], undefined);
  assert.equal(rig.commands.filter(({ command }) => command.kind === 'moveToMark').length, 2);
});

test('aborts deterministically when pre-roll timer scheduling fails', async () => {
  const { rig, runner } = fakeRig({ failTimerAction: 'preRoll' });
  rig.attach(runner);
  await runner.startTake(rig.input);
  await rig.ackCapture();

  assert.equal(runner.snapshot().state, 'aborted');
  assert.match(runner.snapshot().lastError, /preRoll-schedule-failed/);
});

test('holds one speaker token until acknowledgement, completion, and authoritative observation all arrive', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await reachFirstCue(rig, runner);

  assert.equal(runner.snapshot().speakerToken.cueId, 'rival_reveal');
  await rig.completeCue('rival_reveal', { observation: false });
  assert.equal(runner.snapshot().speakerToken.cueId, 'rival_reveal');
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);

  const firstSpeech = rig.commands.find(({ command }) => command.kind === 'speak').command;
  await runner.dispatch(fencedEvent(runner.snapshot(), 'observationVerified', {
    commandId: firstSpeech.commandId, proof: rig.proofFor(firstSpeech)
  }));
  await rig.flush();

  assert.equal(runner.snapshot().speakerToken.cueId, 'hero_reply');
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal', 'hero_reply']);
});

test('tracks cue timer cancellation and waits for quiescence before issuing the next cue', async () => {
  const { rig, runner } = fakeRig({ manualTimerCancel: true });
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  await rig.completeCue('rival_reveal');
  const cancellation = rig.commands.find(({ command }) => command.kind === 'cancelTimer').command;

  assert.ok(cancellation.payload.timerId);
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);
  await rig.emitFor(cancellation, 'commandAcknowledged');
  await rig.emitFor(cancellation, 'commandCompleted');
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);
  await rig.emitFor(cancellation, 'observationVerified');
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal', 'hero_reply']);
});

test('aborts deterministically when cue timer cancellation fails', async () => {
  const { rig, runner } = fakeRig({ failTimerCancel: true });
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  await rig.completeCue('rival_reveal');

  assert.equal(runner.snapshot().state, 'aborted');
  assert.match(runner.snapshot().lastError, /timer-cancel-failed/);
  assert.deepEqual(rig.spokenCueIds, ['rival_reveal']);
});

test('does not issue an unsafe same-attempt fallback after speech times out', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  const failedAttemptId = runner.snapshot().attemptId;

  await rig.fireCueTimeout();

  assert.equal(runner.snapshot().attemptNumber, 2);
  assert.deepEqual(rig.fallbackCueIds, []);
  assert.equal(rig.commands.filter(({ command }) => command.kind === 'speak' && command.attemptId === failedAttemptId).length, 1);
});

test('does not speak fallback twice when a missing selection starts the cue on fallback', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  rig.input = input({
    selectedLines: { hero_reply: { id: 'hero-approved', text: 'Not for long.' } }
  });
  await reachFirstCue(rig, runner);

  assert.deepEqual(rig.fallbackCueIds, ['rival_reveal']);
  await rig.fireCueTimeout();

  assert.equal(runner.snapshot().attemptNumber, 2);
  assert.deepEqual(rig.fallbackCueIds, ['rival_reveal']);
});

test('consumes the retry instead of trying to retract already-emitted speech', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  const timedOutSpeech = runner.snapshot().speakerToken.commandId;

  await rig.fireCueTimeout();
  assert.equal(runner.snapshot().attemptNumber, 2);
  assert.equal(rig.commands.some(({ command }) => command.payload?.commandId === timedOutSpeech), false);
  assert.deepEqual(rig.fallbackCueIds, []);
});

test('creates a new attempt, ignores late old-attempt completion, and aborts on a second failure', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  const old = await rig.failCurrentCue();
  const afterRetry = runner.snapshot();

  assert.equal(afterRetry.attemptNumber, 2);
  assert.notEqual(afterRetry.attemptId, old.command.attemptId);

  await old.sink.emit(old.sink.createEvent('commandCompleted', { commandId: old.command.commandId }));
  await rig.flush();
  assert.equal(runner.snapshot().ignoredEvents.at(-1).reason, 'STALE_ATTEMPT');

  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');
  await rig.failCurrentCue('second-failure');
  assert.equal(runner.snapshot().state, 'aborted');
});

test('retries only after actors, every active timer, and capture report cancellation quiescence', async () => {
  const { rig, runner } = fakeRig({ manualRetryCleanup: true });
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  const activeTimerId = runner.snapshot().cueTimeoutId;
  await rig.failCurrentCue('force-retry');

  const deadline = rig.commands.find(({ command }) => command.kind === 'cleanupTimeout').command;
  const cleanup = rig.commands
    .map(({ command }) => command)
    .filter((command) => ['cancel', 'cancelTimer', 'cancelCapture'].includes(command.kind));
  assert.equal(cleanup.filter((command) => command.kind === 'cancel').length, 2);
  assert.equal(cleanup.find((command) => command.kind === 'cancelTimer')?.payload.timerId, activeTimerId);
  assert.ok(cleanup.find((command) => command.kind === 'cancelCapture'));
  assert.ok(deadline.payload.timeoutSeconds > 0);
  assert.equal(rig.commands.some(({ command }) => command.kind === 'resetBaseline'), false);

  for (const command of cleanup.slice(0, -1)) await rig.emitFor(command, 'commandAcknowledged');
  for (const command of cleanup.slice(0, -1)) await rig.emitFor(command, 'commandCompleted');
  for (const command of cleanup.slice(0, -1)) {
    await rig.emitFor(command, 'observationVerified');
  }
  assert.equal(rig.commands.some(({ command }) => command.kind === 'resetBaseline'), false);

  const last = cleanup.at(-1);
  await rig.emitFor(last, 'commandAcknowledged');
  await rig.emitFor(last, 'commandCompleted');
  assert.equal(rig.commands.some(({ command }) => command.kind === 'resetBaseline'), false);
  await rig.emitFor(last, 'observationVerified');
  const deadlineCancellation = [...rig.commands].reverse().find(({ command }) =>
    command.kind === 'cancelTimer' && command.payload.reason === 'cleanup-complete').command;
  assert.equal(rig.commands.some(({ command }) => command.kind === 'resetBaseline'), false);
  await rig.emitFor(deadlineCancellation, 'commandAcknowledged');
  await rig.emitFor(deadlineCancellation, 'commandCompleted');
  await rig.emitFor(deadlineCancellation, 'observationVerified');
  assert.equal(runner.snapshot().attemptNumber, 2);
  assert.ok(rig.commands.some(({ command }) => command.kind === 'resetBaseline'));
});

test('aborts retry deterministically when the bounded cleanup deadline fires', async () => {
  const { rig, runner } = fakeRig({ manualRetryCleanup: true });
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  await rig.failCurrentCue('force-retry-timeout');
  const deadline = rig.commands.find(({ command }) => command.kind === 'cleanupTimeout').command;

  await rig.emitFor(deadline, 'timerFired');
  assert.equal(runner.snapshot().state, 'aborted');
  assert.match(runner.snapshot().lastError, /cleanup-timeout/);
  assert.equal(rig.commands.some(({ command }) => command.kind === 'resetBaseline'), false);
});

test('fails a command whose port never settles when its executable deadline expires', async () => {
  const rig = fakeRig({
    dependencies: { operationTimeoutMs: 5, production: { execute: async () => {} } }
  });
  await rig.runner.startTake(input());
  await new Promise((resolve) => setTimeout(resolve, 20));
  await rig.runner.dispatch({ kind: 'flush' });
  assert.equal(rig.runner.snapshot().state, 'aborted');
  assert.match(rig.runner.snapshot().lastError, /operation-timeout/);
});

test('keeps failed-attempt dialogue out of the transcript eligible for acceptance', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  await rig.completeCue('rival_reveal');
  await rig.failCurrentCue('retry-after-second-cue');

  const retryAttemptId = runner.snapshot().attemptId;
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');
  await rig.completeCue('rival_reveal');
  await rig.completeCue('hero_reply');

  const snapshot = runner.snapshot();
  assert.deepEqual(snapshot.transcript.map((line) => line.cueId), ['rival_reveal', 'hero_reply']);
  assert.deepEqual([...new Set(snapshot.transcript.map((line) => line.attemptId))], [retryAttemptId]);
  assert.deepEqual(snapshot.discardedAttempts[0].transcript.map((line) => line.cueId), ['rival_reveal']);
});

test('emergency stop records revocation before issuing cancellation commands', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await reachFirstCue(rig, runner);

  await runner.emergencyStop('director stop');
  const snapshot = runner.snapshot();
  const revokeIndex = snapshot.history.findIndex((entry) => entry.kind === 'attempt-revoked');
  const cancelIndex = snapshot.history.findIndex((entry) => entry.kind === 'command-issued' && entry.action === 'cancel-attempt');

  assert.equal(snapshot.state, 'aborted');
  assert.ok(revokeIndex >= 0);
  assert.ok(cancelIndex > revokeIndex);
});

test('tracks emergency actor, timer, and capture cleanup through terminal quiescence', async () => {
  const { rig, runner } = fakeRig({ manualRetryCleanup: true });
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  await runner.emergencyStop('director stop');
  const cleanup = Object.values(runner.snapshot().pendingCommands);

  assert.equal(runner.snapshot().state, 'aborted');
  assert.equal(cleanup.filter((command) => command.action === 'cancel-attempt').length, 2);
  assert.equal(cleanup.filter((command) => command.action === 'cancel-timer').length, 1);
  assert.equal(cleanup.filter((command) => command.action === 'cancel-capture').length, 1);
  assert.deepEqual([...new Set(cleanup.map((command) => command.payload.reason))], ['abort']);

  for (const pending of cleanup) {
    const command = rig.commands.find(({ command }) => command.commandId === pending.commandId).command;
    await rig.emitFor(command, 'commandAcknowledged');
    await rig.emitFor(command, 'commandCompleted');
    await rig.emitFor(command, 'observationVerified');
  }
  assert.deepEqual(runner.snapshot().pendingCommands, {});
  assert.deepEqual(runner.snapshot().activeTimers, {});
  assert.equal(runner.snapshot().captureActive, false);
});

test('preserves timer and capture identity as unknown when terminal cancellation fails', async () => {
  const { rig, runner } = fakeRig({ manualRetryCleanup: true });
  rig.attach(runner);
  await reachFirstCue(rig, runner);
  const before = runner.snapshot();
  await runner.emergencyStop('cleanup-failure-audit');
  const timerCancellation = rig.commands.find(({ command }) => command.kind === 'cancelTimer').command;
  const captureCancellation = rig.commands.find(({ command }) => command.kind === 'cancelCapture').command;

  await rig.emitFor(timerCancellation, 'commandFailed', { reason: 'timer-cancel-failed' });
  let snapshot = runner.snapshot();
  assert.equal(snapshot.state, 'aborted');
  assert.equal(snapshot.activeTimers[before.cueTimeoutId].status, 'unknown');
  assert.equal(snapshot.activeTimers[before.cueTimeoutId].failure, 'timer-cancel-failed');

  await rig.emitFor(captureCancellation, 'commandFailed', { reason: 'capture-cancel-failed' });
  snapshot = runner.snapshot();
  assert.equal(snapshot.captureLifecycle.commandId, before.captureLifecycle.commandId);
  assert.equal(snapshot.captureLifecycle.status, 'unknown');
  assert.equal(snapshot.captureLifecycle.failure, 'capture-cancel-failed');
  assert.equal(snapshot.captureActive, true);
  assert.deepEqual(snapshot.cleanupFailures.map((failure) => failure.resourceId), [
    before.cueTimeoutId,
    before.captureLifecycle.commandId
  ]);
});

test('preserves unknown resource state when retry cleanup cancellation causes abort', async (t) => {
  for (const resource of ['timer', 'capture']) {
    await t.test(resource, async () => {
      const { rig, runner } = fakeRig({ manualRetryCleanup: true });
      rig.attach(runner);
      await reachFirstCue(rig, runner);
      const before = runner.snapshot();
      await rig.failCurrentCue('enter-retry-cleanup');
      const action = resource === 'timer' ? 'cancelTimer' : 'cancelCapture';
      const cancellation = rig.commands.find(({ command }) =>
        command.kind === action && command.payload.reason === 'retry').command;

      await rig.emitFor(cancellation, 'commandFailed', { reason: `${resource}-retry-cancel-failed` });
      const snapshot = runner.snapshot();
      assert.equal(snapshot.state, 'aborted');
      if (resource === 'timer') {
        assert.equal(snapshot.activeTimers[before.cueTimeoutId].status, 'unknown');
        assert.equal(snapshot.activeTimers[before.cueTimeoutId].failure, 'timer-retry-cancel-failed');
      } else {
        assert.equal(snapshot.captureLifecycle.commandId, before.captureLifecycle.commandId);
        assert.equal(snapshot.captureLifecycle.status, 'unknown');
        assert.equal(snapshot.captureLifecycle.failure, 'capture-retry-cancel-failed');
      }
    });
  }
});

test('only a completed take can become accepted', async () => {
  const early = fakeRig();
  early.rig.attach(early.runner);
  await early.runner.startTake(early.rig.input);
  await early.runner.dispatch({ kind: 'accept' });
  assert.notEqual(early.runner.snapshot().state, 'accepted');
  assert.equal(early.runner.snapshot().ignoredEvents.at(-1).reason, 'NOT_COMPLETED');

  const finished = fakeRig();
  finished.rig.attach(finished.runner);
  await reachFirstCue(finished.rig, finished.runner);
  await finished.rig.completeCue('rival_reveal');
  await finished.rig.completeCue('hero_reply');
  await finished.runner.dispatch({ kind: 'accept' });
  assert.equal(finished.runner.snapshot().state, 'accepted');
});

test('aborts on a reducer error while keeping later dispatch observable', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  await runner.startTake(rig.input);
  const hostile = new Proxy({}, { get() { throw new Error('hostile event'); } });

  await assert.rejects(runner.dispatch(hostile), /hostile event/);
  assert.equal(runner.snapshot().state, 'aborted');
  await assert.doesNotReject(runner.dispatch({ kind: 'accept' }));
  assert.equal(runner.snapshot().state, 'aborted');
});

test('keeps dispatch observable when validation fails before an attempt exists', async () => {
  const { rig, runner } = fakeRig();
  rig.attach(runner);

  await assert.rejects(runner.startTake({}), /validated take input/);
  assert.equal(runner.snapshot().state, 'aborted');
  await assert.doesNotReject(runner.dispatch({ kind: 'accept' }));
  assert.equal(runner.snapshot().ignoredEvents.at(-1).reason, 'NOT_COMPLETED');
});

test('snapshots validated input so caller mutation cannot change later marks or dialogue', async () => {
  const source = input();
  const { rig, runner } = fakeRig();
  rig.attach(runner);
  rig.input = source;
  await runner.startTake(source);

  source.episode.scene.marks.rival_start.dimension = 'minecraft:the_nether';
  source.approvedBank.variants[0].text = 'MUTATED LINE';
  source.selectedLines.rival_reveal.text = 'MUTATED LINE';
  await rig.ackCapture();
  await rig.completeMark('hero');
  await rig.completeMark('rival');

  const rivalMove = rig.commands.find(({ command }) =>
    command.kind === 'moveToMark' && command.target.actor === 'rival').command;
  const speech = rig.commands.find(({ command }) => command.kind === 'speak').command;
  assert.equal(rivalMove.payload.mark.dimension, 'minecraft:overworld');
  assert.equal(speech.payload.line, 'Your map is mine.');
});

test('rejects non-JSON take input before retaining any caller-owned data', async () => {
  const source = input();
  source.selectedLines.rival_reveal.metadata = new Map([['unsafe', true]]);
  const { rig, runner } = fakeRig();
  rig.attach(runner);

  await assert.rejects(runner.startTake(source), { code: 'EVENT_PAYLOAD_INVALID' });
  assert.equal(runner.snapshot().state, 'aborted');
  source.productionId = 'mutated-after-rejection';
  assert.equal(runner.snapshot().productionId, null);
});

test('replays one captured accepted external event sequence with identical state and effects', async () => {
  function replayRig() {
    let now = 100;
    const effects = [];
    const port = { execute(command) { effects.push(command); } };
    const dependencies = {
      actors: { hero: port, rival: port }, production: port, capture: port, timers: port,
      clock: { now: () => now++ },
      ids: {
        attempt: ({ takeId, number }) => `${takeId}:attempt:${number}`,
        command: ({ attemptId, number }) => `${attemptId}:command:${number}`
      },
      approvalPublicKey
    };
    return { runner: createShowrunner(dependencies), effects };
  }

  function normalizedEffects(effects) {
    return effects.map(({ eventId, monotonicTimestamp, ...command }) => structuredClone(command));
  }

  async function captureAcceptedSequence(runner, effects) {
    const events = [];
    let eventNumber = 0;
    const latest = (kind, predicate = () => true) =>
      [...effects].reverse().find((command) => command.kind === kind && predicate(command));
    const proof = (command) => {
      if (command.kind === 'prepareTake') {
        return { kind: 'preparation', authoritative: true, prepared: true, actors: command.payload.actors };
      }
      if (command.kind === 'armCapture') {
        return { kind: 'captureArm', authoritative: true, armed: true, takeId: command.takeId };
      }
      if (command.kind === 'moveToMark') {
        return {
          kind: 'mark', authoritative: true, actor: command.target.actor, markId: command.payload.markId,
          dimension: command.payload.mark.dimension, radius: true, facing: true, safeHeadroom: true,
          dwellTicks: command.payload.mark.dwellTicks
        };
      }
      if (command.kind === 'speak') {
        return {
          kind: 'speech', authoritative: true, observed: true, speaker: command.target.actor,
          cueId: command.cueId, text: command.payload.text
        };
      }
      if (command.kind === 'cancelTimer') {
        return {
          kind: 'quiescence', authoritative: true, quiescent: true,
          resourceKind: 'timer', resourceId: command.payload.timerId
        };
      }
      if (command.kind === 'stopCapture') {
        return {
          kind: 'capture', authoritative: true, ok: true, takeId: command.takeId,
          path: '/recordings/take-a.mkv',
          coverage: { complete: true, startMonotonicTimestamp: 1, endMonotonicTimestamp: 2 }
        };
      }
      throw new Error(`No replay proof fixture for ${command.kind}`);
    };
    const send = async (kind, payload, command) => {
      const snapshot = runner.snapshot();
      const identity = command ?? snapshot;
      const event = {
        kind,
        productionId: identity.productionId,
        takeId: identity.takeId,
        sceneId: identity.sceneId,
        beatId: identity.beatId,
        attemptId: identity.attemptId,
        cueId: identity.cueId,
        eventId: `captured-event-${++eventNumber}`,
        causalSequence: snapshot.causalSequence + 1,
        monotonicTimestamp: 1000 + eventNumber,
        payload
      };
      events.push(structuredClone(event));
      await runner.dispatch(event);
    };
    const barrier = async (command) => {
      await send('commandAcknowledged', { commandId: command.commandId }, command);
      await send('commandCompleted', { commandId: command.commandId }, command);
      await send('observationVerified', {
        commandId: command.commandId,
        proof: proof(command)
      }, command);
    };
    const schedule = async (command) => {
      await send('commandAcknowledged', { commandId: command.commandId }, command);
      await send('commandCompleted', { commandId: command.commandId }, command);
    };

    await runner.startTake(input());
    await barrier(latest('prepareTake'));
    await barrier(latest('armCapture'));
    await send('captureReady', { takeId: 'take-a', path: '/recordings/take-a.mkv' });
    const preRoll = latest('preRoll');
    await schedule(preRoll);
    await send('timerFired', { commandId: preRoll.commandId }, preRoll);
    await barrier(latest('moveToMark', (command) => command.target.actor === 'hero'));
    await barrier(latest('moveToMark', (command) => command.target.actor === 'rival'));

    for (const cueId of ['rival_reveal', 'hero_reply']) {
      await schedule(latest('cueTimeout', (command) => command.cueId === cueId));
      await barrier(latest('speak', (command) => command.cueId === cueId));
      await barrier(latest('cancelTimer', (command) => command.payload.reason === 'cue-complete'));
    }
    await barrier(latest('stopCapture'));
    const accept = { kind: 'accept' };
    events.push(accept);
    await runner.dispatch(accept);
    return events;
  }

  const capture = replayRig();
  const events = await captureAcceptedSequence(capture.runner, capture.effects);
  const first = replayRig();
  const second = replayRig();
  await first.runner.startTake(input());
  await second.runner.startTake(input());
  for (const event of events) {
    await first.runner.dispatch(structuredClone(event));
    await second.runner.dispatch(structuredClone(event));
  }

  assert.equal(first.runner.snapshot().state, 'accepted');
  assert.deepEqual(first.runner.snapshot(), second.runner.snapshot());
  assert.deepEqual(first.runner.snapshot(), capture.runner.snapshot());
  assert.deepEqual(normalizedEffects(first.effects), normalizedEffects(second.effects));
  assert.deepEqual(normalizedEffects(first.effects), normalizedEffects(capture.effects));
});
