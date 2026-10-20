import { createLiveMeadowGate } from './live-meadow-gate.mjs';
import { createShowrunner } from './state-machine.mjs';
import { createSurvivalCoordinator } from './survival-coordinator.mjs';
import { planSurvivalStep } from './survival-planner.mjs';

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function takeInput(episode, survivalEpisode, approvedBank) {
  const lines = episode.scene.cues.flatMap((cue) => cue.dialogue);
  return Object.freeze({
    productionId: 'first-day-meadow-live',
    takeId: `first-day-meadow-live-${Date.now()}`,
    episode,
    survivalEpisode,
    approvedBank,
    selectedLines: Object.fromEntries(lines.map((line) => [
      line.id, { id: `fixed:${line.id}`, text: line.fallbackLine }
    ]))
  });
}

export function createLiveMeadowHost({
  episode, survivalEpisode, approvedBank, approvalPublicKey, authority,
  actorHost, ports, preflight, clock = performance, operatorName = 'VPNAJ', settleLimit = 2_000,
  statusSink = () => {}
}) {
  if (!episode || !survivalEpisode || !approvedBank || !approvalPublicKey || !authority ||
      !actorHost || !ports || typeof preflight !== 'function') throw coded('LIVE_MEADOW_DEPENDENCY_REQUIRED');
  let state = 'created';
  let reason = null;
  let runner = null;
  let coordinator = null;
  let preflightResult = null;

  const report = (next, details = {}) => {
    state = next;
    statusSink(Object.freeze({ state: next, ...details }));
  };

  async function runTake() {
    report('running');
    const actors = actorHost.actors;
    coordinator = createSurvivalCoordinator({
      episode: survivalEpisode,
      planner: planSurvivalStep,
      authority,
      actors,
      emit: (event) => runner.dispatch(event),
      clock
    });
    runner = createShowrunner({
      actors,
      production: ports.production,
      timers: ports.timers,
      capture: ports.capture,
      survivalCoordinator: coordinator,
      approvalPublicKey,
      clock
    });
    await runner.startTake(takeInput(episode, survivalEpisode, approvedBank));
    const initial = runner.snapshot();
    await coordinator.start({
      productionId: initial.productionId,
      takeId: initial.takeId,
      sceneId: initial.sceneId,
      beatId: initial.beatId,
      attemptId: initial.attemptId,
      cueId: initial.cueId,
      causalSequence: initial.causalSequence
    });
    for (let iteration = 0; iteration < settleLimit; iteration += 1) {
      await runner.dispatch({ kind: 'flush' });
      await coordinator.flush();
      await new Promise((resolve) => setImmediate(resolve));
      const showrunner = runner.snapshot();
      const survival = coordinator.snapshot();
      if (showrunner.state === 'completed' && survival.status === 'completed') {
        report('completed', { lines: showrunner.transcript.length, goals: survival.completedGoalIds.length });
        return;
      }
      if (['aborted', 'failed'].includes(showrunner.state) || ['blocked', 'cancelled'].includes(survival.status)) {
        throw coded(showrunner.lastError ?? survival.lastError ?? 'LIVE_MEADOW_ABORTED');
      }
    }
    throw coded('LIVE_MEADOW_SETTLE_TIMEOUT');
  }

  const gate = createLiveMeadowGate({
    operatorName,
    isOnline: (name) => actorHost.onlinePlayers().includes(name),
    onBegin: runTake,
    onStop: async () => {
      if (runner) await runner.emergencyStop('OPERATOR_STOP');
      actorHost.close?.();
      reason = 'OPERATOR_STOP';
      report('aborted', { reason });
    }
  });

  async function abort(error) {
    if (['completed', 'aborted', 'closed'].includes(state)) return;
    reason = error?.code ?? error?.message ?? 'LIVE_MEADOW_ABORTED';
    if (runner) await runner.emergencyStop(reason);
    actorHost.close?.();
    report('aborted', { reason });
  }

  async function arm() {
    if (!actorHost.onlinePlayers().includes(operatorName)) return false;
    try {
      preflightResult = await preflight({ episode, survivalEpisode, actorHost });
    } catch (error) {
      if (error?.code === 'OPERATOR_OFFLINE') return false;
      throw error;
    }
    if (preflightResult?.ok !== true) throw coded(preflightResult?.code ?? 'LIVE_MEADOW_PREFLIGHT_FAILED');
    report('armed', { operatorName });
    return true;
  }

  return Object.freeze({
    async connect() {
      if (state !== 'created') throw coded('LIVE_MEADOW_ALREADY_CONNECTED');
      report('connecting');
      await actorHost.connect();
      if (!await arm()) report('waiting-operator', { operatorName });
      return preflightResult;
    },
    async handleChat(username, message) {
      if (state === 'waiting-operator' && username === operatorName && actorHost.onlinePlayers().includes(operatorName)) {
        await arm();
      }
      if (state !== 'armed' && state !== 'running') return false;
      try {
        return await gate.handleChat(username, message);
      } catch (error) {
        reason = error?.code ?? error?.message ?? 'LIVE_MEADOW_FAILED';
        report('aborted', { reason });
        throw error;
      }
    },
    status() {
      const showrunner = runner?.snapshot();
      const survival = coordinator?.snapshot();
      return Object.freeze({
        state,
        reason,
        preflight: preflightResult,
        transcript: showrunner?.transcript ?? [],
        completedGoalIds: survival?.completedGoalIds ?? []
      });
    },
    abort,
    close() {
      gate.close();
      actorHost.close?.();
      if (!['completed', 'aborted'].includes(state)) report('closed');
    }
  });
}
