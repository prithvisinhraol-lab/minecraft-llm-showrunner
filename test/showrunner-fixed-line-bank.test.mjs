import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { verifyApprovedBank } from '../src/showrunner/approved-bank.mjs';
import { createFixedLineBank } from '../src/showrunner/fixed-line-bank.mjs';
import { loadEpisode } from '../src/showrunner/schema.mjs';

test('creates one signed exact variant and fallback for all twelve authored lines', async () => {
  const episode = await loadEpisode('production/episodes/first-day-meadow.yaml');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bank = createFixedLineBank(episode, privateKey);
  assert.equal(bank.variants.length, 12);
  assert.equal(bank.fallbacks.length, 12);
  const authored = episode.scene.cues.flatMap((cue) => cue.dialogue);
  assert.deepEqual(bank.variants.map(({ cueId, authoredLineId, speaker, text }) => ({ cueId, authoredLineId, speaker, text })),
    authored.map((line) => ({ cueId: line.cueId, authoredLineId: line.id, speaker: line.speaker, text: line.fallbackLine })));
  assert.equal(verifyApprovedBank(bank, publicKey).ok, true);
});
