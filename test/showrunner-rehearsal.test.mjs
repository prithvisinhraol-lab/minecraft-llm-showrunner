import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { verifyLineAuthorization } from '../src/showrunner/approved-bank.mjs';
import { selectRuntimeLine } from '../src/showrunner/policy.mjs';
import { approveCandidateBank, buildRehearsalRequest, rehearseCandidates } from '../src/showrunner/rehearsal.mjs';

const { privateKey: approvalPrivateKey, publicKey: approvalPublicKey } = generateKeyPairSync('ed25519');

const cue = Object.freeze({
  id: 'hero_reply', speaker: 'hero', requiredIntent: 'recover the map', fallbackLine: 'I will take it back.'
});

const episode = Object.freeze({
  schemaVersion: 1,
  episode: 'stolen_map',
  contentRating: 'family',
  actors: { hero: { profile: { forbiddenSubjects: [], maxLineWords: 18 } } },
  scene: { id: 'confrontation', dialoguePolicy: { maximumWordsPerLine: 18 }, cues: [cue] }
});

const profile = Object.freeze({
  actor: 'hero', relationship: 'rival claimant', voice: 'direct', vocabulary: 'plain heroic language',
  cadence: 'short confident sentences', humor: 'dry understatement', emotionalRange: ['determined'],
  sceneAttitude: 'resolute', preferredSubjects: ['maps'], positiveExamples: ['I will take it back.'],
  forbiddenSubjects: ['modern internet slang'], maxLineWords: 18,
  rehearsal: {
    provider: 'test-provider', model: 'test-model', runtimeUse: false,
    maxCandidates: 2, maxInputTokens: 400, maxOutputTokens: 20, timeoutSeconds: 1, maxRetries: 1
  } });

test('builds a bounded provider-neutral rehearsal request', () => {
  const request = buildRehearsalRequest({
    episode, cue, profile,
    budget: { maxCandidates: 9, maxInputTokens: 399, maxOutputTokens: 99, timeoutSeconds: 9, maxRetries: 9 }
  });

  assert.equal(request.provider, 'test-provider');
  assert.equal(request.model, 'test-model');
  assert.equal(request.maxCandidates, 2);
  assert.equal(request.maxInputTokens, 399);
  assert.equal(request.maxOutputTokens, 20);
  assert.equal(request.timeoutSeconds, 1);
  assert.equal(request.maxRetries, 1);
  assert.equal(request.promptTemplateVersion, 'showrunner-rehearsal-v2');
  assert.match(request.prompt, /recover the map/);
});

