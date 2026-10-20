import { createEnvelope, AttemptFence } from './protocol.mjs';
import { sourceEpisodeHash, verifyApprovedBank, verifyLineAuthorization } from './approved-bank.mjs';
import { validateEpisodeComposition } from './episode-composition.mjs';
import { selectRuntimeLine } from './policy.mjs';

const CALLBACK_EVENT = Symbol('showrunner-callback-event');
const REDUCER_ERROR = Symbol('showrunner-reducer-error');
const BARRIER_FIELDS = Object.freeze({
  commandAcknowledged: 'acknowledged',
  commandCompleted: 'completed',
  observationVerified: 'observed'
});
const TIMER_ACTIONS = new Set(['pre-roll', 'cue-timeout', 'cleanup-timeout']);
const QUIESCENCE_ACTIONS = new Set(['cancel-timer', 'cancel-attempt', 'cancel-capture']);
const COMMAND_KINDS = Object.freeze({
  'prepare-take': 'prepareTake',
  'capture-arm': 'armCapture',
  'move-to-mark': 'moveToMark',
  'pre-roll': 'preRoll',
  'cue-timeout': 'cueTimeout',
  'cleanup-timeout': 'cleanupTimeout',
  'cancel-attempt': 'cancel',
  'cancel-timer': 'cancelTimer',
  'cancel-capture': 'cancelCapture',
  'capture-stop': 'stopCapture',
  'reset-baseline': 'resetBaseline',
  speak: 'speak'
});

