import { signApprovedBank, sourceEpisodeHash } from './approved-bank.mjs';

export function createFixedLineBank(episode, privateKey) {
  const lines = episode?.scene?.cues?.flatMap((cue) => cue.dialogue ?? []);
  if (episode?.schemaVersion !== 2 || !Array.isArray(lines) || lines.length === 0) {
    throw new TypeError('A normalized schema-v2 episode with dialogue is required');
  }
  const episodeHash = sourceEpisodeHash(episode);
  const hardValidation = Object.freeze({ ok: true, violations: [] });
  const creator = 'VPNAJ';
  const variants = lines.map((line) => ({
    id: `fixed:${line.id}`, cueId: line.cueId, authoredLineId: line.id, speaker: line.speaker,
    text: line.fallbackLine, hardValidation, softScores: {},
    decision: { candidateId: `fixed-candidate:${line.id}`, approved: true, variantId: `fixed:${line.id}`, creator }
  }));
  const fallbacks = lines.map((line) => ({
    id: `fallback:${line.id}`, cueId: line.cueId, authoredLineId: line.id, speaker: line.speaker,
    text: line.fallbackLine, hardValidation,
    decision: { approved: true, kind: 'authored-fallback', lineId: `fallback:${line.id}`, creator }
  }));
  const result = signApprovedBank({
    schemaVersion: 2, creator, sourceEpisodeHash: episodeHash,
    provenance: {
      provider: 'authored-fixed-lines', model: 'none', promptTemplateVersion: 'authored-v1',
      promptHash: episodeHash, tokens: { input: 0, output: 0 }, latencyMs: 0, sourceEpisodeHash: episodeHash
    },
    variants, fallbacks
  }, privateKey);
  if (result.ok !== true) throw Object.assign(new Error(result.code), { code: result.code });
  return result.bank;
}