test('includes every authored character-style field in the rehearsal prompt', () => {
  const styledProfile = {
    ...profile,
    relationship: 'older sibling and reluctant ally',
    vocabulary: 'plain heroic language',
    cadence: 'short confident sentences',
    humor: 'dry understatement',
    emotionalRange: ['determined', 'guarded'],
    sceneAttitude: 'resolute but suspicious',
    preferredSubjects: ['maps', 'promises'],
    positiveExamples: ['I made a promise, and I keep those.'],
    forbiddenSubjects: ['modern internet slang'],
    maxLineWords: 18
  };
  const request = buildRehearsalRequest({ episode, cue, profile: styledProfile, budget: profile.rehearsal });

  for (const authoredValue of [
    styledProfile.relationship,
    styledProfile.vocabulary,
    styledProfile.cadence,
    styledProfile.humor,
    ...styledProfile.emotionalRange,
    styledProfile.sceneAttitude,
    ...styledProfile.preferredSubjects,
    ...styledProfile.positiveExamples
  ]) assert.match(request.prompt, new RegExp(authoredValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('bounds provider output, retries once, and records candidate provenance', async () => {
  let calls = 0;
  const request = buildRehearsalRequest({ episode, cue, profile, budget: profile.rehearsal });
  const provider = {
    async generateCandidates() {
      calls += 1;
      if (calls === 1) throw new Error('temporary provider failure');
      return { candidates: ['I will take it back.', 'The map returns to me.', 'overflow'], tokens: { input: 11, output: 7 } };
    }
  };

  const result = await rehearseCandidates({ request, provider, validate: (text) => ({ ok: text !== 'overflow', violations: [] }), score: () => ({ voice: 0.8 }) });

  assert.equal(calls, 2);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].hardValidation.ok, true);
  assert.deepEqual(result.candidates[0].softScores, { voice: 0.8 });
  assert.equal(result.provenance.promptHash.length, 64);
  assert.equal(result.provenance.provider, 'test-provider');
  assert.equal(result.provenance.tokens.output, 7);
  assert.equal(Number.isFinite(result.provenance.latencyMs), true);
});

test('rejects provider output that omits usage provenance', async () => {
  const request = buildRehearsalRequest({ episode, cue, profile, budget: profile.rehearsal });
  await assert.rejects(rehearseCandidates({
    request,
    provider: { async generateCandidates() { return { candidates: ['I will take it back.'] }; } }
  }), { code: 'REHEARSAL_PROVIDER_INVALID' });
});

test('aborts and cancels abandoned provider work when the deadline expires', async () => {
  const request = { ...buildRehearsalRequest({ episode, cue, profile, budget: profile.rehearsal }), timeoutSeconds: 0.001, maxRetries: 0 };
  let suppliedSignal;
  let cancelCalls = 0;
  const provider = {
    generateCandidates(_request, { signal }) {
      suppliedSignal = signal;
      return new Promise(() => {});
    },
    cancel() { cancelCalls += 1; }
  };

  await assert.rejects(rehearseCandidates({ request, provider }), { code: 'REHEARSAL_PROVIDER_INVALID' });
  assert.equal(suppliedSignal.aborted, true);
  assert.equal(cancelCalls, 1);
});

test('contains a synchronous provider cancellation failure inside the timeout path', async () => {
  const request = { ...buildRehearsalRequest({ episode, cue, profile, budget: profile.rehearsal }), timeoutSeconds: 0.001, maxRetries: 0 };
  await assert.rejects(rehearseCandidates({
    request,
    provider: {
      generateCandidates: () => new Promise(() => {}),
      cancel() { throw new Error('cancel failed synchronously'); }
    }
  }), { code: 'REHEARSAL_PROVIDER_INVALID' });
});

test('applies the episode and profile hard policy to default rehearsal validation', async () => {
  const request = buildRehearsalRequest({ episode, cue, profile, budget: profile.rehearsal });
  const result = await rehearseCandidates({
    request,
    provider: { async generateCandidates() { return { candidates: ['one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'], tokens: { input: 1, output: 1 } }; } }
  });

  assert.equal(result.candidates[0].hardValidation.ok, false);
  assert.equal(result.candidates[0].hardValidation.violations.at(-1).code, 'WORD_COUNT');
});

test('never makes more than one provider retry for a supplied request', async () => {
  let calls = 0;
  const request = { ...buildRehearsalRequest({ episode, cue, profile, budget: profile.rehearsal }), maxRetries: 9 };
  await assert.rejects(rehearseCandidates({
    request,
    provider: { async generateCandidates() { calls += 1; throw new Error('provider unavailable'); } }
  }));
  assert.equal(calls, 2);
});

test('approves only explicit creator decisions with stable unique variant IDs', () => {
  const candidates = [
    { id: 'candidate_1', cueId: 'hero_reply', speaker: 'hero', text: 'I will take it back.', hardValidation: { ok: true }, softScores: { voice: 0.8 } },
    { id: 'candidate_2', cueId: 'hero_reply', speaker: 'hero', text: 'The map returns to me.', hardValidation: { ok: true }, softScores: { voice: 0.7 } }
  ];
  const provenance = { sourceEpisode: episode, provider: 'test-provider', model: 'test-model', promptTemplateVersion: 'showrunner-rehearsal-v2', promptHash: 'a'.repeat(64), tokens: { input: 11, output: 7 }, latencyMs: 12 };
  const bank = approveCandidateBank({
    candidates,
    decisions: [
      { candidateId: 'candidate_1', approved: true, variantId: 'hero_reply_2', creator: 'Jay' },
      { candidateId: 'candidate_2', approved: false, creator: 'Jay' }
    ],
    provenance,
    creator: 'Jay',
    approvalPrivateKey
  });

  assert.equal(bank.schemaVersion, 2);
  assert.equal(bank.variants.length, 1);
  assert.equal(bank.variants[0].id, 'hero_reply_2');
  assert.equal(bank.variants[0].text, 'I will take it back.');
  assert.equal(bank.sourceEpisodeHash.length, 64);
  assert.equal(bank.provenance.sourceEpisodeHash, bank.sourceEpisodeHash);
  assert.equal(bank.signature.algorithm, 'Ed25519');
  assert.deepEqual(bank.variants[0].decision, { candidateId: 'candidate_1', approved: true, variantId: 'hero_reply_2', creator: 'Jay' });
  assert.equal(Object.isFrozen(bank), true);

  assert.throws(() => approveCandidateBank({
    candidates,
    decisions: [
      { candidateId: 'candidate_1', approved: true, variantId: 'same', creator: 'Jay' },
      { candidateId: 'candidate_2', approved: true, variantId: 'same', creator: 'Jay' }
    ],
    provenance,
    creator: 'Jay',
    approvalPrivateKey
  }), { code: 'DUPLICATE_VARIANT_ID' });
});

test('authorizes every line in one schema-v2 exchange independently under its visible cue', () => {
  const dialogue = [
    {
      id: 'arrival', cueId: 'arrival', speaker: 'hero', mark: 'hero_start',
      requiredIntent: 'start with wood', approvedVariants: ['Start with wood.'], fallbackLine: 'Start with wood.'
    },
    {
      id: 'arrival_energetic', cueId: 'arrival', speaker: 'rival', mark: 'rival_start',
      requiredIntent: 'concede the priority', approvedVariants: ['Wood is harder to regret.'], fallbackLine: 'Wood is harder to regret.'
    }
  ];
  const sourceEpisode = {
    ...episode,
    schemaVersion: 2,
    scene: {
      ...episode.scene,
      cues: [{
        id: 'arrival', survivalBeatId: 'arrival', survivalGoalIds: [], timeoutSeconds: 12, dialogue
      }]
    }
  };
  const candidates = dialogue.map((line) => ({
    id: `${line.id}_candidate`, cueId: line.cueId, authoredLineId: line.id, speaker: line.speaker,
    text: line.approvedVariants[0], hardValidation: { ok: true, violations: [] }, softScores: {}
  }));
  const bank = approveCandidateBank({
    candidates,
    decisions: dialogue.map((line) => ({
      candidateId: `${line.id}_candidate`, approved: true, variantId: `${line.id}_approved`, creator: 'Jay'
    })),
    provenance: {
      sourceEpisode, provider: 'test-provider', model: 'test-model', promptTemplateVersion: 'showrunner-rehearsal-v2',
      promptHash: 'b'.repeat(64), tokens: { input: 2, output: 2 }, latencyMs: 1
    },
    creator: 'Jay',
    approvalPrivateKey
  });

  assert.deepEqual(bank.fallbacks.map(({ id, cueId, speaker }) => ({ id, cueId, speaker })), [
    { id: 'fallback:arrival', cueId: 'arrival', speaker: 'hero' },
    { id: 'fallback:arrival_energetic', cueId: 'arrival', speaker: 'rival' }
  ]);
  for (const line of dialogue) {
    const selected = selectRuntimeLine({
      cue: line, bank, variantId: `${line.id}_approved`, approvalPublicKey
    });
    const fallback = selectRuntimeLine({ cue: line, bank, approvalPublicKey });
    assert.equal(selected.ok, true);
    assert.equal(fallback.ok, true);
    assert.equal(selected.authorization.authoredLineId, line.id);
    assert.equal(fallback.authorization.authoredLineId, line.id);
    assert.equal(verifyLineAuthorization(selected.authorization, {
      publicKey: approvalPublicKey,
      episodeContentHash: bank.sourceEpisodeHash,
      cueId: 'arrival',
      authoredLineId: line.id,
      speaker: line.speaker,
      text: line.approvedVariants[0]
    }).ok, true);
    assert.equal(verifyLineAuthorization(fallback.authorization, {
      publicKey: approvalPublicKey,
      episodeContentHash: bank.sourceEpisodeHash,
      cueId: 'arrival',
      authoredLineId: line.id,
      speaker: line.speaker,
      text: line.fallbackLine
    }).ok, true);
  }
});

test('rejects incomplete provenance and approval records', () => {
  const candidate = { id: 'candidate_1', cueId: 'hero_reply', speaker: 'hero', text: 'I will take it back.', hardValidation: { ok: true } };
  const decision = { candidateId: 'candidate_1', approved: true, variantId: 'hero_reply_1', creator: 'Jay' };
  assert.throws(() => approveCandidateBank({
    candidates: [candidate], decisions: [decision],
    provenance: { sourceEpisode: episode, provider: 'test-provider', promptTemplateVersion: 'v1', promptHash: 'a'.repeat(64), tokens: { input: 1, output: 1 }, latencyMs: 0 },
    creator: 'Jay', approvalPrivateKey
  }), { code: 'APPROVAL_PROVENANCE_INVALID' });
  assert.throws(() => approveCandidateBank({
    candidates: [candidate], decisions: [decision],
    provenance: { sourceEpisode: episode, provider: 'test-provider', model: 'test-model', promptTemplateVersion: 'v1', promptHash: 'not-a-hash', tokens: { input: 1, output: 1 }, latencyMs: 0 },
    creator: 'Jay', approvalPrivateKey
  }), { code: 'APPROVAL_PROVENANCE_INVALID' });
  assert.throws(() => approveCandidateBank({
    candidates: [candidate], decisions: [{ ...decision, creator: '' }],
    provenance: { sourceEpisode: episode, provider: 'test-provider', model: 'test-model', promptTemplateVersion: 'v1', promptHash: 'a'.repeat(64), tokens: { input: 1, output: 1 }, latencyMs: 0 },
    creator: 'Jay', approvalPrivateKey
  }), { code: 'CREATOR_DECISION_REQUIRED' });
});

test('fails closed when the creator-controlled private signing key is missing or invalid', () => {
  const candidate = { id: 'candidate_1', cueId: 'hero_reply', speaker: 'hero', text: 'I will take it back.', hardValidation: { ok: true } };
  const decision = { candidateId: 'candidate_1', approved: true, variantId: 'hero_reply_1', creator: 'Jay' };
  const fullProvenance = { sourceEpisode: episode, provider: 'test-provider', model: 'test-model', promptTemplateVersion: 'v1', promptHash: 'a'.repeat(64), tokens: { input: 1, output: 1 }, latencyMs: 0 };
  assert.throws(() => approveCandidateBank({ candidates: [candidate], decisions: [decision], provenance: fullProvenance, creator: 'Jay' }), { code: 'APPROVAL_PRIVATE_KEY_REQUIRED' });
  assert.throws(() => approveCandidateBank({ candidates: [candidate], decisions: [decision], provenance: fullProvenance, creator: 'Jay', approvalPrivateKey: 'not-a-key' }), { code: 'APPROVAL_PRIVATE_KEY_REQUIRED' });
});

test('requires every approved candidate to have an explicit creator decision', () => {
  assert.throws(() => approveCandidateBank({
    candidates: [{ id: 'candidate_1', cueId: 'hero_reply', speaker: 'hero', text: 'I will take it back.', hardValidation: { ok: true } }],
    decisions: [],
    provenance: { sourceEpisode: episode }
  }), { code: 'CREATOR_DECISION_REQUIRED' });
});
