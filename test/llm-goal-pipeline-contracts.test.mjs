import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTRACT_LIMITS,
  createContractRequestFences,
  validateGeneratedContract
} from '../src/llm-goal-pipeline/contracts.mjs';

const fences = () => createContractRequestFences({
  contractId: 'contract-1', missionVersion: 4, observationVersion: 9,
  predecessorContractId: 'contract-0', registryVersion: 1,
  now: '2026-08-29T15:00:00.000Z'
});

function proposal(overrides = {}) {
  return {
    contractId: 'contract-1', missionVersion: 4,
    predecessor: { contractId: 'contract-0', status: 'succeeded', proofKinds: ['inventory_at_least:oak_log'] },
    objective: 'Retain eight cobblestone.', rationale: 'Stone tools are the next survival milestone.',
    prerequisites: { all: [{ predicate: 'actor_alive' }, { predicate: 'inventory_at_least', item: 'wooden_pickaxe', count: 1 }] },
    success: { all: [{ predicate: 'inventory_at_least', item: 'cobblestone', count: 8 }] },
    constraints: [{ rule: 'stay_within_radius', blocks: 64 }, { rule: 'do_not_attack_players' }],
    capabilities: ['observe', 'navigate', 'mine_block', 'collect_item'],
    budget: { maximumActions: 30, maximumReplans: 5, maximumSeconds: 240, maximumSearchRadius: 32, maximumTravelRadius: 64 },
    expectedOutcome: { summary: 'Actor possesses eight cobblestone.', proofKinds: ['inventory_at_least:cobblestone'] },
    question: null,
    ...overrides
  };
}

test('validates and freezes one exact generated contract against request fences', () => {
  const source = proposal();
  const validated = validateGeneratedContract(source, fences());
  assert.equal(validated.budget.maximumActions, 30);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.prerequisites.all), true);
  source.objective = 'mutated';
  assert.equal(validated.objective, 'Retain eight cobblestone.');
});

test('rejects unknown fields, raw coordinates, stale fences, duplicate IDs, and unknown vocabulary', () => {
  const cases = [
    proposal({ rawCommand: '/give @s stone' }),
    proposal({ success: { all: [{ predicate: 'inventory_at_least', item: 'cobblestone', count: 8, x: 3 }] } }),
    proposal({ missionVersion: 3 }),
    proposal({ capabilities: ['observe', 'observe'] }),
    proposal({ capabilities: ['observe', 'shell'] }),
    proposal({ success: { all: [{ predicate: 'invented_fact' }] } }),
    proposal({ constraints: [{ rule: 'invented_rule' }] })
  ];
  for (const value of cases) assert.throws(() => validateGeneratedContract(value, fences()), { code: 'PIPELINE_CONTRACT_INVALID' });
});

test('enforces every structural and resource maximum without silently clamping', () => {
  assert.equal(CONTRACT_LIMITS.predicates, 16);
  assert.throws(() => validateGeneratedContract(proposal({
    success: { all: Array.from({ length: 17 }, (_, index) => ({ predicate: 'inventory_at_least', item: `item_${index}`, count: 1 })) }
  }), fences()), { code: 'PIPELINE_CONTRACT_INVALID' });
  assert.throws(() => validateGeneratedContract(proposal({ success: { not: { not: { not: { not: { predicate: 'actor_alive' } } } } } }), fences()), { code: 'PIPELINE_CONTRACT_INVALID' });
  for (const [field, value] of [['maximumActions', 41], ['maximumReplans', 6], ['maximumSeconds', 301], ['maximumSearchRadius', 65], ['maximumTravelRadius', 129]]) {
    assert.throws(() => validateGeneratedContract(proposal({ budget: { ...proposal().budget, [field]: value } }), fences()), { code: 'PIPELINE_CONTRACT_INVALID' });
  }
});

test('accepts only a bounded two-or-three-choice question with a safe default', () => {
  const question = { prompt: 'Which shelter?', choices: [{ id: 'hut', label: 'Compact hut' }, { id: 'cave', label: 'Cave shelter' }], defaultChoiceId: 'hut', timeoutSeconds: 30 };
  assert.equal(validateGeneratedContract(proposal({ question }), fences()).question.defaultChoiceId, 'hut');
  assert.throws(() => validateGeneratedContract(proposal({ question: { ...question, choices: [...question.choices, { id: 'tree', label: 'Treehouse' }, { id: 'tower', label: 'Tower' }] } }), fences()), { code: 'PIPELINE_CONTRACT_INVALID' });
  assert.throws(() => validateGeneratedContract(proposal({ question: { ...question, defaultChoiceId: 'missing' } }), fences()), { code: 'PIPELINE_CONTRACT_INVALID' });
  assert.throws(() => validateGeneratedContract(proposal({ question: { ...question, timeoutSeconds: 31 } }), fences()), { code: 'PIPELINE_CONTRACT_INVALID' });
});
