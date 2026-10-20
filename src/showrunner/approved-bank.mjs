import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as asymmetricSign,
  timingSafeEqual,
  verify as asymmetricVerify
} from 'node:crypto';

const SHA256_HEX = /^[a-f0-9]{64}$/iu;
const SIGNATURE = /^[A-Za-z0-9_-]+$/u;
const PATH_METADATA_KEYS = new Set(['sourcePath', 'profilePath', 'baselineManifestPath']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function nonemptyString(value) {
  return typeof value === 'string' && value !== '';
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function authoredContent(value) {
  if (Array.isArray(value)) return value.map(authoredContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PATH_METADATA_KEYS.has(key))
    .map(([key, nested]) => [key, authoredContent(nested)]));
}

function normalizePem(value) {
  return typeof value === 'string' ? value.replaceAll('\\n', '\n') : value;
}

function privateSigningKey(value) {
  try {
    const key = value?.type === 'private' ? value : createPrivateKey(normalizePem(value));
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

function publicVerificationKey(value = process.env.SHOWRUNNER_APPROVAL_PUBLIC_KEY) {
  try {
    const key = value?.type === 'public' ? value : createPublicKey(normalizePem(value));
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

function signatureFor(content, key) {
  return {
    algorithm: 'Ed25519',
    keyId: sha256(createPublicKey(key).export({ type: 'spki', format: 'der' })),
    value: asymmetricSign(null, Buffer.from(stableJson(content)), key).toString('base64url')
  };
}

function canonicalSignature(signature) {
  if (!signature || signature.algorithm !== 'Ed25519' || !SHA256_HEX.test(signature.keyId) || !SIGNATURE.test(signature.value)) return undefined;
  return { algorithm: 'Ed25519', keyId: signature.keyId, value: signature.value };
}

function verifySignature(content, signature, key) {
  const canonical = canonicalSignature(signature);
  if (!canonical) return false;
  const expectedKeyId = sha256(key.export({ type: 'spki', format: 'der' }));
  const suppliedKeyId = Buffer.from(canonical.keyId, 'hex');
  const expectedKeyIdBytes = Buffer.from(expectedKeyId, 'hex');
  if (suppliedKeyId.length !== expectedKeyIdBytes.length || !timingSafeEqual(suppliedKeyId, expectedKeyIdBytes)) return false;
  try {
    return asymmetricVerify(null, Buffer.from(stableJson(content)), key, Buffer.from(canonical.value, 'base64url'));
  } catch {
    return false;
  }
}

function canonicalProvenance(provenance, sourceEpisodeHash) {
  if (!provenance ||
    !nonemptyString(provenance.provider) ||
    !nonemptyString(provenance.model) ||
    !nonemptyString(provenance.promptTemplateVersion) ||
    !SHA256_HEX.test(provenance.promptHash) ||
    !Object.hasOwn(provenance, 'tokens') ||
    !Object.hasOwn(provenance.tokens ?? {}, 'input') ||
    !Object.hasOwn(provenance.tokens ?? {}, 'output') ||
    !nonnegativeInteger(provenance.tokens.input) ||
    !nonnegativeInteger(provenance.tokens.output) ||
    !nonnegativeInteger(provenance.latencyMs) ||
    provenance.sourceEpisodeHash !== sourceEpisodeHash) return undefined;
  return {
    provider: provenance.provider,
    model: provenance.model,
    promptTemplateVersion: provenance.promptTemplateVersion,
    promptHash: provenance.promptHash,
    tokens: { input: provenance.tokens.input, output: provenance.tokens.output },
    latencyMs: provenance.latencyMs,
    sourceEpisodeHash
  };
}

function canonicalDecision(decision, { variantId, fallback = false, creator }) {
  if (!decision || decision.approved !== true || decision.creator !== creator) return undefined;
  if (fallback) {
    if (decision.kind !== 'authored-fallback' || decision.lineId !== variantId) return undefined;
    return { approved: true, kind: 'authored-fallback', lineId: variantId, creator };
  }
  if (!nonemptyString(decision.candidateId) || decision.variantId !== variantId) return undefined;
  return { candidateId: decision.candidateId, approved: true, variantId, creator };
}

function canonicalLine(entry, { fallback, creator }) {
  if (!entry || !nonemptyString(entry.id) || !nonemptyString(entry.cueId) || !nonemptyString(entry.speaker) || !nonemptyString(entry.text)) return undefined;
  if (entry.authoredLineId !== undefined && !nonemptyString(entry.authoredLineId)) return undefined;
  if (!entry.hardValidation || typeof entry.hardValidation !== 'object' || entry.hardValidation.ok !== true) return undefined;
  const decision = canonicalDecision(entry.decision, { variantId: entry.id, fallback, creator });
  if (!decision) return undefined;
  return {
    id: entry.id,
    cueId: entry.cueId,
    ...(entry.authoredLineId === undefined ? {} : { authoredLineId: entry.authoredLineId }),
    speaker: entry.speaker,
    text: entry.text,
    hardValidation: entry.hardValidation,
    ...(fallback ? {} : { softScores: entry.softScores ?? {} }),
    decision
  };
}

function lineAuthorizationContent(line, { sourceEpisodeHash, creator, fallback }) {
  return {
    schemaVersion: 1,
    type: 'creator-line-authorization',
    sourceEpisodeHash,
    lineKind: fallback ? 'fallback' : 'approved-variant',
    lineId: line.id,
    cueId: line.cueId,
    ...(line.authoredLineId === undefined ? {} : { authoredLineId: line.authoredLineId }),
    speaker: line.speaker,
    text: line.text,
    hardValidation: line.hardValidation,
    decision: line.decision,
    creator
  };
}

function canonicalAuthorization(value) {
  if (!value || value.schemaVersion !== 1 || value.type !== 'creator-line-authorization' || !SHA256_HEX.test(value.sourceEpisodeHash) ||
    !['fallback', 'approved-variant'].includes(value.lineKind) || !nonemptyString(value.lineId) || !nonemptyString(value.cueId) ||
    (value.authoredLineId !== undefined && !nonemptyString(value.authoredLineId)) ||
    !nonemptyString(value.speaker) || !nonemptyString(value.text) || !nonemptyString(value.creator) || value.hardValidation?.ok !== true) return undefined;
  const signature = canonicalSignature(value.signature);
  if (!signature) return undefined;
  return {
    schemaVersion: 1,
    type: 'creator-line-authorization',
    sourceEpisodeHash: value.sourceEpisodeHash,
    lineKind: value.lineKind,
    lineId: value.lineId,
    cueId: value.cueId,
    ...(value.authoredLineId === undefined ? {} : { authoredLineId: value.authoredLineId }),
    speaker: value.speaker,
    text: value.text,
    hardValidation: value.hardValidation,
    decision: value.decision,
    creator: value.creator,
    signature
  };
}

function authorizationMatchesLine(authorization, line, context) {
  const expected = lineAuthorizationContent(line, context);
  const { signature: _signature, ...content } = authorization;
  return stableJson(content) === stableJson(expected);
}

function canonicalizeLineWithAuthorization(entry, context) {
  const line = canonicalLine(entry, context);
  const authorization = canonicalAuthorization(entry?.authorization);
  if (!line || !authorization || !authorizationMatchesLine(authorization, line, context)) return undefined;
  return { ...line, authorization };
}

function canonicalBankContent(bank) {
  if (!bank || bank.schemaVersion !== 2 || !nonemptyString(bank.creator) || !SHA256_HEX.test(bank.sourceEpisodeHash) ||
    !Array.isArray(bank.variants) || !Array.isArray(bank.fallbacks)) return undefined;
  const provenance = canonicalProvenance(bank.provenance, bank.sourceEpisodeHash);
  const context = { sourceEpisodeHash: bank.sourceEpisodeHash, creator: bank.creator };
  const variants = bank.variants.map((entry) => canonicalizeLineWithAuthorization(entry, { ...context, fallback: false }));
  const fallbacks = bank.fallbacks.map((entry) => canonicalizeLineWithAuthorization(entry, { ...context, fallback: true }));
  if (!provenance || variants.some((entry) => !entry) || fallbacks.some((entry) => !entry) || fallbacks.length === 0) return undefined;
  const ids = [...variants, ...fallbacks].map((entry) => entry.id);
  const fallbackBindings = fallbacks.map((entry) => `${entry.cueId}\u0000${entry.authoredLineId ?? entry.cueId}`);
  if (new Set(ids).size !== ids.length || new Set(fallbackBindings).size !== fallbackBindings.length) return undefined;
  return { schemaVersion: 2, creator: bank.creator, sourceEpisodeHash: bank.sourceEpisodeHash, provenance, variants, fallbacks };
}

export function sourceEpisodeHash(sourceEpisode) {
  return sha256(stableJson(authoredContent(sourceEpisode)));
}

export function canonicalizeApprovedBank(bank) {
  const content = canonicalBankContent(bank);
  const signature = canonicalSignature(bank?.signature);
  return content && signature ? { ...content, signature } : undefined;
}

export function signApprovedBank(bank, approvalPrivateKey = process.env.SHOWRUNNER_APPROVAL_PRIVATE_KEY) {
  const key = privateSigningKey(approvalPrivateKey);
  if (!key) return { ok: false, code: 'APPROVAL_PRIVATE_KEY_REQUIRED' };
  if (!bank || bank.schemaVersion !== 2 || !nonemptyString(bank.creator) || !SHA256_HEX.test(bank.sourceEpisodeHash) ||
    !Array.isArray(bank.variants) || !Array.isArray(bank.fallbacks)) return { ok: false, code: 'BANK_INTEGRITY_INVALID' };

  const context = { sourceEpisodeHash: bank.sourceEpisodeHash, creator: bank.creator };
  const sealLine = (entry, fallback) => {
    const line = canonicalLine(entry, { ...context, fallback });
    if (!line) return undefined;
    const content = lineAuthorizationContent(line, { ...context, fallback });
    return { ...line, authorization: { ...content, signature: signatureFor(content, key) } };
  };
  const variants = bank.variants.map((entry) => sealLine(entry, false));
  const fallbacks = bank.fallbacks.map((entry) => sealLine(entry, true));
  if (variants.some((entry) => !entry) || fallbacks.some((entry) => !entry)) return { ok: false, code: 'BANK_INTEGRITY_INVALID' };
  const unsigned = { ...bank, variants, fallbacks };
  const content = canonicalBankContent(unsigned);
  if (!content) return { ok: false, code: 'BANK_INTEGRITY_INVALID' };
  return { ok: true, bank: { ...content, signature: signatureFor(content, key) } };
}

export function verifyLineAuthorization(authorization, expected = {}) {
  const key = publicVerificationKey(expected.publicKey);
  if (!key) return { ok: false, code: 'APPROVAL_PUBLIC_KEY_REQUIRED' };
  const canonical = canonicalAuthorization(authorization);
  if (!canonical) return { ok: false, code: 'LINE_AUTHORIZATION_INVALID' };
  const { signature, ...content } = canonical;
  if (!verifySignature(content, signature, key)) return { ok: false, code: 'LINE_AUTHORIZATION_INVALID' };
  const bindings = {
    sourceEpisodeHash: expected.episodeContentHash,
    cueId: expected.cueId,
    authoredLineId: expected.authoredLineId,
    speaker: expected.speaker,
    text: expected.text
  };
  for (const [field, value] of Object.entries(bindings)) {
    if (value !== undefined && canonical[field] !== value) return { ok: false, code: 'LINE_AUTHORIZATION_MISMATCH' };
  }
  return { ok: true, authorization: canonical };
}

export function verifyApprovedBank(bank, approvalPublicKey) {
  const key = publicVerificationKey(approvalPublicKey);
  if (!key) return { ok: false, code: 'APPROVAL_PUBLIC_KEY_REQUIRED' };
  const canonical = canonicalizeApprovedBank(bank);
  if (!canonical) return { ok: false, code: 'BANK_INTEGRITY_INVALID' };
  const { signature, ...content } = canonical;
  if (!verifySignature(content, signature, key)) return { ok: false, code: 'BANK_SIGNATURE_INVALID' };
  for (const line of [...canonical.variants, ...canonical.fallbacks]) {
    const verification = verifyLineAuthorization(line.authorization, {
      publicKey: key,
      episodeContentHash: canonical.sourceEpisodeHash,
      cueId: line.cueId,
      speaker: line.speaker,
      text: line.text
    });
    if (!verification.ok) return { ok: false, code: 'BANK_INTEGRITY_INVALID' };
  }
  return { ok: true, bank: canonical };
}
