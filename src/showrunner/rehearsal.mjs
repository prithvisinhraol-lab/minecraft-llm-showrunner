import { createHash } from 'node:crypto';

import { ERROR_CODES, ShowrunnerError } from './errors.mjs';
import { signApprovedBank, sourceEpisodeHash } from './approved-bank.mjs';
import { validateDialogue } from './policy.mjs';

const PROMPT_TEMPLATE_VERSION = 'showrunner-rehearsal-v2';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, code, name) {
  if (!Number.isInteger(value) || value <= 0) throw new ShowrunnerError(code, `${name} must be a positive integer`);
  return value;
}

function positiveNumber(value, code, name) {
  if (!Number.isFinite(value) || value <= 0) throw new ShowrunnerError(code, `${name} must be positive`);
  return value;
}

function cappedBudget(requested, ceiling, name, validator = positiveInteger) {
  const max = validator(ceiling, ERROR_CODES.REHEARSAL_BUDGET_INVALID, `profile ${name}`);
  if (requested === undefined) return max;
  return Math.min(validator(requested, ERROR_CODES.REHEARSAL_BUDGET_INVALID, name), max);
}

function cappedRetries(requested, ceiling) {
  if (!Number.isInteger(ceiling) || ceiling < 0) {
    throw new ShowrunnerError(ERROR_CODES.REHEARSAL_BUDGET_INVALID, 'profile maxRetries must be a nonnegative integer');
  }
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 0)) {
    throw new ShowrunnerError(ERROR_CODES.REHEARSAL_BUDGET_INVALID, 'maxRetries must be a nonnegative integer');
  }
  return Math.min(requested ?? ceiling, ceiling, 1);
}

function promptFor({ episode, cue, profile }) {
  return [
    'Generate a single family-safe Minecraft dialogue line for rehearsal only.',
    `Episode: ${episode.episode}.`,
    `Scene: ${episode.scene.id}.`,
    `Speaker: ${cue.speaker}.`,
    `Intent: ${cue.requiredIntent}.`,
    `Relationship: ${profile.relationship}.`,
    `Voice: ${profile.voice}.`,
    `Vocabulary: ${profile.vocabulary}.`,
    `Cadence: ${profile.cadence}.`,
    `Humor: ${profile.humor}.`,
    `Emotional range: ${(profile.emotionalRange ?? []).join(', ')}.`,
    `Scene attitude: ${profile.sceneAttitude}.`,
    `Preferred subjects: ${(profile.preferredSubjects ?? []).join(', ')}.`,
    `Positive examples: ${(profile.positiveExamples ?? []).join(' | ')}.`,
    `Maximum words: ${Math.min(profile.maxLineWords, episode.scene.dialoguePolicy.maximumWordsPerLine)}.`,
    'Do not include commands, newlines, or control characters.'
  ].join('\n');
}

function authorizationCueId(cue) {
  return cue.cueId ?? cue.id;
}

function authoredDialogueLines(sourceEpisode) {
  return (sourceEpisode?.scene?.cues ?? []).flatMap((cue) => Array.isArray(cue.dialogue)
    ? cue.dialogue.map((line) => ({ ...line, cueId: cue.id }))
    : [{ ...cue }]);
}

export function buildRehearsalRequest({ episode, cue, profile, budget = {} } = {}) {
  if (!episode || !cue || !profile || cue.speaker !== profile.actor) {
    throw new ShowrunnerError(ERROR_CODES.REHEARSAL_BUDGET_INVALID, 'Episode, matching cue, and profile are required');
  }
  const limits = profile.rehearsal;
  if (!limits || limits.runtimeUse !== false) throw new ShowrunnerError(ERROR_CODES.REHEARSAL_BUDGET_INVALID, 'Profile must be rehearsal-only');
  const prompt = promptFor({ episode, cue, profile });
  const request = {
    schemaVersion: 1,
    provider: limits.provider,
    model: limits.model,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    prompt,
    episodeId: episode.episode,
    cueId: authorizationCueId(cue),
    ...(cue.cueId === undefined ? {} : { authoredLineId: cue.id }),
    speaker: cue.speaker,
    validationContext: {
      contentRating: episode.contentRatingPolicy ?? {},
      globalSafety: episode.globalSafetyPolicy ?? {},
      profile: {
        forbiddenLiterals: profile.forbiddenSubjects,
        maxLineWords: profile.maxLineWords
      },
      scene: episode.scene.dialoguePolicy,
      cue: cue.dialoguePolicy ?? {},
      maxWords: Math.min(profile.maxLineWords, episode.scene.dialoguePolicy.maximumWordsPerLine)
    },
    maxCandidates: cappedBudget(budget.maxCandidates, limits.maxCandidates, 'maxCandidates'),
    maxInputTokens: cappedBudget(budget.maxInputTokens, limits.maxInputTokens, 'maxInputTokens'),
    maxOutputTokens: cappedBudget(budget.maxOutputTokens, limits.maxOutputTokens, 'maxOutputTokens'),
    timeoutSeconds: cappedBudget(budget.timeoutSeconds, limits.timeoutSeconds, 'timeoutSeconds', positiveNumber),
    maxRetries: cappedRetries(budget.maxRetries, limits.maxRetries)
  };
  const promptTokens = Math.ceil([...prompt].length / 4);
  if (promptTokens > request.maxInputTokens) {
    throw new ShowrunnerError(ERROR_CODES.REHEARSAL_INPUT_BUDGET_EXCEEDED, 'Prompt exceeds input token budget', { promptTokens, maxInputTokens: request.maxInputTokens });
  }
  return deepFreeze(request);
}

