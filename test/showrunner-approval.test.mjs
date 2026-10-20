import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  sourceEpisodeHash,
  verifyApprovedBank,
  verifyLineAuthorization
} from '../src/showrunner/approved-bank.mjs';
import { approveCandidateBank } from '../src/showrunner/rehearsal.mjs';
import { selectRuntimeLine } from '../src/showrunner/policy.mjs';
import { createShowrunner } from '../src/showrunner/state-machine.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function episode(sourceRoot = '/checkout-a') {
  return {
    schemaVersion: 1,
    episode: 'stolen_map',
    sourcePath: `${sourceRoot}/production/episodes/stolen-map.yaml`,
    actors: {
      hero: {
        profilePath: `${sourceRoot}/production/profiles/hero.yaml`,
        profile: { actor: 'hero', sourcePath: `${sourceRoot}/production/profiles/hero.yaml` }
      },
      rival: {
        profilePath: `${sourceRoot}/production/profiles/rival.yaml`,
        profile: { actor: 'rival', sourcePath: `${sourceRoot}/production/profiles/rival.yaml` }
      }
    },
    set: {
      baselineManifestPath: `${sourceRoot}/production/sets/city.json`,
      baselineManifest: {
        setId: 'city',
        sourcePath: `${sourceRoot}/production/sets/city.json`,
        resetTimeoutMs: 5000,
        actorBaselines: {
          hero: { mark: 'hero_start' },
          rival: { mark: 'rival_start' }
        }
      }
    },
    scene: {
      id: 'confrontation',
      marks: {
        hero_start: { dimension: 'minecraft:overworld', position: { x: 1, y: 64, z: 1 }, facing: { yaw: 0, pitch: 0 }, radius: 1, dwellTicks: 1, safeHeadroom: true },
        rival_start: { dimension: 'minecraft:overworld', position: { x: 3, y: 64, z: 1 }, facing: { yaw: 180, pitch: 0 }, radius: 1, dwellTicks: 1, safeHeadroom: true }
      },
      dialoguePolicy: { maximumWordsPerLine: 18, forbiddenLiterals: [], forbiddenPatterns: [] },
      cues: [
        {
          id: 'hero_reply', speaker: 'hero', mark: 'hero_start', requiredIntent: 'recover the map', timeoutSeconds: 12,
          approvedVariants: ['I will recover it.'], fallbackLine: 'I will take the map back.'
        }
      ]
    },
    retry: { wholeSceneAttempts: 1 }
  };
}

function provenance(sourceEpisode) {
  return {
    sourceEpisode,
    provider: 'test-provider', model: 'test-model', promptTemplateVersion: 'showrunner-rehearsal-v2',
    promptHash: 'a'.repeat(64), tokens: { input: 11, output: 7 }, latencyMs: 12
  };
}

function approvedBank() {
  const sourceEpisode = episode();
  return approveCandidateBank({
    candidates: [{
      id: 'candidate_1', cueId: 'hero_reply', speaker: 'hero', text: 'I will recover it.',
      hardValidation: { ok: true, violations: [] }, softScores: {}
    }],
    decisions: [{ candidateId: 'candidate_1', approved: true, variantId: 'hero_reply_1', creator: 'Jay' }],
    creator: 'Jay',
    provenance: provenance(sourceEpisode),
    approvalPrivateKey: privateKey
  });
}

test('uses checkout-independent authored content hashes', () => {
  assert.equal(sourceEpisodeHash(episode('/checkout-a')), sourceEpisodeHash(episode('/checkout-b')));
});

test('verifies creator banks and exact line receipts with public authority only', () => {
  const bank = approvedBank();
  assert.equal(bank.schemaVersion, 2);
  assert.equal(bank.signature.algorithm, 'Ed25519');
  assert.equal(verifyApprovedBank(bank, publicKey).ok, true);

  const cue = episode().scene.cues[0];
  const selected = selectRuntimeLine({ cue, bank, variantId: 'hero_reply_1', approvalPublicKey: publicKey });
  assert.equal(selected.ok, true);
  assert.equal(verifyLineAuthorization(selected.authorization, {
    publicKey,
    episodeContentHash: bank.sourceEpisodeHash,
    cueId: cue.id,
    speaker: cue.speaker,
    text: selected.text
  }).ok, true);

  const fallback = selectRuntimeLine({ cue, bank, approvalPublicKey: publicKey });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.fallback, true);
  assert.equal(verifyLineAuthorization(fallback.authorization, {
    publicKey,
    episodeContentHash: bank.sourceEpisodeHash,
    cueId: cue.id,
    speaker: cue.speaker,
    text: cue.fallbackLine
  }).ok, true);
});

test('fails closed for unsigned fallbacks, tampered validation, and a different public key', () => {
  const bank = approvedBank();
  const cue = episode().scene.cues[0];
  const unsignedFallback = { ...bank, fallbacks: bank.fallbacks.map(({ authorization, ...entry }) => entry) };
  assert.equal(selectRuntimeLine({ cue, bank: unsignedFallback, approvalPublicKey: publicKey }).code, 'BANK_INTEGRITY_INVALID');

  const tampered = {
    ...bank,
    variants: bank.variants.map((variant) => ({
      ...variant,
      hardValidation: { ok: false, violations: [{ code: 'FORGED' }] }
    }))
  };
  assert.equal(selectRuntimeLine({ cue, bank: tampered, variantId: 'hero_reply_1', approvalPublicKey: publicKey }).code, 'BANK_INTEGRITY_INVALID');

  const other = generateKeyPairSync('ed25519');
  assert.equal(verifyApprovedBank(bank, other.publicKey).code, 'BANK_SIGNATURE_INVALID');
});

test('the exported showrunner rejects an unsigned bank before issuing any command', async () => {
  const commands = [];
  const port = { execute(command) { commands.push(command); } };
  const runner = createShowrunner({
    actors: { hero: port, rival: port }, production: port, capture: port, timers: port,
    approvalPublicKey: publicKey,
    clock: { now: () => 1 }
  });
  await assert.rejects(runner.startTake({
    productionId: 'production-a', takeId: 'take-a', episode: episode(),
    approvedBank: { schemaVersion: 2, variants: [], fallbacks: [] }
  }), { code: 'BANK_INTEGRITY_INVALID' });
  assert.deepEqual(commands, []);
});