function initialState() {
  return {
    state: 'idle',
    productionId: null,
    takeId: null,
    sceneId: null,
    beatId: null,
    attemptId: null,
    failedAttemptId: null,
    attemptNumber: 0,
    maxAttempts: 0,
    cueId: null,
    cueIndex: 0,
    dialogueLineIndex: 0,
    causalSequence: 0,
    commandNumber: 0,
    speakerToken: null,
    preRollTimerId: null,
    cueTimeoutId: null,
    cueTimeoutSpeechCommandId: null,
    fallbackUsed: false,
    fallbackPending: false,
    activeTimers: {},
    cleanupTimerId: null,
    captureActive: false,
    captureLifecycle: { commandId: null, status: 'inactive', failure: null },
    completedSpeech: null,
    survivalGoals: {},
    survivalBeats: {},
    survivalHandshakes: [],
    survivalCancellations: [],
    survivalRebinds: [],
    marks: {},
    pendingCommands: {},
    transcript: [],
    discardedAttempts: [],
    cleanupFailures: [],
    history: [],
    ignoredEvents: [],
    lastError: null
  };
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function coded(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dialogueLines(cue) {
  return Array.isArray(cue?.dialogue) ? cue.dialogue : [cue];
}

function hasSurvivalBindings(episode) {
  return episode?.schemaVersion === 2 || (episode?.schemaVersion === 1 &&
    episode.scene?.cues?.some((cue) => cue.goalId !== undefined));
}

function currentDialogueLine(runtime, state) {
  const cue = runtime.input.episode.scene.cues[state.cueIndex];
  return dialogueLines(cue)[state.dialogueLineIndex];
}

function requireInput(input, runtime) {
  const cues = input?.episode?.scene?.cues;
  const actors = Object.keys(input?.episode?.actors ?? {});
  const actorBaselines = input?.episode?.set?.baselineManifest?.actorBaselines;
  if (![1, 2].includes(input?.episode?.schemaVersion) ||
      !nonemptyString(input?.productionId) || !nonemptyString(input?.takeId) ||
      !nonemptyString(input?.episode?.scene?.id) || !Array.isArray(cues) || cues.length === 0 ||
      !Number.isInteger(input?.episode?.retry?.wholeSceneAttempts) ||
      input.episode.retry.wholeSceneAttempts < 1 || actors.length !== 2 || !actorBaselines ||
      actors.some((actor) => !nonemptyString(actorBaselines[actor]?.mark) || !input.episode.scene.marks?.[actorBaselines[actor].mark]) ||
      !Array.isArray(input?.approvedBank?.variants)) {
    throw new TypeError('A validated take input and approved bank are required');
  }
  for (const cue of cues) {
    const schemaTwo = input.episode.schemaVersion === 2;
    const lines = dialogueLines(cue);
    const invalidLines = lines.length === 0 || lines.some((line) =>
      !nonemptyString(line?.id) || !nonemptyString(line?.speaker) || !nonemptyString(line?.mark) ||
      !nonemptyString(line?.fallbackLine) || !input.episode.scene.marks?.[line.mark] ||
      (schemaTwo && (line.cueId !== cue.id || !Array.isArray(line.approvedVariants))));
    if (!nonemptyString(cue?.id) || !Number.isFinite(cue?.timeoutSeconds) || cue.timeoutSeconds <= 0 || invalidLines ||
        (!schemaTwo && (cue.goalId !== undefined && !nonemptyString(cue.goalId))) ||
        (!schemaTwo && (cue.survivalBeatId !== undefined || cue.survivalGoalIds !== undefined || cue.dialogue !== undefined)) ||
        (schemaTwo && (cue.goalId !== undefined || !nonemptyString(cue.survivalBeatId) || cue.survivalBeatId !== cue.id ||
          !Array.isArray(cue.survivalGoalIds) || cue.survivalGoalIds.some((goalId) => !nonemptyString(goalId)) ||
          new Set(cue.survivalGoalIds).size !== cue.survivalGoalIds.length || !Array.isArray(cue.dialogue)))) {
      throw new TypeError('Take cues and marks must already be validated');
    }
  }
  if (hasSurvivalBindings(input.episode) || input.survivalEpisode !== undefined) {
    validateEpisodeComposition(input.episode, input.survivalEpisode);
  }
  const bankVerification = verifyApprovedBank(input.approvedBank, runtime.approvalPublicKey);
  if (bankVerification.ok !== true) throw coded(bankVerification.code);
  const episodeContentHash = sourceEpisodeHash(input.episode);
  if (bankVerification.bank.sourceEpisodeHash !== episodeContentHash) throw coded('APPROVED_BANK_EPISODE_MISMATCH');
  const authoredLines = cues.flatMap((cue) => dialogueLines(cue));
  runtime.authorizedLines = Object.fromEntries(authoredLines.map((line) => {
    const selected = input.selectedLines?.[line.id];
    const selectedId = typeof selected === 'string' ? selected : selected?.id;
    const authorized = selectRuntimeLine({
      cue: line,
      bank: bankVerification.bank,
      variantId: selectedId,
      approvalPublicKey: runtime.approvalPublicKey
    });
    if (authorized.ok !== true || (selected?.text !== undefined && selected.text !== authorized.text)) {
      throw coded(authorized.code ?? 'LINE_NOT_APPROVED', `Selected line for ${line.id} is not authorized`);
    }
    return [line.id, authorized];
  }));
  runtime.authorizedFallbacks = Object.fromEntries(authoredLines.map((line) => {
    const authorized = selectRuntimeLine({ cue: line, bank: bankVerification.bank, approvalPublicKey: runtime.approvalPublicKey });
    if (authorized.ok !== true) throw coded(authorized.code ?? 'LINE_NOT_APPROVED', `Fallback for ${line.id} is not authorized`);
    return [line.id, authorized];
  }));
  return input;
}

function snapshotInput(input, clock) {
  return createEnvelope('take-input-snapshot', {
    productionId: 'input-boundary',
    takeId: 'input-boundary',
    sceneId: 'input-boundary',
    beatId: 'input-boundary',
    attemptId: 'input-boundary',
    cueId: 'input-boundary',
    causalSequence: 1
  }, input, clock).payload;
}

function eventIdentity(state) {
  return {
    productionId: state.productionId,
    takeId: state.takeId,
    sceneId: state.sceneId,
    beatId: state.beatId,
    attemptId: state.attemptId,
    cueId: state.cueId
  };
}

function ignored(state, reason, event = {}) {
  state.ignoredEvents.push({
    reason,
    kind: typeof event.kind === 'string' ? event.kind : 'invalid',
    attemptId: typeof event.attemptId === 'string' ? event.attemptId : null,
    cueId: typeof event.cueId === 'string' ? event.cueId : null
  });
}

function transition(state, to, reason) {
  if (state.state !== to) {
    state.history.push({ kind: 'state-transition', from: state.state, to, reason });
    state.state = to;
  }
}

function actorIds(runtime) {
  return Object.keys(runtime.input?.episode?.actors ?? {}).sort();
}

function makeAttemptId(runtime, state, number) {
  return runtime.ids.attempt?.({
    productionId: state.productionId,
    takeId: state.takeId,
    number
  }) ?? `${state.takeId}:attempt:${number}`;
}

function makeCommand(runtime, state, { action, target, payload = {} }) {
  state.commandNumber += 1;
  const number = state.commandNumber;
  const commandId = runtime.ids.command?.({
    productionId: state.productionId,
    takeId: state.takeId,
    attemptId: state.attemptId,
    cueId: state.cueId,
    action,
    number
  }) ?? `${state.attemptId}:command:${number}`;
  const idempotencyKey = `${state.takeId}/${state.attemptId}/${state.cueId}/${action}/${number}`;
  const kind = COMMAND_KINDS[action];
  if (!kind) throw coded('COMMAND_KIND_INVALID', `Unknown runtime command: ${action}`);
  const envelope = createEnvelope(kind, {
    ...eventIdentity(state),
    causalSequence: number
  }, { commandId, idempotencyKey, target, payload }, runtime.clock);
  const timeoutMs = TIMER_ACTIONS.has(action)
    ? Math.max(runtime.operationTimeoutMs, Number(payload.timeoutSeconds ?? 0) * 1000 + runtime.operationTimeoutMs)
    : runtime.operationTimeoutMs;
  return Object.freeze({
    ...envelope,
    commandId,
    idempotencyKey,
    deadlineMonotonicTimestamp: envelope.monotonicTimestamp + timeoutMs,
    target: envelope.payload.target,
    payload: envelope.payload.payload
  });
}

function issue(runtime, state, commands, specification) {
  const command = makeCommand(runtime, state, specification);
  commands.push(command);
  state.history.push({
    kind: 'command-issued',
    action: specification.action,
    commandId: command.commandId,
    attemptId: command.attemptId,
    cueId: command.cueId
  });
  if (specification.track !== false) {
    state.pendingCommands[command.commandId] = {
      commandId: command.commandId,
      action: specification.action,
      target: command.target,
      payload: command.payload,
      acknowledged: false,
      completed: false,
      observed: false
    };
  }
  return command;
}

function beginFence(runtime, state) {
  const fence = AttemptFence.start(eventIdentity(state));
  state.causalSequence = 0;
  runtime.issuedEventSequence = 0;
  runtime.fence = fence;
}

function beginAttempt(runtime, state, commands, number, suppliedAttemptId) {
  state.attemptNumber = number;
  state.attemptId = suppliedAttemptId ?? makeAttemptId(runtime, state, number);
  state.failedAttemptId = null;
  state.cueIndex = 0;
  state.dialogueLineIndex = 0;
  state.cueId = runtime.input.episode.scene.cues[0].id;
  state.beatId = state.cueId;
  state.speakerToken = null;
  state.preRollTimerId = null;
  state.cueTimeoutId = null;
  state.cueTimeoutSpeechCommandId = null;
  state.fallbackUsed = false;
  state.fallbackPending = false;
  state.activeTimers = {};
  state.cleanupTimerId = null;
  state.captureActive = false;
  state.captureLifecycle = { commandId: null, status: 'inactive', failure: null };
  state.completedSpeech = null;
  state.survivalGoals = Object.fromEntries(runtime.input.episode.scene.cues
    .flatMap((cue) => [
      ...(nonemptyString(cue.goalId) ? [cue.goalId] : []),
      ...(Array.isArray(cue.survivalGoalIds) ? cue.survivalGoalIds : [])
    ])
    .map((goalId) => [goalId, { completed: false, safe: false, blocked: false }]));
  state.survivalBeats = Object.fromEntries(runtime.input.episode.scene.cues
    .filter((cue) => nonemptyString(cue.survivalBeatId))
    .map((cue) => [cue.survivalBeatId, {
      dialogueCompleted: false, completed: false, blocked: false, goalIds: cue.survivalGoalIds ?? []
    }]));
  state.survivalCancellations = [];
  state.survivalRebinds = [];
  state.marks = {};
  state.pendingCommands = {};
  beginFence(runtime, state);
  transition(state, 'preparing', `attempt-${number}-started`);
  issue(runtime, state, commands, {
    action: 'prepare-take',
    target: { port: 'production' },
    payload: { attemptNumber: number, actors: actorIds(runtime) }
  });
}

function selectedLine(runtime, authoredLine) {
  const line = runtime.authorizedLines?.[authoredLine.id];
  if (!line) throw coded('LINE_NOT_APPROVED', `No authorized line for ${authoredLine.id}`);
  return { variantId: line.id, text: line.text, fallback: line.fallback === true, authorization: line.authorization };
}

function issueCue(runtime, state, commands, { fallback = false } = {}) {
  const cue = runtime.input.episode.scene.cues[state.cueIndex];
  const authoredLine = currentDialogueLine(runtime, state);
  const line = fallback
    ? {
        variantId: runtime.authorizedFallbacks[authoredLine.id].id,
        text: runtime.authorizedFallbacks[authoredLine.id].text,
        fallback: true,
        authorization: runtime.authorizedFallbacks[authoredLine.id].authorization
      }
    : selectedLine(runtime, authoredLine);
  const speech = issue(runtime, state, commands, {
    action: 'speak',
    target: { port: 'actor', actor: authoredLine.speaker },
    payload: {
      text: line.text,
      line: line.text,
      ...(authoredLine.cueId === undefined ? {} : { authoredLineId: authoredLine.id }),
      variantId: line.variantId,
      fallback: line.fallback,
      authorization: line.authorization,
      episodeContentHash: runtime.input.approvedBank.sourceEpisodeHash
    }
  });
  state.speakerToken = {
    cueId: cue.id,
    authoredLineId: authoredLine.id,
    speaker: authoredLine.speaker,
    commandId: speech.commandId
  };
  state.fallbackUsed = line.fallback;
  const timeout = issue(runtime, state, commands, {
    action: 'cue-timeout',
    target: { port: 'timers' },
    payload: { speechCommandId: speech.commandId, timeoutSeconds: cue.timeoutSeconds }
  });
  state.cueTimeoutId = timeout.commandId;
  state.cueTimeoutSpeechCommandId = speech.commandId;
  state.activeTimers[timeout.commandId] = { action: 'cue-timeout', speechCommandId: speech.commandId, status: 'pending', failure: null };
}

function currentSurvivalGoal(runtime, state) {
  const goalId = runtime.input.episode.scene.cues[state.cueIndex]?.goalId;
  return nonemptyString(goalId) ? goalId : null;
}

function currentSurvivalBeat(runtime, state) {
  const beatId = runtime.input.episode.scene.cues[state.cueIndex]?.survivalBeatId;
  return nonemptyString(beatId) ? beatId : null;
}

function survivalBeatForGoal(state, goalId) {
  return Object.entries(state.survivalBeats).find(([, status]) => status.goalIds.includes(goalId));
}

function dialogueIsSafe(runtime, state) {
  const goalId = currentSurvivalGoal(runtime, state);
  return goalId === null || state.survivalGoals[goalId]?.safe === true;
}

function maybeIssueCue(runtime, state, commands) {
  const goalId = currentSurvivalGoal(runtime, state);
  if (state.state === 'running' && !state.speakerToken && !state.completedSpeech &&
    (goalId === null || state.survivalGoals[goalId]?.blocked !== true) && dialogueIsSafe(runtime, state)) {
    issueCue(runtime, state, commands);
  }
}

function applyCurrentSurvivalState(runtime, state, commands) {
  const goalId = currentSurvivalGoal(runtime, state);
  if (goalId === null) {
    maybeIssueCue(runtime, state, commands);
    return;
  }
  const status = state.survivalGoals[goalId];
  if (status?.blocked === true) {
    failAttempt(runtime, state, commands, status.reason);
    return;
  }
  if (state.completedSpeech && status?.completed === true) {
    advanceCompletedSpeech(runtime, state, commands);
    return;
  }
  maybeIssueCue(runtime, state, commands);
}

function issueMarks(runtime, state, commands) {
  for (const actor of actorIds(runtime)) {
    const markId = runtime.input.episode.set?.baselineManifest?.actorBaselines?.[actor]?.mark;
    const mark = runtime.input.episode.scene.marks[markId];
    if (!nonemptyString(markId) || !mark) throw coded('ACTOR_MARK_REQUIRED', `No baseline mark for ${actor}`);
    state.marks[actor] = { commandId: null, verified: false };
    const command = issue(runtime, state, commands, {
      action: 'move-to-mark',
      target: { port: 'actor', actor },
      payload: { markId, mark }
    });
    state.marks[actor].commandId = command.commandId;
  }
}

function revoke(runtime, state, reason) {
  if (runtime.fence && !runtime.fence.revoked) runtime.fence.revoke(reason);
  state.history.push({ kind: 'attempt-revoked', attemptId: state.attemptId, reason });
}

function cancellationCommands(runtime, state, commands, reason, cancelledAttemptId = state.attemptId) {
  if (!state.attemptId) return;
  for (const actor of actorIds(runtime)) {
    issue(runtime, state, commands, {
      action: 'cancel-attempt',
      target: { port: 'actor', actor },
      payload: { targetAttemptId: cancelledAttemptId, reason }
    });
  }
  for (const timerId of Object.keys(state.activeTimers)) {
    if (reason === 'abort' && state.activeTimers[timerId].status === 'unknown') continue;
    issue(runtime, state, commands, {
      action: 'cancel-timer',
      target: { port: 'timers' },
      payload: { timerId, attemptId: cancelledAttemptId, reason }
    });
    state.activeTimers[timerId].status = 'cancelling';
  }
  if (state.captureLifecycle.status !== 'inactive' && !(reason === 'abort' && state.captureLifecycle.status === 'unknown')) {
    issue(runtime, state, commands, {
      action: 'cancel-capture',
      target: { port: 'capture' },
      payload: { attemptId: cancelledAttemptId, captureCommandId: state.captureLifecycle.commandId, reason }
    });
    state.captureLifecycle.status = 'cancelling';
  }
}

function abortAttempt(runtime, state, commands, reason) {
  const cancelledAttemptId = state.attemptId;
  const survivalAttemptId = state.failedAttemptId ?? cancelledAttemptId;
  revoke(runtime, state, reason);
  state.speakerToken = null;
  state.completedSpeech = null;
  state.dialogueLineIndex = 0;
  clearPendingWatchdogs(runtime, state);
  state.pendingCommands = {};
  state.lastError = reason;
  transition(state, 'aborted', reason);
  if (cancelledAttemptId) {
    if (survivalAttemptId && !state.survivalCancellations.includes(survivalAttemptId)) {
      state.survivalCancellations.push(survivalAttemptId);
    }
    state.failedAttemptId = cancelledAttemptId;
    state.attemptId = `${cancelledAttemptId}:abort`;
    beginFence(runtime, state);
    cancellationCommands(runtime, state, commands, 'abort', cancelledAttemptId);
  }
}

function failAttempt(runtime, state, commands, reason) {
  if (state.attemptNumber >= state.maxAttempts) {
    abortAttempt(runtime, state, commands, reason);
    return;
  }
  const failedAttemptId = state.attemptId;
  const discardedTranscript = state.transcript.filter((line) => line.attemptId === failedAttemptId);
  if (discardedTranscript.length > 0) {
    state.discardedAttempts.push({ attemptId: failedAttemptId, reason, transcript: discardedTranscript });
    state.transcript = state.transcript.filter((line) => line.attemptId !== failedAttemptId);
  }
  revoke(runtime, state, reason);
  state.speakerToken = null;
  state.completedSpeech = null;
  state.dialogueLineIndex = 0;
  clearPendingWatchdogs(runtime, state);
  state.pendingCommands = {};
  transition(state, 'resetting', reason);
  if (failedAttemptId && !state.survivalCancellations.includes(failedAttemptId)) {
    state.survivalCancellations.push(failedAttemptId);
  }
  state.failedAttemptId = failedAttemptId;
  state.attemptId = `${failedAttemptId}:reset`;
  beginFence(runtime, state);
  cancellationCommands(runtime, state, commands, 'retry', failedAttemptId);
  const deadline = issue(runtime, state, commands, {
    action: 'cleanup-timeout',
    target: { port: 'timers' },
    payload: { timeoutSeconds: runtime.cleanupTimeoutSeconds }
  });
  state.cleanupTimerId = deadline.commandId;
  state.activeTimers[deadline.commandId] = { action: 'cleanup-timeout', status: 'pending', failure: null };
}

function switchCueFence(runtime, state) {
  state.cueId = runtime.input.episode.scene.cues[state.cueIndex].id;
  state.beatId = state.cueId;
  state.dialogueLineIndex = 0;
  beginFence(runtime, state);
}

function allBarrierFields(pending) {
  return pending.acknowledged && pending.completed && pending.observed;
}

function sameStrings(left, right) {
  return Array.isArray(left) && left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function verifiedProof(runtime, state, pending, event) {
  const proof = event.payload?.proof;
  if (!proof || proof.authoritative !== true) return { ok: false, reason: 'PROOF_NOT_AUTHORITATIVE' };
  if (pending.action === 'prepare-take') {
    return proof.kind === 'preparation' && proof.prepared === true && sameStrings(proof.actors, actorIds(runtime))
      ? { ok: true, proof }
      : { ok: false, reason: 'PREPARATION_PROOF_INVALID' };
  }
  if (pending.action === 'capture-arm') {
    return proof.kind === 'captureArm' && proof.armed === true && proof.takeId === state.takeId
      ? { ok: true, proof }
      : { ok: false, reason: 'CAPTURE_ARM_PROOF_INVALID' };
  }
  if (pending.action === 'move-to-mark') {
    const mark = pending.payload.mark;
    return proof.kind === 'mark' && proof.actor === pending.target.actor && proof.markId === pending.payload.markId &&
      proof.dimension === mark.dimension && proof.radius === true && proof.facing === true && proof.safeHeadroom === true &&
      Number.isInteger(proof.dwellTicks) && proof.dwellTicks >= mark.dwellTicks
      ? { ok: true, proof }
      : { ok: false, reason: 'MARK_PROOF_INVALID' };
  }
  if (pending.action === 'speak') {
    const authorization = verifyLineAuthorization(pending.payload.authorization, {
      publicKey: runtime.approvalPublicKey,
      episodeContentHash: pending.payload.episodeContentHash,
      cueId: state.cueId,
      authoredLineId: pending.payload.authoredLineId,
      speaker: pending.target.actor,
      text: pending.payload.text
    });
    return authorization.ok === true && proof.kind === 'speech' && proof.observed === true &&
      proof.speaker === pending.target.actor && proof.cueId === state.cueId && proof.text === pending.payload.text
      ? { ok: true, proof }
      : { ok: false, reason: 'SPEECH_PROOF_INVALID' };
  }
  if (pending.action === 'cancel-attempt') {
    return proof.kind === 'quiescence' && proof.quiescent === true && proof.targetAttemptId === pending.payload.targetAttemptId
      ? { ok: true, proof }
      : { ok: false, reason: 'QUIESCENCE_PROOF_INVALID' };
  }
  if (pending.action === 'cancel-timer') {
    return proof.kind === 'quiescence' && proof.quiescent === true && proof.resourceKind === 'timer' && proof.resourceId === pending.payload.timerId
      ? { ok: true, proof }
      : { ok: false, reason: 'QUIESCENCE_PROOF_INVALID' };
  }
  if (pending.action === 'cancel-capture') {
    return proof.kind === 'quiescence' && proof.quiescent === true && proof.resourceKind === 'capture' &&
      proof.resourceId === pending.payload.captureCommandId
      ? { ok: true, proof }
      : { ok: false, reason: 'QUIESCENCE_PROOF_INVALID' };
  }
  if (pending.action === 'capture-stop') {
    return proof.kind === 'capture' && proof.ok === true && proof.takeId === state.takeId && nonemptyString(proof.path) &&
      proof.coverage?.complete === true && Number.isFinite(proof.coverage.startMonotonicTimestamp) &&
      Number.isFinite(proof.coverage.endMonotonicTimestamp) && proof.coverage.startMonotonicTimestamp <= proof.coverage.endMonotonicTimestamp
      ? { ok: true, proof }
      : { ok: false, reason: 'CAPTURE_PROOF_INVALID' };
  }
  if (pending.action === 'reset-baseline') {
    const next = proof.nextAttempt;
    return proof.kind === 'reset' && proof.verified === true && nonemptyString(next?.id) &&
      next.id !== state.failedAttemptId && next.id !== state.attemptId &&
      Number.isInteger(next?.number) && next.number === state.attemptNumber + 1
      ? { ok: true, proof }
      : { ok: false, reason: 'RESET_PROOF_INVALID' };
  }
  return { ok: false, reason: 'PROOF_KIND_UNSUPPORTED' };
}

function advanceCompletedSpeech(runtime, state, commands) {
  const completed = state.completedSpeech;
  if (!completed) return;
  const cue = runtime.input.episode.scene.cues[state.cueIndex];
  const lines = dialogueLines(cue);
  if (completed.transcripts.length < lines.length) {
    state.dialogueLineIndex = completed.transcripts.length;
    state.fallbackUsed = false;
    issueCue(runtime, state, commands);
    return;
  }
  const goalId = currentSurvivalGoal(runtime, state);
  if (goalId !== null && state.survivalGoals[goalId]?.completed !== true) return;
  const survivalBeatId = currentSurvivalBeat(runtime, state);
  if (survivalBeatId !== null) {
    const beat = state.survivalBeats[survivalBeatId];
    if (beat?.dialogueCompleted !== true) {
      beat.dialogueCompleted = true;
      state.survivalHandshakes.push(createEnvelope('dialogueCompleted', {
        ...eventIdentity(state),
        causalSequence: state.causalSequence
      }, {
        beatId: survivalBeatId,
        proof: { authoritative: true, dialogueCompleted: true }
      }, runtime.clock));
    }
    if (beat?.completed !== true) return;
  }
  const completedIdentity = eventIdentity(state);
  const completedSequence = state.causalSequence;
  state.transcript.push(...completed.transcripts);
  state.completedSpeech = null;
  state.cueIndex += 1;
  if (state.cueIndex < runtime.input.episode.scene.cues.length) {
    switchCueFence(runtime, state);
    state.fallbackUsed = false;
    applyCurrentSurvivalState(runtime, state, commands);
  } else {
    const stop = issue(runtime, state, commands, {
      action: 'capture-stop',
      target: { port: 'capture' },
      payload: { reason: 'take-complete' }
    });
    state.captureLifecycle = { commandId: stop.commandId, status: 'stopping', failure: null };
  }
  if (goalId !== null) {
    state.survivalHandshakes.push(createEnvelope('dialogueCompleted', {
      ...completedIdentity,
      causalSequence: completedSequence + 1
    }, {
      goalId,
      nextIdentity: { ...eventIdentity(state), causalSequence: state.causalSequence },
      proof: { authoritative: true, dialogueCompleted: true }
    }, runtime.clock));
  }
}

function finishCleanup(runtime, state, commands) {
  if (state.state !== 'resetting') return;
  const cleanupActions = new Set(['cancel-attempt', 'cancel-timer', 'cancel-capture']);
  if ([...Object.values(state.pendingCommands)].some((candidate) => cleanupActions.has(candidate.action))) return;
  if (state.cleanupTimerId) {
    state.activeTimers[state.cleanupTimerId].status = 'cancelling';
    issue(runtime, state, commands, {
      action: 'cancel-timer',
      target: { port: 'timers' },
      payload: { timerId: state.cleanupTimerId, reason: 'cleanup-complete' }
    });
    return;
  }
  issue(runtime, state, commands, {
    action: 'reset-baseline',
    target: { port: 'production' },
    payload: { failedAttemptId: state.failedAttemptId }
  });
}

function finishPending(runtime, state, commands, pending) {
  clearWatchdog(runtime, pending.commandId);
  delete state.pendingCommands[pending.commandId];
  state.history.push({ kind: 'completion-barrier', action: pending.action, commandId: pending.commandId });

  if (pending.action === 'prepare-take') {
    const arm = issue(runtime, state, commands, {
      action: 'capture-arm', target: { port: 'capture' }, payload: { takeId: state.takeId }
    });
    state.captureActive = true;
    state.captureLifecycle = { commandId: arm.commandId, status: 'pending', failure: null };
    return;
  }

  if (pending.action === 'capture-arm') {
    state.captureActive = true;
    state.captureLifecycle.status = 'active';
    transition(state, 'awaiting_capture', 'capture-arm-verified');
    return;
  }

  if (pending.action === 'move-to-mark') {
    const actor = pending.target.actor;
    state.marks[actor].verified = true;
    if (Object.values(state.marks).every((mark) => mark.verified)) {
      transition(state, 'running', 'marks-verified');
      applyCurrentSurvivalState(runtime, state, commands);
    }
    return;
  }

  if (pending.action === 'speak') {
    const cue = runtime.input.episode.scene.cues[state.cueIndex];
    const authoredLine = currentDialogueLine(runtime, state);
    const transcripts = state.completedSpeech?.transcripts ?? [];
    state.completedSpeech = {
      commandId: pending.commandId,
      transcripts: [...transcripts, {
        attemptId: state.attemptId,
        cueId: cue.id,
        lineId: authoredLine.id,
        speaker: authoredLine.speaker,
        variantId: pending.payload.variantId,
        text: pending.payload.text,
        fallback: pending.payload.fallback
      }]
    };
    state.speakerToken = null;
    if (state.activeTimers[state.cueTimeoutId]) state.activeTimers[state.cueTimeoutId].status = 'cancelling';
    issue(runtime, state, commands, {
      action: 'cancel-timer',
      target: { port: 'timers' },
      payload: { timerId: state.cueTimeoutId, reason: 'cue-complete' }
    });
    return;
  }

  if (pending.action === 'pre-roll') {
    delete state.activeTimers[pending.commandId];
    state.preRollTimerId = null;
    issueMarks(runtime, state, commands);
    return;
  }

  if (pending.action === 'cue-timeout') {
    delete state.activeTimers[pending.commandId];
    state.cueTimeoutId = null;
    if (state.completedSpeech) return;
    if (state.speakerToken?.commandId !== state.cueTimeoutSpeechCommandId) return;
    failAttempt(runtime, state, commands, state.fallbackUsed ? 'cue-timeout-after-fallback' : 'cue-timeout');
    return;
  }

  if (pending.action === 'cleanup-timeout') {
    delete state.activeTimers[pending.commandId];
    state.cleanupTimerId = null;
    if (state.state === 'resetting') abortAttempt(runtime, state, commands, 'cleanup-timeout');
    return;
  }

  if (pending.action === 'cancel-timer') {
    clearWatchdog(runtime, pending.payload.timerId);
    delete state.pendingCommands[pending.payload.timerId];
    delete state.activeTimers[pending.payload.timerId];
    if (state.cueTimeoutId === pending.payload.timerId) {
      state.cueTimeoutId = null;
      state.cueTimeoutSpeechCommandId = null;
    }
    if (state.cleanupTimerId === pending.payload.timerId) state.cleanupTimerId = null;
    if (pending.payload.reason === 'cue-complete') advanceCompletedSpeech(runtime, state, commands);
    else finishCleanup(runtime, state, commands);
    return;
  }

  if (pending.action === 'capture-stop') {
    state.captureActive = false;
    state.captureLifecycle = { commandId: null, status: 'inactive', failure: null };
    transition(state, 'completed', 'capture-stop-verified');
    return;
  }

  if (pending.action === 'cancel-attempt') {
    finishCleanup(runtime, state, commands);
    return;
  }

  if (pending.action === 'cancel-capture') {
    state.captureActive = false;
    state.captureLifecycle = { commandId: null, status: 'inactive', failure: null };
    finishCleanup(runtime, state, commands);
    return;
  }

  if (pending.action === 'reset-baseline') {
    const nextAttempt = pending.proof?.nextAttempt;
    const previousAttemptId = state.failedAttemptId;
    beginAttempt(runtime, state, commands, nextAttempt.number, nextAttempt.id);
    state.survivalRebinds.push({
      previousAttemptId,
      nextIdentity: { ...eventIdentity(state), causalSequence: state.causalSequence },
      proof: { authoritative: true, cleanupVerified: true, resetVerified: true }
    });
  }
}

function processBarrierEvent(runtime, state, commands, event) {
  const pending = state.pendingCommands[event.payload?.commandId];
  if (!pending) {
    ignored(state, 'UNKNOWN_COMMAND', event);
    return;
  }
  const field = BARRIER_FIELDS[event.kind];
  if (field === 'observed') {
    if (TIMER_ACTIONS.has(pending.action)) {
      ignored(state, 'TIMER_FIRE_REQUIRED', event);
      return;
    }
    const verification = verifiedProof(runtime, state, pending, event);
    if (verification.ok !== true) {
      ignored(state, verification.reason, event);
      return;
    }
    pending.proof = verification.proof;
  }
  pending[field] = true;
  if (TIMER_ACTIONS.has(pending.action) && pending.acknowledged && pending.completed && state.activeTimers[pending.commandId]) {
    state.activeTimers[pending.commandId].status = 'armed';
  }
  if (allBarrierFields(pending)) finishPending(runtime, state, commands, pending);
}

function recordCleanupFailure(state, pending, reason) {
  let resourceId = pending.commandId;
  if (pending.action === 'cancel-timer') {
    resourceId = pending.payload.timerId;
    const timer = state.activeTimers[resourceId] ?? { action: 'unknown' };
    state.activeTimers[resourceId] = { ...timer, status: 'unknown', failure: reason };
  } else if (pending.action === 'cancel-capture') {
    resourceId = pending.payload.captureCommandId ?? state.captureLifecycle.commandId;
    state.captureActive = true;
    state.captureLifecycle = { ...state.captureLifecycle, commandId: resourceId, status: 'unknown', failure: reason };
  }
  state.cleanupFailures.push({ action: pending.action, commandId: pending.commandId, resourceId, reason });
  state.history.push({ kind: 'cleanup-failed', action: pending.action, commandId: pending.commandId, resourceId });
}

function reduceExternal(runtime, state, commands, event) {
  if (!runtime.fence) {
    ignored(state, 'NO_ACTIVE_ATTEMPT', event);
    return;
  }
  let payload;
  try {
    payload = createEnvelope('state-machine-payload-validation', {
      ...eventIdentity(state), causalSequence: 1
    }, event.payload ?? {}, runtime.clock).payload;
  } catch {
    ignored(state, 'INVALID_EVENT', event);
    return;
  }
  const decision = runtime.fence.accept(event);
  if (!decision.accepted) {
    ignored(state, decision.reason, event);
    return;
  }
  state.causalSequence = runtime.fence.sequence;
  runtime.issuedEventSequence = Math.max(runtime.issuedEventSequence, runtime.fence.sequence);
  runtime.fenceEventSequences.set(
    runtime.fence,
    Math.max(runtime.fenceEventSequences.get(runtime.fence) ?? 0, runtime.fence.sequence)
  );
  event = { ...event, payload };

  if (BARRIER_FIELDS[event.kind]) {
    processBarrierEvent(runtime, state, commands, event);
    return;
  }

  if (event.kind === 'commandFailed') {
    const pending = state.pendingCommands[event.payload?.commandId];
    if (!pending) {
      ignored(state, 'UNKNOWN_COMMAND', event);
      return;
    }
    clearWatchdog(runtime, pending.commandId);
    const failureReason = event.payload.reason ?? pending.action;
    if (QUIESCENCE_ACTIONS.has(pending.action)) recordCleanupFailure(state, pending, failureReason);
    if (state.state === 'aborted' && QUIESCENCE_ACTIONS.has(pending.action)) {
      delete state.pendingCommands[pending.commandId];
      state.lastError = `${state.lastError}; cleanup failed: ${failureReason}`;
      return;
    }
    if (pending.action === 'speak' || pending.action === 'cue-timeout') failAttempt(runtime, state, commands, event.payload.reason ?? 'cue-failed');
    else abortAttempt(runtime, state, commands, event.payload.reason ?? `${pending.action}-failed`);
    return;
  }

  if (['accepted', 'rejected', 'completed', 'aborted'].includes(state.state)) {
    ignored(state, 'TERMINAL_STATE', event);
    return;
  }

  if (event.kind === 'captureReady') {
    if (state.state !== 'awaiting_capture') {
      ignored(state, 'CAPTURE_NOT_EXPECTED', event);
      return;
    }
    if (event.payload.takeId !== state.takeId || !nonemptyString(event.payload.path)) {
      ignored(state, 'CAPTURE_TAKE_MISMATCH', event);
      return;
    }
    transition(state, 'pre_roll', 'capture-ready');
    const timer = issue(runtime, state, commands, {
      action: 'pre-roll', target: { port: 'timers' }, payload: { takeId: state.takeId }
    });
    state.preRollTimerId = timer.commandId;
    state.activeTimers[timer.commandId] = { action: 'pre-roll', status: 'pending', failure: null };
    return;
  }

  if (event.kind === 'timerFired') {
    const pending = state.pendingCommands[event.payload.commandId];
    if (pending && TIMER_ACTIONS.has(pending.action)) {
      pending.observed = true;
      if (allBarrierFields(pending)) finishPending(runtime, state, commands, pending);
      return;
    }
    ignored(state, 'STALE_TIMER', event);
    return;
  }

  if (event.kind === 'safeDialogueBoundary') {
    const goalId = event.payload?.goalId;
    const status = state.survivalGoals[goalId];
    if (!status) {
      ignored(state, 'SURVIVAL_GOAL_MISMATCH', event);
      return;
    }
    if (event.payload?.proof?.authoritative !== true || event.payload.proof.interruptible !== true) {
      ignored(state, 'DIALOGUE_BOUNDARY_PROOF_INVALID', event);
      return;
    }
    status.safe = true;
    if (currentSurvivalGoal(runtime, state) === goalId) applyCurrentSurvivalState(runtime, state, commands);
    return;
  }

  if (event.kind === 'beatCompleted') {
    const beatId = event.payload?.beatId;
    const status = state.survivalBeats[beatId];
    if (!status || currentSurvivalBeat(runtime, state) !== beatId) {
      ignored(state, 'SURVIVAL_BEAT_UNKNOWN', event);
      return;
    }
    if (!Array.isArray(event.payload?.goalIds) || event.payload.goalIds.some((goalId) => !nonemptyString(goalId)) ||
      event.payload?.proof?.authoritative !== true || event.payload.proof.completed !== true) {
      ignored(state, 'SURVIVAL_BEAT_COMPLETION_PROOF_INVALID', event);
      return;
    }
    if (status.dialogueCompleted !== true) {
      ignored(state, 'SURVIVAL_BEAT_DIALOGUE_PENDING', event);
      return;
    }
    if (!sameStrings(event.payload.goalIds, status.goalIds)) {
      ignored(state, 'SURVIVAL_BEAT_GOALS_MISMATCH', event);
      return;
    }
    if (status.goalIds.some((goalId) => state.survivalGoals[goalId]?.completed !== true)) {
      ignored(state, 'SURVIVAL_BEAT_GOALS_INCOMPLETE', event);
      return;
    }
    status.completed = true;
    advanceCompletedSpeech(runtime, state, commands);
    return;
  }

  if (event.kind === 'beatBlocked') {
    const beatId = event.payload?.beatId;
    const goalId = event.payload?.goalId;
    const status = state.survivalBeats[beatId];
    if (!status || currentSurvivalBeat(runtime, state) !== beatId) {
      ignored(state, 'SURVIVAL_BEAT_UNKNOWN', event);
      return;
    }
    if (status.dialogueCompleted !== true) {
      ignored(state, 'SURVIVAL_BEAT_DIALOGUE_PENDING', event);
      return;
    }
    if (!status.goalIds.includes(goalId)) {
      ignored(state, 'SURVIVAL_BEAT_GOALS_MISMATCH', event);
      return;
    }
    if (!Number.isSafeInteger(event.payload?.observationVersion) || event.payload.observationVersion < 0 ||
      !nonemptyString(event.payload?.reason) || event.payload?.proof?.authoritative !== true ||
      event.payload.proof.terminal !== true) {
      ignored(state, 'SURVIVAL_BEAT_BLOCKER_PROOF_INVALID', event);
      return;
    }
    status.blocked = true;
    status.reason = event.payload.reason;
    failAttempt(runtime, state, commands, status.reason);
    return;
  }

  if (event.kind === 'goalCompleted') {
    const goalId = event.payload?.goalId;
    const status = state.survivalGoals[goalId];
    if (!status) {
      ignored(state, 'SURVIVAL_GOAL_MISMATCH', event);
      return;
    }
    const beatEntry = survivalBeatForGoal(state, goalId);
    if (beatEntry) {
      const [beatId, beatStatus] = beatEntry;
      if (currentSurvivalBeat(runtime, state) !== beatId) {
        ignored(state, 'SURVIVAL_BEAT_GOALS_MISMATCH', event);
        return;
      }
      if (beatStatus.dialogueCompleted !== true) {
        ignored(state, 'SURVIVAL_BEAT_DIALOGUE_PENDING', event);
        return;
      }
    }
    if (!Number.isSafeInteger(event.payload?.observationVersion) || event.payload.observationVersion < 0 ||
      event.payload?.proof?.authoritative !== true || event.payload.proof.completionSatisfied !== true) {
      ignored(state, 'GOAL_COMPLETION_PROOF_INVALID', event);
      return;
    }
    status.completed = true;
    if (currentSurvivalGoal(runtime, state) === goalId) applyCurrentSurvivalState(runtime, state, commands);
    return;
  }

  if (event.kind === 'goalBlocked') {
    const goalId = event.payload?.goalId;
    const status = state.survivalGoals[goalId];
    if (!status) {
      ignored(state, 'SURVIVAL_GOAL_MISMATCH', event);
      return;
    }
    if (!nonemptyString(event.payload?.reason) || event.payload?.proof?.authoritative !== true || event.payload.proof.terminal !== true) {
      ignored(state, 'GOAL_BLOCKER_PROOF_INVALID', event);
      return;
    }
    status.blocked = true;
    status.reason = event.payload.reason;
    if (currentSurvivalGoal(runtime, state) === goalId) applyCurrentSurvivalState(runtime, state, commands);
    return;
  }

  ignored(state, 'UNEXPECTED_EVENT', event);
}

function reduceOne(runtime, current, suppliedEvent) {
  const state = structuredClone(current);
  const commands = [];

  if (suppliedEvent?.[REDUCER_ERROR]) {
    abortAttempt(runtime, state, commands, suppliedEvent.reason);
    return { state, commands };
  }

  if (suppliedEvent?.[CALLBACK_EVENT]) {
    reduceExternal(runtime, state, commands, suppliedEvent.event);
    return { state, commands };
  }

  const kind = suppliedEvent.kind;
  if (kind === 'flush') return { state, commands };

  if (kind === 'start-take') {
    if (state.state !== 'idle') throw new TypeError('A take can start only from idle');
    runtime.input = requireInput(snapshotInput(suppliedEvent.input, runtime.clock), runtime);
    state.productionId = runtime.input.productionId;
    state.takeId = runtime.input.takeId;
    state.sceneId = runtime.input.episode.scene.id;
    state.maxAttempts = runtime.input.episode.retry.wholeSceneAttempts;
    beginAttempt(runtime, state, commands, 1);
    return { state, commands };
  }

  if (kind === 'emergency-stop') {
    if (state.attemptId && !['accepted', 'rejected', 'aborted'].includes(state.state)) {
      abortAttempt(runtime, state, commands, suppliedEvent.reason ?? 'emergency-stop');
    }
    return { state, commands };
  }

  if (kind === 'accept') {
    if (state.state === 'completed') transition(state, 'accepted', 'creator-accepted');
    else ignored(state, 'NOT_COMPLETED', suppliedEvent);
    return { state, commands };
  }

  if (kind === 'reject') {
    if (state.state === 'completed') transition(state, 'rejected', 'creator-rejected');
    else ignored(state, 'NOT_COMPLETED', suppliedEvent);
    return { state, commands };
  }

  reduceExternal(runtime, state, commands, suppliedEvent);
  return { state, commands };
}

function resolvePort(dependencies, target) {
  if (target.port === 'actor') return dependencies.actors?.[target.actor];
  return dependencies[target.port];
}

function clearWatchdog(runtime, commandId) {
  const timer = runtime.watchdogs?.get(commandId);
  if (timer !== undefined) clearTimeout(timer);
  runtime.watchdogs?.delete(commandId);
}

function clearPendingWatchdogs(runtime, state) {
  for (const commandId of Object.keys(state.pendingCommands)) clearWatchdog(runtime, commandId);
}

/**
 * Creates the deterministic sole writer for one showrunner process.
 *
 * Ports receive immutable typed commands plus an enqueue callback. The callback
 * never changes state directly: it appends a fenced event to the same promise
 * queue used by public dispatch. If a reducer throws, that dispatch rejects,
 * the active attempt is revoked and aborted, and the internal queue recovers so
 * later dispatch calls remain observable.
 */
export function createShowrunner(dependencies = {}) {
  const runtime = {
    input: null,
    fence: null,
    clock: dependencies.clock ?? performance,
    ids: dependencies.ids ?? {},
    approvalPublicKey: dependencies.approvalPublicKey,
    authorizedLines: null,
    authorizedFallbacks: null,
    issuedEventSequence: 0,
    fenceEventSequences: new WeakMap(),
    watchdogs: new Map(),
    operationTimeoutMs: Number.isInteger(dependencies.operationTimeoutMs) && dependencies.operationTimeoutMs > 0
      ? dependencies.operationTimeoutMs
      : 10_000,
    cleanupTimeoutSeconds: Number.isFinite(dependencies.cleanupTimeoutSeconds) && dependencies.cleanupTimeoutSeconds > 0
      ? dependencies.cleanupTimeoutSeconds
      : 10,
    survivalCoordinator: typeof dependencies.survivalCoordinator?.handle === 'function'
      ? dependencies.survivalCoordinator
      : null
  };
  let state = initialState();
  let queue = Promise.resolve();

  const deliver = (command) => {
    const commandFence = runtime.fence;
    const port = resolvePort(dependencies, command.target);
    const sink = Object.freeze({
      createEvent(kind, payload = {}) {
        const allocated = runtime.fenceEventSequences.get(commandFence) ?? commandFence?.sequence ?? command.causalSequence;
        const nextSequence = allocated + 1;
        if (commandFence) runtime.fenceEventSequences.set(commandFence, nextSequence);
        if (commandFence === runtime.fence) runtime.issuedEventSequence = nextSequence;
        return createEnvelope(kind, {
          productionId: command.productionId,
          takeId: command.takeId,
          sceneId: command.sceneId,
          beatId: command.beatId,
          attemptId: command.attemptId,
          cueId: command.cueId,
          causalSequence: nextSequence
        }, payload, runtime.clock);
      },
      emit(event) {
        return dispatchInternal(event);
      }
    });
    let settled = false;
    const timeoutMs = Math.max(1, command.deadlineMonotonicTimestamp - runtime.clock.now());
    const timer = setTimeout(() => fail(coded('COMMAND_OPERATION_TIMEOUT', 'operation-timeout')), timeoutMs);
    timer.unref?.();
    runtime.watchdogs.set(command.commandId, timer);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearWatchdog(runtime, command.commandId);
      const event = sink.createEvent('commandFailed', {
        commandId: command.commandId,
        reason: error?.message ?? 'port-failed'
      });
      void sink.emit(event);
    };
    try {
      if (!port || typeof port.execute !== 'function') throw new TypeError(`Missing ${command.target.port} port`);
      Promise.resolve(port.execute(command, sink)).catch(fail);
    } catch (error) {
      fail(error);
    }
  };

  const enqueue = (event) => {
    const operation = queue.then(async () => {
      try {
        const result = reduceOne(runtime, state, event);
        state = result.state;
        if (runtime.survivalCoordinator && state.survivalCancellations.length > 0) {
          if (typeof runtime.survivalCoordinator.cancel !== 'function') {
            throw coded('SURVIVAL_COORDINATOR_CANCEL_REQUIRED');
          }
          const cancellations = [...new Set(state.survivalCancellations)];
          state.survivalCancellations = [];
          for (const attemptId of cancellations) await runtime.survivalCoordinator.cancel(attemptId);
        }
        for (const command of result.commands) deliver(command);
        if (runtime.survivalCoordinator && state.survivalRebinds.length > 0) {
          if (typeof runtime.survivalCoordinator.rebind !== 'function') {
            throw coded('SURVIVAL_COORDINATOR_REBIND_REQUIRED');
          }
          const rebinds = state.survivalRebinds;
          state.survivalRebinds = [];
          for (const request of rebinds) await runtime.survivalCoordinator.rebind(request);
        }
        if (runtime.survivalCoordinator && state.survivalHandshakes.length > 0) {
          const handshakes = state.survivalHandshakes;
          state.survivalHandshakes = [];
          for (const handshake of handshakes) {
            if (typeof runtime.survivalCoordinator.expectDialogue === 'function') {
              await runtime.survivalCoordinator.expectDialogue(handshake);
            }
            await runtime.survivalCoordinator.handle(handshake);
          }
        }
      } catch (error) {
        const reason = nonemptyString(error?.message) ? error.message : 'reducer-error';
        const recovery = reduceOne(runtime, state, { [REDUCER_ERROR]: true, reason });
        state = recovery.state;
        for (const command of recovery.commands) deliver(command);
        throw error;
      }
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  function dispatchInternal(event) {
    return enqueue({ [CALLBACK_EVENT]: true, event });
  }

  return Object.freeze({
    dispatch: (event) => enqueue(event),
    snapshot: () => structuredClone(state),
    startTake: (input) => enqueue({ kind: 'start-take', input }),
    emergencyStop: (reason) => enqueue({ kind: 'emergency-stop', reason })
  });
}
