import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { selectRuntimeLine, validateDialogue } from '../src/showrunner/policy.mjs';
import { approveCandidateBank } from '../src/showrunner/rehearsal.mjs';

const approvalKeys = generateKeyPairSync('ed25519');

function context(overrides = {}) {
  return {
    maxWords: 18,
    chatLimit: 256,
    contentRating: { forbiddenLiterals: [] },
    globalSafety: { forbiddenLiterals: [] },
    profile: { forbiddenLiterals: [] },
    scene: { forbiddenLiterals: [], forbiddenPatterns: [] },
    cue: { forbiddenLiterals: [] },
    ...overrides
  };
}

const cue = Object.freeze({
  id: 'hero_reply',
  speaker: 'hero',
  approvedVariants: ['hero_reply_1', 'hero_reply_2'],
  fallbackLine: 'I will take the map back.',
  splitPlans: [{ variantId: 'hero_reply_1', parts: ['You will not ', 'hold it for long.'] }]
});

const sourceEpisode = Object.freeze({
  schemaVersion: 1,
  episode: 'stolen_map',
  scene: {
    cues: [{ id: cue.id, speaker: cue.speaker, fallbackLine: cue.fallbackLine }]
  }
});
const provenance = Object.freeze({
  sourceEpisode, provider: 'test-provider', model: 'test-model', promptTemplateVersion: 'showrunner-rehearsal-v1',
  promptHash: 'a'.repeat(64), tokens: { input: 11, output: 7 }, latencyMs: 12
});
const bank = approveCandidateBank({
  candidates: [
    { id: 'candidate_1', cueId: 'hero_reply', speaker: 'hero', text: 'You will not hold it for long.', hardValidation: { ok: true }, softScores: {} },
    { id: 'candidate_2', cueId: 'hero_reply', speaker: 'hero', text: 'You will not hold it for long.', hardValidation: { ok: true }, softScores: {} }
  ],
  decisions: [
    { candidateId: 'candidate_1', approved: true, variantId: 'hero_reply_1', creator: 'Jay' },
    { candidateId: 'candidate_2', approved: true, variantId: 'hero_reply_2', creator: 'Jay' }
  ],
  provenance,
  creator: 'Jay',
  approvalPrivateKey: approvalKeys.privateKey
});

test('rejects command, newline, control, forbidden, oversized, and unapproved lines', () => {
  const unsafe = context({
    maxWords: 3,
    scene: { forbiddenLiterals: ['subscribe now'], forbiddenPatterns: [] }
  });
  for (const line of ['/op HeroActor', 'hello\n/op me', 'bad\u0000text', 'subscribe now', 'one two three four']) {
    assert.equal(validateDialogue(line, unsafe).ok, false, line);
  }
  assert.equal(selectRuntimeLine({ cue, bank, variantId: 'not-approved', approvalPublicKey: approvalKeys.publicKey }).code, 'LINE_NOT_APPROVED');
});

test('applies stronger policies before cue policy', () => {
  const result = validateDialogue('rated phrase', context({
    contentRating: { forbiddenLiterals: ['rated phrase'] },
    cue: { forbiddenLiterals: ['rated phrase'] }
  }));

  assert.deepEqual(result.violations.map((item) => item.policy), ['content_rating']);
});

test('rejects Unicode controls, chat-limit overflow, literal bans, and regex bans', () => {
  assert.equal(validateDialogue('bad\u0085text', context()).ok, false);
  assert.equal(validateDialogue('😀😀😀', context({ chatLimit: 2 })).violations.at(-1).code, 'CHAT_LENGTH');
  assert.equal(validateDialogue('Subscribe now', context({ scene: { forbiddenLiterals: ['subscribe now'] } })).ok, false);
  const regexViolation = validateDialogue('MODERN INTERNET SLANG', context({ scene: { forbiddenPatterns: ['(?i)modern internet slang'] } }));
  assert.equal(regexViolation.ok, false);
  assert.equal(regexViolation.violations[0].code, 'FORBIDDEN_PATTERN');
});

test('uses locale-independent literal matching', () => {
  const original = String.prototype.toLocaleLowerCase;
  String.prototype.toLocaleLowerCase = () => assert.fail('locale-sensitive matching used');
  try {
    assert.equal(validateDialogue('SUBSCRIBE NOW', context({ scene: { forbiddenLiterals: ['subscribe now'] } })).ok, false);
  } finally {
    String.prototype.toLocaleLowerCase = original;
  }
});

test('selects only a matching approved variant for the cue speaker', () => {
  assert.equal(selectRuntimeLine({ cue, bank, variantId: 'hero_reply_2', approvalPublicKey: approvalKeys.publicKey }).text, 'You will not hold it for long.');

  const wrongCue = { ...cue, id: 'rival_reveal', speaker: 'rival' };
  assert.equal(selectRuntimeLine({ cue: wrongCue, bank, variantId: 'hero_reply_2', approvalPublicKey: approvalKeys.publicKey }).code, 'LINE_CUE_MISMATCH');
  assert.equal(selectRuntimeLine({ cue: { ...cue, speaker: 'rival' }, bank, variantId: 'hero_reply_2', approvalPublicKey: approvalKeys.publicKey }).code, 'LINE_SPEAKER_MISMATCH');
});