function withTimeout(promise, timeoutSeconds, onTimeout) {
  let timeout;
  const expiration = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new ShowrunnerError(ERROR_CODES.REHEARSAL_PROVIDER_INVALID, 'Rehearsal provider timed out');
      onTimeout(error);
      reject(error);
    }, timeoutSeconds * 1000);
  });
  return Promise.race([promise, expiration]).finally(() => clearTimeout(timeout));
}

export async function rehearseCandidates({ request, provider, validate = (text) => validateDialogue(text, request.validationContext), score = () => ({}) } = {}) {
  if (!request || !provider || typeof provider.generateCandidates !== 'function') {
    throw new ShowrunnerError(ERROR_CODES.REHEARSAL_PROVIDER_INVALID, 'Provider must expose generateCandidates(request)');
  }
  const started = Date.now();
  let output;
  let lastError;
  const retryLimit = Number.isInteger(request.maxRetries) && request.maxRetries > 0 ? 1 : 0;
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const controller = new AbortController();
    try {
      const work = Promise.resolve().then(() => provider.generateCandidates(request, { signal: controller.signal, attempt }));
      output = await withTimeout(work, request.timeoutSeconds, (reason) => {
        controller.abort(reason);
        if (typeof provider.cancel === 'function') {
          void Promise.resolve().then(() => provider.cancel({ request, attempt, reason })).catch(() => {});
        }
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!output) throw lastError;
  const rawCandidates = output?.candidates;
  if (!Array.isArray(rawCandidates)) throw new ShowrunnerError(ERROR_CODES.REHEARSAL_PROVIDER_INVALID, 'Provider returned invalid candidates');
  const tokens = output.tokens;
  if (!tokens || !Number.isSafeInteger(tokens.input) || tokens.input < 0 || !Number.isSafeInteger(tokens.output) || tokens.output < 0) {
    throw new ShowrunnerError(ERROR_CODES.REHEARSAL_PROVIDER_INVALID, 'Provider must return exact input and output token usage');
  }
  if (tokens.input > request.maxInputTokens || tokens.output > request.maxOutputTokens) {
    throw new ShowrunnerError(ERROR_CODES.REHEARSAL_OUTPUT_BUDGET_EXCEEDED, 'Provider exceeded token budget', { tokens });
  }
  const candidates = rawCandidates.slice(0, request.maxCandidates).map((item, index) => {
    const text = typeof item === 'string' ? item : item.text;
    const hardValidation = validate(text);
    return {
      id: item?.id ?? `candidate_${index + 1}`,
      cueId: request.cueId,
      ...(request.authoredLineId === undefined ? {} : { authoredLineId: request.authoredLineId }),
      speaker: request.speaker,
      text,
      hardValidation,
      softScores: score(text)
    };
  });
  return deepFreeze({
    candidates,
    provenance: {
      provider: request.provider,
      model: request.model,
      promptTemplateVersion: request.promptTemplateVersion,
      promptHash: sha256(request.prompt),
      tokens: { input: tokens.input ?? 0, output: tokens.output ?? 0 },
      latencyMs: Date.now() - started
    }
  });
}

export function approveCandidateBank({ candidates, decisions, provenance, creator, approvalPrivateKey } = {}) {
  if (!Array.isArray(candidates) || !Array.isArray(decisions) || !provenance?.sourceEpisode) {
    throw new ShowrunnerError(ERROR_CODES.APPROVAL_PROVENANCE_INVALID, 'Candidates, decisions, and source episode provenance are required');
  }
  if (typeof creator !== 'string' || creator.length === 0) {
    throw new ShowrunnerError(ERROR_CODES.CREATOR_DECISION_REQUIRED, 'A creator identity is required');
  }
  const decisionsByCandidate = new Map();
  for (const decision of decisions) {
    if (!decision || typeof decision.candidateId !== 'string' || typeof decision.approved !== 'boolean' || decisionsByCandidate.has(decision.candidateId)) {
      throw new ShowrunnerError(ERROR_CODES.CREATOR_DECISION_REQUIRED, 'Every candidate requires one explicit creator decision');
    }
    decisionsByCandidate.set(decision.candidateId, decision);
  }
  const variants = [];
  const variantIds = new Set();
  for (const candidate of candidates) {
    const decision = decisionsByCandidate.get(candidate?.id);
    if (!decision) throw new ShowrunnerError(ERROR_CODES.CREATOR_DECISION_REQUIRED, 'Every candidate requires an explicit creator decision', { candidateId: candidate?.id });
    if (!decision.approved) continue;
    if (candidate.hardValidation?.ok !== true || typeof candidate.text !== 'string') {
      throw new ShowrunnerError(ERROR_CODES.CANDIDATE_NOT_APPROVABLE, 'Only hard-valid candidates may be approved', { candidateId: candidate.id });
    }
    if (typeof decision.variantId !== 'string' || decision.variantId === '') {
      throw new ShowrunnerError(ERROR_CODES.CREATOR_DECISION_REQUIRED, 'Approved decisions require a stable variant ID', { candidateId: candidate.id });
    }
    if (decision.creator !== creator) {
      throw new ShowrunnerError(ERROR_CODES.CREATOR_DECISION_REQUIRED, 'Approved decisions require a creator', { candidateId: candidate.id });
    }
    if (variantIds.has(decision.variantId)) throw new ShowrunnerError(ERROR_CODES.DUPLICATE_VARIANT_ID, 'Variant IDs must be unique', { variantId: decision.variantId });
    variantIds.add(decision.variantId);
    variants.push({
      id: decision.variantId,
      cueId: candidate.cueId,
      ...(candidate.authoredLineId === undefined ? {} : { authoredLineId: candidate.authoredLineId }),
      speaker: candidate.speaker,
      text: candidate.text,
      hardValidation: candidate.hardValidation,
      softScores: candidate.softScores ?? {},
      decision: { candidateId: candidate.id, approved: true, variantId: decision.variantId, creator: decision.creator }
    });
  }
  for (const candidateId of decisionsByCandidate.keys()) {
    if (!candidates.some((candidate) => candidate?.id === candidateId)) {
      throw new ShowrunnerError(ERROR_CODES.CREATOR_DECISION_REQUIRED, 'Creator decision references an unknown candidate', { candidateId });
    }
  }
  const hash = sourceEpisodeHash(provenance.sourceEpisode);
  const sourceLines = authoredDialogueLines(provenance.sourceEpisode);
  if (sourceLines.length === 0) {
    throw new ShowrunnerError(ERROR_CODES.APPROVAL_PROVENANCE_INVALID, 'Source episode cues are required to authorize fallbacks');
  }
  const fallbacks = sourceLines.map((line) => {
    const profile = provenance.sourceEpisode.actors?.[line.speaker]?.profile ?? {};
    const hardValidation = validateDialogue(line.fallbackLine, {
      contentRating: provenance.sourceEpisode.contentRatingPolicy ?? {},
      globalSafety: provenance.sourceEpisode.globalSafetyPolicy ?? {},
      profile: { forbiddenLiterals: profile.forbiddenSubjects ?? [], maxLineWords: profile.maxLineWords },
      scene: provenance.sourceEpisode.scene.dialoguePolicy ?? {},
      cue: line.dialoguePolicy ?? {},
      maxWords: Math.min(
        Number.isFinite(profile.maxLineWords) ? profile.maxLineWords : Infinity,
        provenance.sourceEpisode.scene.dialoguePolicy?.maximumWordsPerLine ?? Infinity
      )
    });
    if (hardValidation.ok !== true) {
      throw new ShowrunnerError(ERROR_CODES.CANDIDATE_NOT_APPROVABLE, 'Authored fallback failed hard validation', {
        cueId: line.cueId, authoredLineId: line.id
      });
    }
    const id = `fallback:${line.id}`;
    return {
      id,
      cueId: authorizationCueId(line),
      ...(line.cueId === undefined ? {} : { authoredLineId: line.id }),
      speaker: line.speaker,
      text: line.fallbackLine,
      hardValidation,
      decision: { approved: true, kind: 'authored-fallback', lineId: id, creator }
    };
  });
  const bank = {
    schemaVersion: 2,
    creator,
    sourceEpisodeHash: hash,
    variants,
    fallbacks,
    provenance: {
      provider: provenance.provider,
      model: provenance.model,
      promptTemplateVersion: provenance.promptTemplateVersion,
      promptHash: provenance.promptHash,
      tokens: provenance.tokens,
      latencyMs: provenance.latencyMs,
      sourceEpisodeHash: hash
    }
  };
  const signature = signApprovedBank(bank, approvalPrivateKey ?? process.env.SHOWRUNNER_APPROVAL_PRIVATE_KEY);
  if (!signature.ok) {
    const code = signature.code === 'APPROVAL_PRIVATE_KEY_REQUIRED' ? 'APPROVAL_PRIVATE_KEY_REQUIRED' : ERROR_CODES.APPROVAL_PROVENANCE_INVALID;
    throw new ShowrunnerError(code, code === 'APPROVAL_PRIVATE_KEY_REQUIRED' ? 'A creator-controlled private signing key is required' : 'Approval provenance is incomplete or invalid');
  }
  return deepFreeze(signature.bank);
}
