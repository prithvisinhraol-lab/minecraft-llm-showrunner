import { createCodexProvider } from '../llm-agent/codex-provider.mjs';
import { validateGeneratedContract } from './contracts.mjs';
import {
  CAPABILITY_IDS, CONSTRAINT_IDS, PREDICATE_IDS,
  resolveConstraint, resolvePredicate
} from './registry.mjs';

const REQUIRED_FIELDS = Object.freeze([
  'contractId', 'missionVersion', 'predecessor', 'objective', 'rationale',
  'prerequisites', 'success', 'constraints', 'capabilities', 'budget', 'expectedOutcome', 'question'
]);

function exactObject(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function parameterSchema(type) {
  if (type === 'boolean') return { type: 'boolean' };
  if (type === 'positive_integer') return { type: 'integer', minimum: 1 };
  if (type === 'nonnegative_integer') return { type: 'integer', minimum: 0 };
  return { type: 'string', minLength: 1, maxLength: 100 };
}

function vocabularyBranch(field, id, resolver) {
  const entry = resolver(id);
  return exactObject({
    [field]: { type: 'string', enum: [id] },
    ...Object.fromEntries(Object.entries(entry.parameters ?? {}).map(([name, type]) => [name, parameterSchema(type)]))
  });
}

const DECISION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: {
    expression: {
      anyOf: [
        ...PREDICATE_IDS.map((id) => vocabularyBranch('predicate', id, resolvePredicate)),
        exactObject({ all: { type: 'array', minItems: 1, maxItems: 16, items: { $ref: '#/$defs/expression' } } }),
        exactObject({ any: { type: 'array', minItems: 1, maxItems: 16, items: { $ref: '#/$defs/expression' } } }),
        exactObject({ not: { $ref: '#/$defs/expression' } })
      ]
    }
  },
  type: 'object',
  properties: {
    contractId: { type: 'string', minLength: 1, maxLength: 100 },
    missionVersion: { type: 'integer', minimum: 1 },
    predecessor: exactObject({
      contractId: { type: ['string', 'null'], maxLength: 100 },
      status: { type: 'string', enum: ['succeeded'] },
      proofKinds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 100 } }
    }),
    objective: { type: 'string', minLength: 1, maxLength: 300 },
    rationale: { type: 'string', minLength: 1, maxLength: 500 },
    prerequisites: { $ref: '#/$defs/expression' },
    success: { $ref: '#/$defs/expression' },
    constraints: {
      type: 'array', maxItems: 8,
      items: { anyOf: CONSTRAINT_IDS.map((id) => vocabularyBranch('rule', id, resolveConstraint)) }
    },
    capabilities: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', enum: CAPABILITY_IDS } },
    budget: exactObject({
      maximumActions: { type: 'integer', minimum: 1, maximum: 40 },
      maximumReplans: { type: 'integer', minimum: 0, maximum: 5 },
      maximumSeconds: { type: 'integer', minimum: 1, maximum: 300 },
      maximumSearchRadius: { type: 'integer', minimum: 1, maximum: 64 },
      maximumTravelRadius: { type: 'integer', minimum: 1, maximum: 128 }
    }),
    expectedOutcome: exactObject({
      summary: { type: 'string', minLength: 1, maxLength: 500 },
      proofKinds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 100 } }
    }),
    question: {
      anyOf: [
        exactObject({
          prompt: { type: 'string', minLength: 1, maxLength: 200 },
          choices: {
            type: 'array', minItems: 2, maxItems: 3,
            items: exactObject({
              id: { type: 'string', minLength: 1, maxLength: 100 },
              label: { type: 'string', minLength: 1, maxLength: 80 }
            })
          },
          defaultChoiceId: { type: 'string', minLength: 1, maxLength: 100 },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 30 }
        }),
        { type: 'null' }
      ]
    }
  },
  required: [...REQUIRED_FIELDS],
  additionalProperties: false
});

const PROMPT = [
  'Generate exactly one bounded successor goal contract for the Minecraft mission.',
  'Use only the supplied vocabulary, facts, fences, permissions, and remaining budgets.',
  'Do not emit coordinates, commands, code, markdown, commentary, or fields outside the schema.',
  'The controller will deterministically validate prerequisites, authority, budgets, and success proof.'
].join(' ');

function requireContext(context) {
  if (!context || typeof context !== 'object' || !context.fences) {
    const error = new Error('slow provider context is invalid');
    error.code = 'PIPELINE_SLOW_CONTEXT_INVALID';
    throw error;
  }
  return context;
}

export function createSlowContractProvider({
  baseProviderFactory = createCodexProvider,
  timeoutMs = 90_000,
  ...options
} = {}) {
  if (typeof baseProviderFactory !== 'function') throw new TypeError('baseProviderFactory must be a function');
  if (timeoutMs !== 90_000) throw new TypeError('slow provider timeout must be 90000 ms');
  const base = baseProviderFactory({
    ...options,
    timeoutMs,
    decisionSchema: DECISION_SCHEMA,
    promptPreamble: PROMPT,
    normalizeDecision: (decision) => decision
  });
  if (!base || typeof base.decide !== 'function') throw new TypeError('base provider must expose decide');
  return Object.freeze({
    async generate(context, { signal } = {}) {
      const supplied = requireContext(context);
      const proposal = await base.decide(supplied, { signal });
      return validateGeneratedContract(proposal, supplied.fences);
    }
  });
}

export function createScriptedSlowProvider(proposals = []) {
  if (!Array.isArray(proposals)) throw new TypeError('proposals must be an array');
  const queue = structuredClone(proposals);
  let index = 0;
  return Object.freeze({
    async generate(context, { signal } = {}) {
      if (signal?.aborted) {
        const error = new Error('scripted slow generation was aborted');
        error.code = 'PIPELINE_SLOW_ABORTED';
        throw error;
      }
      const supplied = requireContext(context);
      if (index >= queue.length) {
        const error = new Error('scripted slow provider is exhausted');
        error.code = 'PIPELINE_SLOW_SCRIPT_EXHAUSTED';
        throw error;
      }
      return validateGeneratedContract(structuredClone(queue[index++]), supplied.fences);
    }
  });
}