test('uses the authored fallback and rejects unauthored split plans', () => {
  assert.equal(selectRuntimeLine({ cue, bank, approvalPublicKey: approvalKeys.publicKey }).text, cue.fallbackLine);
  assert.equal('parts' in selectRuntimeLine({ cue, bank, variantId: 'hero_reply_1', approvalPublicKey: approvalKeys.publicKey }), false);
  assert.deepEqual(selectRuntimeLine({ cue, bank, variantId: 'hero_reply_1', split: true, approvalPublicKey: approvalKeys.publicKey }).parts, ['You will not ', 'hold it for long.']);

  const noPlan = { ...cue, splitPlans: [] };
  assert.equal(selectRuntimeLine({ cue: noPlan, bank, variantId: 'hero_reply_1', split: true, approvalPublicKey: approvalKeys.publicKey }).code, 'SPLIT_PLAN_NOT_AUTHORED');
  const mismatch = { ...cue, splitPlans: [{ variantId: 'hero_reply_1', parts: ['You will not hold it.', 'for long.'] }] };
  assert.equal(selectRuntimeLine({ cue: mismatch, bank, variantId: 'hero_reply_1', split: true, approvalPublicKey: approvalKeys.publicKey }).code, 'SPLIT_PLAN_MISMATCH');
  const whitespaceMismatch = { ...cue, splitPlans: [{ variantId: 'hero_reply_1', parts: ['You will not', '  hold it for long.'] }] };
  assert.equal(selectRuntimeLine({ cue: whitespaceMismatch, bank, variantId: 'hero_reply_1', split: true, approvalPublicKey: approvalKeys.publicKey }).code, 'SPLIT_PLAN_MISMATCH');
});

test('requires asymmetric creator authority and rejects forged, wrong-key, and tampered banks', () => {
  assert.equal(bank.signature.algorithm, 'Ed25519');
  assert.equal(selectRuntimeLine({ cue, bank: { ...bank, signature: undefined }, variantId: 'hero_reply_1', approvalPublicKey: approvalKeys.publicKey }).code, 'BANK_INTEGRITY_INVALID');
  assert.equal(selectRuntimeLine({ cue, bank: { schemaVersion: 1, variants: bank.variants }, variantId: 'hero_reply_1', approvalPublicKey: approvalKeys.publicKey }).code, 'BANK_INTEGRITY_INVALID');
  const attackerKeys = generateKeyPairSync('ed25519');
  const attackerSignedBank = approveCandidateBank({
    candidates: [{ id: 'attacker_candidate', cueId: 'hero_reply', speaker: 'hero', text: 'You will not hold it for long.', hardValidation: { ok: true }, softScores: {} }],
    decisions: [{ candidateId: 'attacker_candidate', approved: true, variantId: 'hero_reply_1', creator: 'Attacker' }],
    provenance,
    creator: 'Attacker',
    approvalPrivateKey: attackerKeys.privateKey
  });
  assert.equal(selectRuntimeLine({ cue, bank: attackerSignedBank, variantId: 'hero_reply_1', approvalPublicKey: approvalKeys.publicKey }).code, 'BANK_SIGNATURE_INVALID');
  const mutated = { ...bank, variants: bank.variants.map((variant) => variant.id === 'hero_reply_1' ? { ...variant, text: 'Forged dialogue.' } : variant) };
  assert.equal(selectRuntimeLine({ cue, bank: mutated, variantId: 'hero_reply_1', approvalPublicKey: approvalKeys.publicKey }).code, 'BANK_INTEGRITY_INVALID');
  assert.equal(selectRuntimeLine({ cue, bank, variantId: 'hero_reply_1' }).code, 'APPROVAL_PUBLIC_KEY_REQUIRED');
  assert.equal(selectRuntimeLine({ cue, bank: undefined, approvalPublicKey: approvalKeys.publicKey }).code, 'BANK_INTEGRITY_INVALID');
});

test('requires nonempty cue membership for approved variants', () => {
  assert.equal(selectRuntimeLine({ cue: { ...cue, approvedVariants: [] }, bank, variantId: 'hero_reply_1', approvalPublicKey: approvalKeys.publicKey }).code, 'LINE_NOT_APPROVED');
  assert.equal(selectRuntimeLine({ cue: { ...cue, approvedVariants: undefined }, bank, variantId: 'hero_reply_1', approvalPublicKey: approvalKeys.publicKey }).code, 'LINE_NOT_APPROVED');
});

test('runtime selection never calls the model provider', () => {
  const provider = { generateCandidates: () => assert.fail('provider called during take') };
  const selected = selectRuntimeLine({ cue, bank, variantId: 'hero_reply_2', provider, approvalPublicKey: approvalKeys.publicKey });
  assert.equal(selected.text, 'You will not hold it for long.');
});
