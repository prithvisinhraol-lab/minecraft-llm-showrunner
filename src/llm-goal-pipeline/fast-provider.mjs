import { createCodexProvider } from '../llm-agent/codex-provider.mjs';

const ACTION_KINDS = Object.freeze([
  'observe', 'navigate_to_target', 'navigate_to_landmark', 'mine_target', 'collect_drop',
  'craft_recipe', 'place_against_target', 'equip_item', 'consume_item', 'attack_target', 'speak'
]);

const DECISION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['act', 'finish', 'fail'] },
    action: {
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ACTION_KINDS },
            observationVersion: { type: 'integer', minimum: 1 },
            targetId: { type: ['string', 'null'], maxLength: 100 },
            reference: { type: ['string', 'null'], maxLength: 100 },
            recipe: { type: ['string', 'null'], maxLength: 100 },
            count: { type: ['integer', 'null'], minimum: 1, maximum: 64 },
            item: { type: ['string', 'null'], maxLength: 100 },
            text: { type: ['string', 'null'], maxLength: 200 }
          },
          required: ['kind', 'observationVersion', 'targetId', 'reference', 'recipe', 'count', 'item', 'text'],
          additionalProperties: false
        },
        { type: 'null' }
      ]
    },
    summary: { type: 'string', maxLength: 500 },
    plan: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 200 } }
  },
  required: ['decision', 'action', 'summary', 'plan'],
  additionalProperties: false
});

const PROMPT = [
  'Choose one immediate action for the active bounded Minecraft goal contract.',
  'Use only the compiled authority and opaque IDs in the current observation.',
  'Echo the current observationVersion. Do not emit coordinates, commands, code, markdown, or extra fields.',
  'Use null for unused action parameters; deterministic code will normalize and validate the decision.'
].join(' ');

function invalid(message) {
  const error = new Error(message);
  error.code = 'PIPELINE_FAST_PROVIDER_OUTPUT_INVALID';
  throw error;
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,decision,plan,summary') invalid('fast provider envelope is invalid');
  const normalized = structuredClone(value);
  if (normalized.action && typeof normalized.action === 'object' && !Array.isArray(normalized.action)) {
    for (const key of ['targetId', 'reference', 'recipe', 'count', 'item', 'text']) {
      if (normalized.action[key] === null) delete normalized.action[key];
    }
  }
  return normalized;
}

export function createFastProvider({ baseProviderFactory = createCodexProvider, timeoutMs = 30_000, ...options } = {}) {
  if (typeof baseProviderFactory !== 'function') throw new TypeError('baseProviderFactory must be a function');
  if (timeoutMs !== 30_000) throw new TypeError('fast provider timeout must be 30000 ms');
  const base = baseProviderFactory({
    ...options, timeoutMs,
    decisionSchema: DECISION_SCHEMA,
    promptPreamble: PROMPT,
    normalizeDecision: (decision) => decision
  });
  if (!base || typeof base.decide !== 'function') throw new TypeError('base provider must expose decide');
  return Object.freeze({
    async decide(context, { signal } = {}) {
      return normalize(await base.decide(context, { signal }));
    }
  });
}
