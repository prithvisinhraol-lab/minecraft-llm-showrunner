import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { createFixedLineBank } from '../src/showrunner/fixed-line-bank.mjs';
import { createLiveMeadowHost } from '../src/showrunner/live-meadow-host.mjs';
import { createLiveTestPorts } from '../src/showrunner/live-test-ports.mjs';
import { createSurvivalAuthority } from '../src/showrunner/survival-authority.mjs';
import { loadEpisode } from '../src/showrunner/schema.mjs';
import { loadSurvivalEpisode } from '../src/showrunner/survival-schema.mjs';

const showrunnerPath = path.resolve('production/episodes/first-day-meadow.yaml');
const survivalPath = path.resolve('production/episodes/first-day-meadow.survival.yaml');

function completeObservation(actor, goalId, version) {
  const inventory = () => ({ oak_log: 3, oak_planks: 12, stick: 4, crafting_table: 1, wooden_pickaxe: 1, cobblestone: 11 });
  return {
    authoritative: true, actor, goalId, observationVersion: version,
    dimension: 'minecraft:overworld', inventory: inventory(), equipment: { hand: 'wooden_pickaxe' },
    nearMark: 'crafting_table',
    actors: {
      hero: { inventory: inventory(), atMark: 'crafting_table', equipped: { hand: 'wooden_pickaxe' } },
      rival: { inventory: inventory(), atMark: 'crafting_table', equipped: { hand: 'wooden_pickaxe' } }
    },
    targets: [], drops: [], placedAtMarks: { crafting_table: 'crafting_table' }
  };
}

function actorRuntime(actor, commands) {
  return {
    async execute(command, sink) {
      commands.push(structuredClone(command));
      const emit = async (kind, payload = {}) => sink.emit(sink.createEvent(kind, {
        commandId: command.commandId, ...payload
      }));
      await emit('commandAcknowledged');
      await emit('commandCompleted');
      let proof;
      if (command.kind === 'moveToMark') {
        proof = {
          kind: 'mark', authoritative: true, actor, markId: command.payload.markId,
          dimension: command.payload.mark.dimension, radius: true, facing: true,
          safeHeadroom: true, dwellTicks: command.payload.mark.dwellTicks
        };
      } else if (command.kind === 'speak') {
        proof = { kind: 'speech', authoritative: true, observed: true, speaker: actor, cueId: command.cueId, text: command.payload.text };
      } else if (command.kind === 'observeSurvival') {
        const version = command.payload.observationVersion + 1;
        proof = {
          kind: 'observeSurvival', authoritative: true, actor, goalId: command.payload.goalId,
          observationVersion: version, before: null,
          after: completeObservation(actor, command.payload.goalId, version)
        };
      } else if (command.kind === 'cancel') {
        proof = { kind: 'quiescence', authoritative: true, quiescent: true, targetAttemptId: command.payload.targetAttemptId };
      } else {
        throw new Error(`unexpected command ${command.kind}`);
      }
      await emit('observationVerified', { proof });
    },
    async cancel(attemptId) {
      return { authoritative: true, acknowledged: true, cancelled: true, actor, targetAttemptId: attemptId };
    },
    async awaitQuiescence() { return { authoritative: true, acknowledged: true, quiescent: true, actor }; },
    close() {}
  };
}

async function fixture({ operatorOnline = true, preflight } = {}) {
  const episode = await loadEpisode(showrunnerPath);
  const survivalEpisode = await loadSurvivalEpisode(survivalPath);
  const approvalKeys = generateKeyPairSync('ed25519');
  const authorityKeys = generateKeyPairSync('ed25519');
  const commands = [];
  const actors = { hero: actorRuntime('hero', commands), rival: actorRuntime('rival', commands) };
  let online = operatorOnline;
  const actorHost = {
    actors,
    onlinePlayers: () => online ? ['VPNAJ'] : [],
    async connect() {},
    close() {},
    setOperatorOnline(value) { online = value; }
  };
  const clock = { now: (() => { let now = 100; return () => now++; })() };
  const host = createLiveMeadowHost({
    episode, survivalEpisode, actorHost,
    approvedBank: createFixedLineBank(episode, approvalKeys.privateKey),
    approvalPublicKey: approvalKeys.publicKey,
    authority: createSurvivalAuthority({ clock, signingKey: authorityKeys.privateKey }),
    ports: createLiveTestPorts({ actorNames: ['hero', 'rival'], clock }),
    clock,
    preflight: preflight ?? (async () => ({ ok: true, marks: episode.scene.marks })),
    settleLimit: 500
  });
  return { host, commands, episode, survivalEpisode, actorHost };
}

test('connect is idle and operator begin runs every fixed line and all Survival goals once', async () => {
  const { host, commands, episode, survivalEpisode } = await fixture();
  await host.connect();
  assert.equal(commands.length, 0);
  assert.equal(host.status().state, 'armed');

  assert.equal(await host.handleChat('Visitor', 'begin'), false);
  assert.equal(commands.length, 0);
  assert.equal(await host.handleChat('VPNAJ', 'begin'), true);

  const status = host.status();
  const expectedLines = episode.scene.cues.flatMap((cue) => cue.dialogue.map((line) => line.fallbackLine));
  assert.equal(status.state, 'completed');
  assert.deepEqual(status.transcript.map(({ text }) => text), expectedLines);
  assert.deepEqual(status.completedGoalIds, survivalEpisode.goals.map(({ id }) => id));
  assert.deepEqual(commands.filter(({ kind }) => kind === 'speak').map(({ payload }) => payload.text), expectedLines);
  assert.equal(await host.handleChat('VPNAJ', 'begin'), false);
  assert.equal(commands.filter(({ kind }) => kind === 'speak').length, 12);
});

test('operator stop closes an armed host without launching a take', async () => {
  const { host, commands } = await fixture();
  await host.connect();
  assert.equal(await host.handleChat('VPNAJ', 'stop'), true);
  assert.equal(host.status().state, 'aborted');
  assert.equal(host.status().reason, 'OPERATOR_STOP');
  assert.equal(commands.length, 0);
});

test('actor failure aborts an armed host without launching a take', async () => {
  const { host, commands } = await fixture();
  await host.connect();
  await host.abort(Object.assign(new Error('lost'), { code: 'LIVE_ACTOR_DISCONNECTED' }));
  assert.equal(host.status().state, 'aborted');
  assert.equal(host.status().reason, 'LIVE_ACTOR_DISCONNECTED');
  assert.equal(commands.length, 0);
});

test('waits silently for the operator and arms before accepting their first begin', async () => {
  const { host, actorHost, commands } = await fixture({ operatorOnline: false });
  await host.connect();
  assert.equal(host.status().state, 'waiting-operator');
  assert.equal(commands.length, 0);
  actorHost.setOperatorOnline(true);
  assert.equal(await host.handleChat('VPNAJ', 'begin'), true);
  assert.equal(host.status().state, 'completed');
  assert.equal(commands.filter(({ kind }) => kind === 'speak').length, 12);
});

test('waits when the operator name arrives before their live entity', async () => {
  let attempts = 0;
  const { host, commands } = await fixture({
    preflight: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('OPERATOR_OFFLINE'), { code: 'OPERATOR_OFFLINE' });
      return { ok: true };
    }
  });
  await host.connect();
  assert.equal(host.status().state, 'waiting-operator');
  assert.equal(commands.length, 0);
  assert.equal(await host.handleChat('VPNAJ', 'begin'), true);
  assert.equal(host.status().state, 'completed');
});
