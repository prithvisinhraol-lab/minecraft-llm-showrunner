import { verifyApprovedBank } from './approved-bank.mjs';

const POLICY_ORDER = Object.freeze(['content_rating', 'global_safety', 'profile', 'scene', 'cue']);
const DEFAULT_CHAT_LIMIT = 256;

function violation(policy, code, details = {}) {
  return { policy, code, ...details };
}

function policyFor(context, name) {
  const camelCase = name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  return context?.[camelCase] ?? context?.[name] ?? {};
}

function literalMatch(line, literals) {
  const normalized = line.toLowerCase();
  return (literals ?? []).find((literal) => typeof literal === 'string' && literal !== '' && normalized.includes(literal.toLowerCase()));
}

function patternMatch(line, patterns) {
  for (const pattern of patterns ?? []) {
    try {
      const caseInsensitive = typeof pattern === 'string' && pattern.startsWith('(?i)');
      const source = caseInsensitive ? pattern.slice(4) : pattern;
      if (new RegExp(source, caseInsensitive ? 'iu' : 'u').test(line)) return pattern;
    } catch {
      return { invalid: pattern };
    }
  }
  return undefined;
}

function checkPolicy(line, policyName, policy) {
  const literal = literalMatch(line, policy.forbiddenLiterals ?? policy.forbidden_literals);
  if (literal) return [violation(policyName, 'FORBIDDEN_LITERAL', { literal })];
  const pattern = patternMatch(line, policy.forbiddenPatterns ?? policy.forbidden_patterns);
  if (pattern?.invalid) return [violation(policyName, 'INVALID_FORBIDDEN_PATTERN', { pattern: pattern.invalid })];
  if (pattern) return [violation(policyName, 'FORBIDDEN_PATTERN', { pattern })];
  return [];
}

function countWords(line) {
  return line.trim() === '' ? 0 : line.trim().split(/\s+/u).length;
}

function firstDefined(...values) {
  return values.find((value) => Number.isFinite(value));
}

function limits(context) {
  const scene = policyFor(context, 'scene');
  const profile = policyFor(context, 'profile');
  const maxWords = firstDefined(
    context?.maxWords,
    context?.maximumWordsPerLine,
    scene.maximumWordsPerLine,
    scene.maximum_words_per_line,
    profile.maxLineWords,
    profile.max_line_words
  );
  const chatLimit = firstDefined(context?.chatLimit, context?.minecraftChatLimit, DEFAULT_CHAT_LIMIT);
  return { maxWords, chatLimit };
}

function globalSafetyViolations(line) {
  const violations = [];
  if (line.startsWith('/')) violations.push(violation('global_safety', 'LEADING_SLASH'));
  if (/\r|\n|\p{Cc}/u.test(line)) violations.push(violation('global_safety', 'CONTROL_CHARACTER'));
  return violations;
}

export { POLICY_ORDER };

export function validateDialogue(line, context = {}) {
  const text = typeof line === 'string' ? line : '';
  const violations = typeof line === 'string' ? [] : [violation('global_safety', 'LINE_NOT_STRING')];

  for (const policyName of POLICY_ORDER) {
    const current = policyName === 'global_safety'
      ? [...globalSafetyViolations(text), ...checkPolicy(text, policyName, policyFor(context, policyName))]
      : checkPolicy(text, policyName, policyFor(context, policyName));
    if (current.length > 0) {
      violations.push(...current);
      break;
    }
  }

  const { maxWords, chatLimit } = limits(context);
  const wordCount = countWords(text);
  const chatLength = [...text].length;
  if (Number.isFinite(maxWords) && wordCount > maxWords) violations.push(violation('length', 'WORD_COUNT', { maxWords }));
  if (Number.isFinite(chatLimit) && chatLength > chatLimit) violations.push(violation('length', 'CHAT_LENGTH', { chatLimit }));

  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations), wordCount, chatLength });
}

function rejected(code) {
  return Object.freeze({ ok: false, code });
}

function authoredSplitParts(cue, variantId) {
  const splitPlans = cue.splitPlans ?? cue.authoredSplitPlans ?? [];
  const plan = Array.isArray(splitPlans)
    ? splitPlans.find((item) => item?.variantId === variantId)
    : splitPlans[variantId];
  const parts = plan?.parts ?? plan?.segments ?? plan;
  return Array.isArray(parts) && parts.every((part) => typeof part === 'string' && part !== '') ? parts : undefined;
}

export function selectRuntimeLine({ cue, bank, variantId, split = false, approvalPublicKey } = {}) {
  if (!cue) return rejected('LINE_NOT_APPROVED');
  const verification = verifyApprovedBank(bank, approvalPublicKey);
  if (!verification.ok) return rejected(verification.code);
  const verifiedBank = verification.bank;
  const cueId = cue.cueId ?? cue.id;
  const authoredLineId = cue.cueId === undefined ? undefined : cue.id;
  const matchesAuthoredLine = (line) => line.cueId === cueId &&
    (authoredLineId === undefined ? line.authoredLineId === undefined : line.authoredLineId === authoredLineId);
  if (variantId === undefined || variantId === null) {
    const fallback = verifiedBank.fallbacks.find((line) =>
      matchesAuthoredLine(line) && line.speaker === cue.speaker && line.text === cue.fallbackLine);
    return fallback
      ? Object.freeze({
          ok: true, id: fallback.id, cueId, ...(authoredLineId === undefined ? {} : { authoredLineId }),
          speaker: cue.speaker, text: cue.fallbackLine, fallback: true, authorization: fallback.authorization
        })
      : rejected('LINE_NOT_APPROVED');
  }
  const line = verifiedBank.variants.find((variant) => variant.id === variantId);
  if (!line) return rejected('LINE_NOT_APPROVED');
  const allowed = cue.approvedVariants ?? [];
  if (!Array.isArray(allowed) || allowed.length === 0 || (!allowed.includes(variantId) && !allowed.includes(line.text))) return rejected('LINE_NOT_APPROVED');
  if (!matchesAuthoredLine(line)) return rejected('LINE_CUE_MISMATCH');
  if (line.speaker !== cue.speaker) return rejected('LINE_SPEAKER_MISMATCH');
  if (line.hardValidation?.ok !== true || line.decision?.approved !== true) return rejected('BANK_INTEGRITY_INVALID');

  const parts = authoredSplitParts(cue, variantId);
  if (split && !parts) return rejected('SPLIT_PLAN_NOT_AUTHORED');
  if (split && parts.join('') !== line.text) return rejected('SPLIT_PLAN_MISMATCH');
  return Object.freeze({
    ok: true,
    id: line.id,
    cueId: line.cueId,
    ...(line.authoredLineId === undefined ? {} : { authoredLineId: line.authoredLineId }),
    speaker: line.speaker,
    text: line.text,
    authorization: line.authorization,
    ...(split ? { parts: Object.freeze([...parts]) } : {})
  });
}
