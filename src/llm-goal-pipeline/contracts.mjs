import { resolveCapability, resolveConstraint, resolvePredicate } from './registry.mjs';

export const CONTRACT_LIMITS = Object.freeze({
  predicates: 16, booleanDepth: 3, constraints: 8, capabilities: 8,
  actions: 40, replans: 5, seconds: 300, searchRadius: 64, travelRadius: 128,
  objectiveCharacters: 300, rationaleCharacters: 500, summaryCharacters: 500,
  questionCharacters: 200, choiceLabelCharacters: 80
});

const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,100}$/;

function fail(message) {
  const error = new Error(message);
  error.code = 'PIPELINE_CONTRACT_INVALID';
  throw error;
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(`${label} contains unknown or missing fields`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function text(value, maximum, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || Array.from(value).length > maximum) fail(`${label} is invalid`);
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`${label} is invalid`);
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is invalid`);
  return value;
}

function validateParameter(value, type, label) {
  if (type === 'identifier') identifier(value, label);
  else if (type === 'positive_integer') integer(value, 1, Number.MAX_SAFE_INTEGER, label);
  else if (type === 'nonnegative_integer') integer(value, 0, Number.MAX_SAFE_INTEGER, label);
  else if (type === 'boolean' && typeof value !== 'boolean') fail(`${label} is invalid`);
}

function validateLeaf(value, resolver, label) {
  if (!plain(value) || typeof value[label] !== 'string') fail(`${label} leaf is invalid`);
  let entry;
  try { entry = resolver(value[label]); } catch { fail(`${label} is not registered`); }
  const parameters = entry.parameters ?? {};
  exact(value, [label, ...Object.keys(parameters)], `${label} leaf`);
  for (const [name, type] of Object.entries(parameters)) validateParameter(value[name], type, `${label}.${name}`);
  if ((value.radius ?? 0) > CONTRACT_LIMITS.searchRadius) fail('predicate radius exceeds maximum');
  return clone(value);
}

function validateExpression(value, depth, counter) {
  if (depth > CONTRACT_LIMITS.booleanDepth) fail('Boolean expression is too deep');
  if (!plain(value)) fail('Boolean expression is invalid');
  if (Object.hasOwn(value, 'predicate')) {
    counter.count += 1;
    if (counter.count > CONTRACT_LIMITS.predicates) fail('predicate limit exceeded');
    return validateLeaf(value, resolvePredicate, 'predicate');
  }
  const present = ['all', 'any', 'not'].filter((key) => Object.hasOwn(value, key));
  if (present.length !== 1) fail('Boolean expression must have one operator');
  const operator = present[0];
  exact(value, [operator], 'Boolean expression');
  if (operator === 'not') return { not: validateExpression(value.not, depth + 1, counter) };
  if (!Array.isArray(value[operator]) || value[operator].length === 0 || value[operator].length > CONTRACT_LIMITS.predicates) fail(`${operator} expression is invalid`);
  return { [operator]: value[operator].map((child) => validateExpression(child, depth + 1, counter)) };
}

function uniqueIdentifiers(values, maximum, resolver, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum) fail(`${label} is invalid`);
  const seen = new Set();
  return values.map((value) => {
    identifier(value, label);
    if (seen.has(value)) fail(`${label} contains duplicates`);
    seen.add(value);
    try { resolver(value); } catch { fail(`${label} contains an unknown ID`); }
    return value;
  });
}

function validateConstraints(values) {
  if (!Array.isArray(values) || values.length > CONTRACT_LIMITS.constraints) fail('constraints are invalid');
  const seen = new Set();
  return values.map((value) => {
    const normalized = validateLeaf(value, resolveConstraint, 'rule');
    if (seen.has(normalized.rule)) fail('constraints contain duplicates');
    seen.add(normalized.rule);
    if ((normalized.blocks ?? 0) > CONTRACT_LIMITS.travelRadius) fail('constraint radius exceeds maximum');
    return normalized;
  });
}

function proofKinds(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > CONTRACT_LIMITS.predicates) fail(`${label} is invalid`);
  const seen = new Set();
  return values.map((value) => {
    identifier(value, label);
    if (seen.has(value)) fail(`${label} contains duplicates`);
    seen.add(value);
    return value;
  });
}

function validateQuestion(value) {
  if (value === null) return null;
  exact(value, ['prompt', 'choices', 'defaultChoiceId', 'timeoutSeconds'], 'question');
  text(value.prompt, CONTRACT_LIMITS.questionCharacters, 'question prompt');
  if (!Array.isArray(value.choices) || value.choices.length < 2 || value.choices.length > 3) fail('question choices are invalid');
  const ids = new Set();
  const choices = value.choices.map((choice) => {
    exact(choice, ['id', 'label'], 'question choice');
    identifier(choice.id, 'choice ID');
    text(choice.label, CONTRACT_LIMITS.choiceLabelCharacters, 'choice label');
    if (ids.has(choice.id)) fail('question choice IDs are duplicated');
    ids.add(choice.id);
    return clone(choice);
  });
  if (!ids.has(value.defaultChoiceId)) fail('question default is not a choice');
  integer(value.timeoutSeconds, 1, 30, 'question timeout');
  return { prompt: value.prompt, choices, defaultChoiceId: value.defaultChoiceId, timeoutSeconds: value.timeoutSeconds };
}

export function createContractRequestFences(value) {
  exact(value, ['contractId', 'missionVersion', 'observationVersion', 'predecessorContractId', 'registryVersion', 'now'], 'request fences');
  identifier(value.contractId, 'contract ID');
  integer(value.missionVersion, 1, Number.MAX_SAFE_INTEGER, 'mission version');
  integer(value.observationVersion, 1, Number.MAX_SAFE_INTEGER, 'observation version');
  if (value.predecessorContractId !== null) identifier(value.predecessorContractId, 'predecessor contract ID');
  integer(value.registryVersion, 1, Number.MAX_SAFE_INTEGER, 'registry version');
  if (typeof value.now !== 'string' || !Number.isFinite(Date.parse(value.now))) fail('fence timestamp is invalid');
  return deepFreeze(clone(value));
}

export function validateGeneratedContract(value, requestedFences) {
  const fences = createContractRequestFences(requestedFences);
  exact(value, ['contractId', 'missionVersion', 'predecessor', 'objective', 'rationale', 'prerequisites', 'success', 'constraints', 'capabilities', 'budget', 'expectedOutcome', 'question'], 'contract');
  if (value.contractId !== fences.contractId || value.missionVersion !== fences.missionVersion) fail('contract fences do not match');
  exact(value.predecessor, ['contractId', 'status', 'proofKinds'], 'predecessor');
  if (value.predecessor.contractId !== fences.predecessorContractId || value.predecessor.status !== 'succeeded') fail('predecessor fence does not match');
  const predecessorProofKinds = proofKinds(value.predecessor.proofKinds, 'predecessor proof kinds');
  text(value.objective, CONTRACT_LIMITS.objectiveCharacters, 'objective');
  text(value.rationale, CONTRACT_LIMITS.rationaleCharacters, 'rationale');
  const counter = { count: 0 };
  const prerequisites = validateExpression(value.prerequisites, 1, counter);
  const success = validateExpression(value.success, 1, counter);
  const constraints = validateConstraints(value.constraints);
  const capabilities = uniqueIdentifiers(value.capabilities, CONTRACT_LIMITS.capabilities, resolveCapability, 'capabilities');
  exact(value.budget, ['maximumActions', 'maximumReplans', 'maximumSeconds', 'maximumSearchRadius', 'maximumTravelRadius'], 'budget');
  const budget = {
    maximumActions: integer(value.budget.maximumActions, 1, CONTRACT_LIMITS.actions, 'maximumActions'),
    maximumReplans: integer(value.budget.maximumReplans, 0, CONTRACT_LIMITS.replans, 'maximumReplans'),
    maximumSeconds: integer(value.budget.maximumSeconds, 1, CONTRACT_LIMITS.seconds, 'maximumSeconds'),
    maximumSearchRadius: integer(value.budget.maximumSearchRadius, 1, CONTRACT_LIMITS.searchRadius, 'maximumSearchRadius'),
    maximumTravelRadius: integer(value.budget.maximumTravelRadius, 1, CONTRACT_LIMITS.travelRadius, 'maximumTravelRadius')
  };
  exact(value.expectedOutcome, ['summary', 'proofKinds'], 'expected outcome');
  text(value.expectedOutcome.summary, CONTRACT_LIMITS.summaryCharacters, 'expected outcome summary');
  const expectedProofKinds = proofKinds(value.expectedOutcome.proofKinds, 'expected proof kinds');
  return deepFreeze({
    contractId: value.contractId, missionVersion: value.missionVersion,
    predecessor: { contractId: value.predecessor.contractId, status: 'succeeded', proofKinds: predecessorProofKinds },
    objective: value.objective, rationale: value.rationale, prerequisites, success,
    constraints, capabilities, budget,
    expectedOutcome: { summary: value.expectedOutcome.summary, proofKinds: expectedProofKinds },
    question: validateQuestion(value.question)
  });
}
