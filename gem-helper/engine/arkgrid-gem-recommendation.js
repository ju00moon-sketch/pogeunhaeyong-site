// Generated from src/arkgrid-gem-recommendation.js by scripts/build-gem-helper-modules.mjs; edit the source and rerun.
// Recommendation engine for the gem helper. It maximizes the probability that the gem is completed while it
// meets an explicit target, by exact backward induction over the existing processing model: official weights,
// four distinct offers drawn by weight without replacement, one of them applied uniformly, and the documented
// effect-level interpretation. Refreshes and completion need a first processing. The one-time reset needs a
// processing done and an attempt left, restores the initial gem, and is solved as its own value layer.
// Gold cost is not part of the objective.
import {
  GEM_PROCESSING_MODEL, GEM_PROCESSING_OUTCOMES, GEM_PROCESSING_STARTS, GEM_PROCESSING_SUBTYPES,
} from './data/arkgrid-gem-processing.js';
import { getGemEffectChangeChoices, getGemProcessingCandidates } from './arkgrid-gem-processing.js';

export const GEM_RECOMMENDATION_ENGINE_VERSION = 'target-probability-exact-v1';
export const GEM_RECOMMENDATION_OBJECTIVE = 'probability_target_met_at_completion';
const ASSUMPTIONS = Object.freeze([
  `official-weights-${GEM_PROCESSING_MODEL.probabilityPublishedAt}`,
  'offer-weighted-without-replacement',
  'offered-outcome-uniform',
  'effect-level-preserved-model',
  'refresh-after-first-processing',
  'complete-after-first-processing',
  'reset-needs-processing-and-attempt-left',
  'cost-not-included',
]);

const OFFER_SIZE = GEM_PROCESSING_MODEL.offerCount;
const APPLIED = GEM_PROCESSING_MODEL.offeredOutcomeProbability;
const MIN = GEM_PROCESSING_MODEL.minAxisValue;
const MAX = GEM_PROCESSING_MODEL.maxAxisValue;
const SPAN = MAX - MIN + 1;
const STRIDE = [1, SPAN, SPAN ** 2, SPAN ** 3];
const POINT_STATES = SPAN ** 4;
const SUBTYPE_NAMES = Object.keys(GEM_PROCESSING_SUBTYPES);
const EFFECT_COUNT = GEM_PROCESSING_SUBTYPES[SUBTYPE_NAMES[0]].effects.length;
const OUTCOME_COUNT = GEM_PROCESSING_OUTCOMES.length;
const KINDS = new Set(['axis', 'cost', 'reroll', 'effect', 'unchanged']);
if (OFFER_SIZE !== 4 || APPLIED !== 1 / OFFER_SIZE || OUTCOME_COUNT > 31
  || SUBTYPE_NAMES.some(name => GEM_PROCESSING_SUBTYPES[name].effects.length !== EFFECT_COUNT)
  || GEM_PROCESSING_OUTCOMES.some(outcome => !KINDS.has(outcome.kind))) {
  throw new Error('Unsupported gem processing model for the recommendation engine');
}
const OUTCOME_INDEX = new Map(GEM_PROCESSING_OUTCOMES.map((outcome, index) => [outcome.id, index]));

const PAIRS = [];
for (let a = 0; a < EFFECT_COUNT; a++) for (let b = a + 1; b < EFFECT_COUNT; b++) PAIRS.push([a, b]);
const PAIR_COUNT = PAIRS.length;
const PAIR_OF = new Int8Array(EFFECT_COUNT * EFFECT_COUNT).fill(-1);
PAIRS.forEach(([a, b], pair) => { PAIR_OF[a * EFFECT_COUNT + b] = pair; PAIR_OF[b * EFFECT_COUNT + a] = pair; });

const VERIFIED_STARTS = Object.entries(GEM_PROCESSING_STARTS).filter(([, start]) => Number.isSafeInteger(start.attempts));
const [PROBE_GRADE, PROBE_START] = VERIFIED_STARTS.reduce((best, entry) => (entry[1].attempts > best[1].attempts ? entry : best));
const MAX_ATTEMPTS = PROBE_START.attempts;
const REROLL_GAIN = Math.max(0, ...GEM_PROCESSING_OUTCOMES.filter(outcome => outcome.kind === 'reroll').map(outcome => outcome.delta));
// The last processing cannot add refreshes, so a state with an attempt left holds at most this many.
const MAX_REROLLS = Math.max(...VERIFIED_STARTS.map(([, start]) => start.rerolls + REROLL_GAIN * (start.attempts - 1)));
const COST_DELTAS = GEM_PROCESSING_OUTCOMES.filter(outcome => outcome.kind === 'cost').map(outcome => outcome.delta);
const COST_MIN = Math.min(0, ...COST_DELTAS);
const COST_SPAN = Math.max(0, ...COST_DELTAS) - COST_MIN + 1;
const REROLL_SPAN = MAX_REROLLS + 1;
// Memo cells cover states after the first processing with an attempt left.
const MEMO_SIZE = POINT_STATES * PAIR_COUNT * COST_SPAN * MAX_ATTEMPTS * REROLL_SPAN;
export const GEM_RECOMMENDATION_MEMO_LIMIT_BYTES = 2 * MEMO_SIZE * Float64Array.BYTES_PER_ELEMENT;

const encodePoints = (a, b, c, d) => (a - MIN) + (b - MIN) * STRIDE[1] + (c - MIN) * STRIDE[2] + (d - MIN) * STRIDE[3];
const POINTS = new Int8Array(POINT_STATES * 4);
const SWAPPED_POINTS = new Int16Array(POINT_STATES);
for (let pi = 0; pi < POINT_STATES; pi++) {
  const values = STRIDE.map(stride => Math.floor(pi / stride) % SPAN + MIN);
  POINTS.set(values, pi * 4);
  SWAPPED_POINTS[pi] = encodePoints(values[0], values[1], values[3], values[2]);
}
const START_POINTS = encodePoints(...new Array(4).fill(GEM_PROCESSING_MODEL.initialAxisValue));

// Product states used to read eligibility and effect-change choices from the processing module.
const PROBE_SUBTYPE = SUBTYPE_NAMES[0];
const PROBE_EFFECTS = GEM_PROCESSING_SUBTYPES[PROBE_SUBTYPE].effects;
const probeState = (points, effects, costModifier, remaining) => ({
  grade: PROBE_GRADE, subtype: PROBE_SUBTYPE, effects, points, costModifier,
  totalAttempts: MAX_ATTEMPTS, processedCount: MAX_ATTEMPTS - remaining, remainingAttempts: remaining, rerollsRemaining: 0,
});

// Same outcome with the two effect rows exchanged (axis2/axis3, effect0/effect1).
const SWAP_OUTCOME = GEM_PROCESSING_OUTCOMES.map(outcome => {
  const swapped = outcome.kind === 'axis' && outcome.axis >= 2 ? { ...outcome, axis: 5 - outcome.axis }
    : outcome.kind === 'effect' ? { ...outcome, effectIndex: 1 - outcome.effectIndex } : outcome;
  const index = GEM_PROCESSING_OUTCOMES.findIndex(candidate => candidate.kind === swapped.kind && candidate.axis === swapped.axis
    && candidate.delta === swapped.delta && candidate.effectIndex === swapped.effectIndex);
  if (index < 0) throw new Error('Gem outcome without a row-exchanged counterpart');
  return index;
});

// Successors of every outcome per canonical effect pair (rows sorted by subtype effect order).
// A changed effect keeps its row level; a branch that breaks the row order swaps the two levels.
const SUCCESSORS = [];
for (let pair = 0; pair < PAIR_COUNT; pair++) {
  const [a, b] = PAIRS[pair];
  for (const outcome of GEM_PROCESSING_OUTCOMES) {
    if (outcome.kind === 'effect') {
      const choices = getGemEffectChangeChoices(probeState([MIN, MIN, MIN, MIN], [PROBE_EFFECTS[a], PROBE_EFFECTS[b]], 0, 2), outcome.effectIndex);
      if (choices.status !== 'ok') throw new Error('Gem effect change probe failed');
      SUCCESSORS.push(choices.choices.map(({ effect, probability }) => {
        const rows = outcome.effectIndex === 0 ? [PROBE_EFFECTS.indexOf(effect), b] : [a, PROBE_EFFECTS.indexOf(effect)];
        return { step: 0, swap: rows[0] > rows[1], pair: PAIR_OF[rows[0] * EFFECT_COUNT + rows[1]], cost: 0, rerolls: 0, probability };
      }));
    } else {
      SUCCESSORS.push([{
        step: outcome.kind === 'axis' ? outcome.delta * STRIDE[outcome.axis] : 0, swap: false, pair,
        cost: outcome.kind === 'cost' ? outcome.delta : 0, rerolls: outcome.kind === 'reroll' ? outcome.delta : 0, probability: 1,
      }]);
    }
  }
}

// Probability of one particular set of four distinct outcomes, drawn by weight without replacement in any
// order (the definition calculateWeightedOfferMarginals sums). It depends only on the four weights and the
// eligible total, so outcomes are grouped by weight class and a 4-multiset is coded by base-5 class counts.
const CLASS_WEIGHTS = [...new Set(GEM_PROCESSING_OUTCOMES.map(outcome => outcome.weight))].sort((x, y) => x - y);
const CLASS_CODE = GEM_PROCESSING_OUTCOMES.map(outcome => 5 ** CLASS_WEIGHTS.indexOf(outcome.weight));
const MULTISET_OF = new Int16Array(5 ** CLASS_WEIGHTS.length).fill(-1);
const MULTISETS = [];
for (let a = 0; a < CLASS_WEIGHTS.length; a++) for (let b = a; b < CLASS_WEIGHTS.length; b++)
  for (let c = b; c < CLASS_WEIGHTS.length; c++) for (let d = c; d < CLASS_WEIGHTS.length; d++) {
    MULTISET_OF[5 ** a + 5 ** b + 5 ** c + 5 ** d] = MULTISETS.length;
    MULTISETS.push([a, b, c, d].map(index => CLASS_WEIGHTS[index]));
  }
const ORDERS = [];
(function permute(prefix, rest) {
  if (!rest.length) ORDERS.push(prefix);
  else rest.forEach((item, index) => permute([...prefix, item], rest.filter((_, other) => other !== index)));
})([], [0, 1, 2, 3]);
const SUBSET_TABLES = new Map();
function subsetTable(totalWeight) {
  let table = SUBSET_TABLES.get(totalWeight);
  if (!table) {
    table = new Float64Array(MULTISETS.length);
    MULTISETS.forEach((weights, index) => {
      let sum = 0;
      for (const order of ORDERS) {
        let probability = 1, used = 0;
        for (const k of order) { probability *= weights[k] / (totalWeight - used); used += weights[k]; }
        sum += probability;
      }
      table[index] = sum;
    });
    SUBSET_TABLES.set(totalWeight, table);
  }
  return table;
}
const COMBOS = [];
function combosOf(n) {
  if (!COMBOS[n]) {
    const list = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) list.push(a, b, c, d);
    COMBOS[n] = Uint8Array.from(list);
  }
  return COMBOS[n];
}

// Eligible outcomes per (points, cost, last attempt or not), read from getGemProcessingCandidates.
const ENTRIES = new Array(POINT_STATES * COST_SPAN * 2);
function entryOf(pi, cost, remaining) {
  const slot = (pi * COST_SPAN + cost - COST_MIN) * 2 + (remaining > 1 ? 1 : 0);
  if (!ENTRIES[slot]) {
    const pool = getGemProcessingCandidates(probeState(Array.from(POINTS.subarray(pi * 4, pi * 4 + 4)),
      [PROBE_EFFECTS[0], PROBE_EFFECTS[1]], cost, remaining > 1 ? 2 : 1));
    if (pool.status !== 'ok' || pool.candidates.length < OFFER_SIZE) throw new Error('Gem eligibility probe failed');
    const outcomes = Uint8Array.from(pool.candidates, candidate => OUTCOME_INDEX.get(candidate.id));
    ENTRIES[slot] = { outcomes, codes: Int32Array.from(outcomes, index => CLASS_CODE[index]), totalWeight: pool.totalWeight, inclusion: null };
  }
  return ENTRIES[slot];
}
function inclusionOf(entry) {
  if (!entry.inclusion) {
    const n = entry.outcomes.length, combos = combosOf(n), table = subsetTable(entry.totalWeight), codes = entry.codes;
    const inclusion = new Float64Array(n);
    for (let s = 0; s < combos.length; s += 4) {
      const a = combos[s], b = combos[s + 1], c = combos[s + 2], d = combos[s + 3];
      const probability = table[MULTISET_OF[codes[a] + codes[b] + codes[c] + codes[d]]];
      inclusion[a] += probability; inclusion[b] += probability; inclusion[c] += probability; inclusion[d] += probability;
    }
    entry.inclusion = inclusion;
  }
  return entry.inclusion;
}

// One value layer: resetValue is null when no reset can be used, otherwise the value of resetting now.
class ValueLayer {
  constructor(memo, success, resetValue) {
    this.memo = memo;
    this.success = success;
    this.resetValue = resetValue;
  }

  // Probability of meeting the target before an offer is drawn. started = at least one processing done.
  value(pi, pair, cost, remaining, rerolls, started) {
    let key = -1;
    if (started) {
      if (this.success[pi * PAIR_COUNT + pair] === 1) return 1;
      if (remaining === 0) return 0;
      if (rerolls > MAX_REROLLS) throw new RangeError('Refresh count outside the processing model');
      key = (((pi * PAIR_COUNT + pair) * COST_SPAN + cost - COST_MIN) * MAX_ATTEMPTS + remaining - 1) * REROLL_SPAN + rerolls;
      const known = this.memo[key];
      if (known === known) return known;
    }
    const entry = entryOf(pi, cost, remaining), outcomes = entry.outcomes, n = outcomes.length;
    const values = new Float64Array(n);
    for (let j = 0; j < n; j++) values[j] = this.outcome(pi, pair, cost, remaining, rerolls, outcomes[j]);
    // Offer-independent alternatives: a refresh or the reset (never before the first processing).
    let alternative = 0;
    if (started) {
      if (rerolls > 0) alternative = this.value(pi, pair, cost, remaining, rerolls - 1, true);
      if (this.resetValue !== null && this.resetValue > alternative) alternative = this.resetValue;
    }
    // When every offer is decided the same way, skip enumerating the offers.
    const sorted = values.slice().sort();
    const lowest = (sorted[0] + sorted[1] + sorted[2] + sorted[3]) * APPLIED;
    const highest = (sorted[n - 1] + sorted[n - 2] + sorted[n - 3] + sorted[n - 4]) * APPLIED;
    let result;
    if (highest <= alternative) result = alternative;
    else if (lowest >= alternative) {
      const inclusion = inclusionOf(entry);
      let sum = 0;
      for (let j = 0; j < n; j++) sum += inclusion[j] * values[j];
      result = sum * APPLIED;
    } else {
      const combos = combosOf(n), table = subsetTable(entry.totalWeight), codes = entry.codes;
      let sum = 0;
      for (let s = 0; s < combos.length; s += 4) {
        const a = combos[s], b = combos[s + 1], c = combos[s + 2], d = combos[s + 3];
        const processing = (values[a] + values[b] + values[c] + values[d]) * APPLIED;
        sum += table[MULTISET_OF[codes[a] + codes[b] + codes[c] + codes[d]]] * (processing > alternative ? processing : alternative);
      }
      result = sum;
    }
    if (key >= 0) this.memo[key] = result;
    return result;
  }

  outcome(pi, pair, cost, remaining, rerolls, index) {
    const branches = SUCCESSORS[pair * OUTCOME_COUNT + index];
    let sum = 0;
    for (let k = 0; k < branches.length; k++) {
      const branch = branches[k];
      sum += branch.probability * this.value((branch.swap ? SWAPPED_POINTS[pi] : pi) + branch.step, branch.pair,
        cost + branch.cost, remaining - 1, rerolls + branch.rerolls, true);
    }
    return sum;
  }

  offer(state, offer) {
    let sum = 0;
    for (const index of offer) sum += this.outcome(state.pi, state.pair, state.cost, state.remaining, state.rerolls, index);
    return sum * APPLIED;
  }
}

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const onlyFields = (value, fields) => Object.keys(value).every(key => fields.has(key));
const validPair = (names, effects) => Array.isArray(effects) && effects.length === 2 && effects[0] !== effects[1]
  && effects.every(effect => typeof effect === 'string' && names.includes(effect));

const TARGET_FIELDS = new Set(['anyOf']);
const CLAUSE_FIELDS = new Set(['willpowerEfficiencyAtLeast', 'corePointsAtLeast', 'totalPointsAtLeast', 'effects']);
const EFFECT_FIELDS = new Set(['name', 'levelAtLeast']);
const CLAUSE_LIMIT = 25;
const AXIS_FIELDS = [['willpowerEfficiencyAtLeast', MIN, MAX], ['corePointsAtLeast', MIN, MAX], ['totalPointsAtLeast', 4 * MIN, 4 * MAX]];

// Validates and normalizes the common target DTO for a subtype. Equivalent targets (clause or effect order,
// repeated clauses) share one normalized form and key.
export function normalizeGemTarget(target, subtype) {
  const invalid = reason => ({ status: 'invalid_target', reason });
  if (typeof subtype !== 'string' || !Object.hasOwn(GEM_PROCESSING_SUBTYPES, subtype)) return invalid('unknown_subtype');
  if (!plainObject(target) || !onlyFields(target, TARGET_FIELDS) || !Array.isArray(target.anyOf)
    || target.anyOf.length < 1 || target.anyOf.length > CLAUSE_LIMIT) return invalid('any_of');
  const names = GEM_PROCESSING_SUBTYPES[subtype].effects;
  const clauses = new Map();
  for (const clause of target.anyOf) {
    if (!plainObject(clause) || !onlyFields(clause, CLAUSE_FIELDS)) return invalid('clause_fields');
    const normalized = {};
    for (const [field, min, max] of AXIS_FIELDS) {
      if (clause[field] === undefined) continue;
      if (!integer(clause[field], min, max)) return invalid('clause_range');
      normalized[field] = clause[field];
    }
    const effects = clause.effects === undefined ? [] : clause.effects;
    if (!Array.isArray(effects) || effects.length > 2) return invalid('effects');
    const list = [];
    for (const effect of effects) {
      if (!plainObject(effect) || !onlyFields(effect, EFFECT_FIELDS) || typeof effect.name !== 'string'
        || !integer(effect.levelAtLeast, MIN, MAX)) return invalid('effect_fields');
      if (!names.includes(effect.name)) return invalid('effect_not_in_subtype');
      if (list.some(other => other.name === effect.name)) return invalid('duplicate_effect');
      list.push({ name: effect.name, levelAtLeast: effect.levelAtLeast });
    }
    if (!list.length && !Object.keys(normalized).length) return invalid('empty_clause');
    normalized.effects = list.sort((x, y) => names.indexOf(x.name) - names.indexOf(y.name));
    clauses.set(JSON.stringify(normalized), normalized);
  }
  const anyOf = [...clauses.keys()].sort().map(key => clauses.get(key));
  return { status: 'ok', target: { anyOf }, key: JSON.stringify(anyOf) };
}

function successTable(subtype, target) {
  const names = GEM_PROCESSING_SUBTYPES[subtype].effects;
  const clauses = target.anyOf.map(clause => ({
    willpower: clause.willpowerEfficiencyAtLeast ?? MIN, core: clause.corePointsAtLeast ?? MIN, total: clause.totalPointsAtLeast ?? 0,
    effects: clause.effects.map(effect => [names.indexOf(effect.name), effect.levelAtLeast]),
  }));
  const table = new Uint8Array(POINT_STATES * PAIR_COUNT);
  for (let pi = 0; pi < POINT_STATES; pi++) {
    const w = POINTS[pi * 4], core = POINTS[pi * 4 + 1], first = POINTS[pi * 4 + 2], second = POINTS[pi * 4 + 3];
    for (let pair = 0; pair < PAIR_COUNT; pair++) {
      const [a, b] = PAIRS[pair];
      table[pi * PAIR_COUNT + pair] = clauses.some(clause => w >= clause.willpower && core >= clause.core
        && w + core + first + second >= clause.total
        && clause.effects.every(([effect, level]) => (effect === a ? first : effect === b ? second : 0) >= level)) ? 1 : 0;
    }
  }
  return table;
}

// Canonical form of a product state: effect rows sorted by subtype effect order, levels swapped with them.
function canonicalState(core) {
  const names = GEM_PROCESSING_SUBTYPES[core.subtype].effects;
  const first = names.indexOf(core.effects[0]), second = names.indexOf(core.effects[1]), flip = first > second;
  const [w, c, x, y] = core.points;
  return {
    pi: flip ? encodePoints(w, c, y, x) : encodePoints(w, c, x, y), pair: PAIR_OF[first * EFFECT_COUNT + second], flip,
    cost: core.costModifier, remaining: core.remainingAttempts, rerolls: core.rerollsRemaining,
  };
}

const INPUT_FIELDS = new Set(['modelVersion', 'target', 'state', 'offer']);
const STATE_FIELDS = new Set(['grade', 'subtype', 'effects', 'points', 'totalAttempts', 'processedCount', 'remainingAttempts',
  'rerollsRemaining', 'costModifier', 'resetAvailable', 'initialEffects']);

function closed(status, reason) {
  return {
    status, reason, engineVersion: GEM_RECOMMENDATION_ENGINE_VERSION, modelVersion: GEM_PROCESSING_MODEL.version,
    objective: GEM_RECOMMENDATION_OBJECTIVE, targetMet: null, reachableOnCurrentGem: null, values: null, unavailable: null,
    recommendation: null, fromFreshGem: null, assumptions: [...ASSUMPTIONS],
  };
}
export function cancelledGemRecommendation() {
  return closed('cancelled', 'superseded_generation');
}

function readState(state) {
  if (!plainObject(state) || !onlyFields(state, STATE_FIELDS)) return 'state_fields';
  const { resetAvailable, initialEffects, ...core } = state;
  const pool = getGemProcessingCandidates(core);
  if (pool.status !== 'ok' && pool.status !== 'complete') return 'processing_state';
  if (typeof resetAvailable !== 'boolean') return 'reset_available';
  const names = GEM_PROCESSING_SUBTYPES[core.subtype].effects;
  let initial = null;
  if (initialEffects !== null) {
    if (!validPair(names, initialEffects)) return 'initial_effects';
    initial = initialEffects;
  }
  if (core.processedCount === 0) {
    // Before the first processing the current effects are the initial effects.
    if (initial && !initial.every(effect => core.effects.includes(effect))) return 'initial_effects_mismatch';
    initial = core.effects;
  }
  return {
    ...canonicalState(core), grade: core.grade, subtype: core.subtype, started: core.processedCount > 0, resetAvailable,
    initialPair: initial ? PAIR_OF[names.indexOf(initial[0]) * EFFECT_COUNT + names.indexOf(initial[1])] : null,
    eligible: new Set(pool.candidates.map(candidate => candidate.id)),
  };
}

function readOffer(offer, state) {
  if (!Array.isArray(offer) || offer.length !== OFFER_SIZE) return 'offer_shape';
  const indices = [];
  for (const id of offer) {
    if (typeof id !== 'string' || !state.eligible.has(id)) return 'ineligible_outcome';
    const index = OUTCOME_INDEX.get(id);
    const canonical = state.flip ? SWAP_OUTCOME[index] : index;
    if (indices.includes(canonical)) return 'duplicate_outcome';
    indices.push(canonical);
  }
  return indices;
}

const ACTIONS = ['complete', 'reroll', 'reset', 'process'];
const TIE_TOLERANCE = 1e-9;

// Deterministic choice among the available actions. Ties go to the free refresh, then the reset, then processing.
// A gem that cannot reach the target without the reset takes the reset; when nothing can reach it, complete.
function decide(values, reachable) {
  const available = ACTIONS.filter(action => values[action] !== null);
  const best = Math.max(...available.map(action => values[action]));
  const tied = available.filter(action => values[action] >= best - best * TIE_TOLERANCE);
  const others = available.filter(action => !tied.includes(action)).map(action => values[action]);
  const margin = others.length ? best - Math.max(...others) : null;
  if (best === 0) return { action: 'complete', reason: 'target_unreachable_on_gem', tied, margin };
  if (!reachable && tied.includes('reset')) return { action: 'reset', reason: 'target_unreachable_on_gem', tied, margin };
  return { action: tied.find(action => action !== 'complete'), reason: 'higher_probability', tied, margin };
}

export function createGemRecommendationEngine() {
  let context = null;
  const spare = [];
  const takeMemo = () => (spare.pop() ?? new Float64Array(MEMO_SIZE)).fill(NaN);

  function release() {
    if (!context) return;
    spare.push(context.base.memo);
    if (context.reset) spare.push(context.reset.memo);
    context = null;
  }
  // One target cache: the no-reset layer for the target and at most one reset layer (grade, initial effects).
  function targetContext(subtype, target) {
    const key = `${subtype}|${target.key}`;
    if (context?.key !== key) {
      release();
      const success = successTable(subtype, target.target);
      context = { key, success, base: new ValueLayer(takeMemo(), success, null), resetKey: null, reset: null, fresh: new Map() };
    }
    return context;
  }
  function freshValue(layer, grade, pair) {
    const start = GEM_PROCESSING_STARTS[grade];
    return layer.value(START_POINTS, pair, 0, start.attempts, start.rerolls, false);
  }
  function baseFresh(grade, pair) {
    const key = `base|${grade}|${pair}`;
    if (!context.fresh.has(key)) context.fresh.set(key, freshValue(context.base, grade, pair));
    return context.fresh.get(key);
  }
  function resetLayer(grade, pair) {
    const key = `${grade}|${pair}`;
    if (context.resetKey !== key) {
      const resetValue = baseFresh(grade, pair);
      if (context.reset) spare.push(context.reset.memo);
      context.reset = new ValueLayer(takeMemo(), context.success, resetValue);
      context.resetKey = key;
    }
    return context.reset;
  }
  function resetFresh(grade, pair) {
    const key = `reset|${grade}|${pair}`;
    if (!context.fresh.has(key)) context.fresh.set(key, freshValue(resetLayer(grade, pair), grade, pair));
    return context.fresh.get(key);
  }

  function recommend(input) {
    if (!plainObject(input) || !onlyFields(input, INPUT_FIELDS)) return closed('invalid_state', 'input_fields');
    if (input.modelVersion !== GEM_PROCESSING_MODEL.version) return closed('model_mismatch', 'model_version');
    const state = readState(input.state);
    if (typeof state === 'string') return closed('invalid_state', state);
    const target = normalizeGemTarget(input.target, state.subtype);
    if (target.status !== 'ok') return closed('invalid_target', target.reason);
    let offer = null;
    if (input.offer !== null && input.offer !== undefined) {
      offer = readOffer(input.offer, state);
      if (typeof offer === 'string') return closed('invalid_offer', offer);
    }
    const ctx = targetContext(state.subtype, target);
    const targetMet = ctx.success[state.pi * PAIR_COUNT + state.pair] === 1;
    const terminal = state.started && (targetMet || state.remaining === 0);
    if (state.started && !terminal) {
      if (!offer) return closed('offer_required', 'offer_missing');
      if (state.resetAvailable && state.initialPair === null) return closed('initial_effects_required', 'initial_effects_unknown');
    }
    const resetIncluded = state.resetAvailable && state.remaining > 0 && !terminal;
    const layer = resetIncluded ? resetLayer(state.grade, state.initialPair) : ctx.base;
    const fromFreshGem = state.initialPair === null ? null : {
      noReset: baseFresh(state.grade, state.initialPair),
      withReset: state.resetAvailable ? resetFresh(state.grade, state.initialPair) : null,
    };
    const values = { process: null, reroll: null, complete: null, reset: null };
    const unavailable = {};
    let recommendation, reachable;
    if (terminal) {
      values.complete = targetMet ? 1 : 0;
      const why = targetMet ? 'target_met' : 'out_of_attempts';
      unavailable.process = why; unavailable.reroll = why; unavailable.reset = why;
      recommendation = { action: 'complete', reason: why, tied: ['complete'], margin: null };
      reachable = targetMet;
    } else if (!state.started) {
      if (offer) values.process = layer.offer(state, offer);
      else unavailable.process = 'offer_not_observed';
      unavailable.reroll = 'before_first_processing'; unavailable.complete = 'before_first_processing'; unavailable.reset = 'before_first_processing';
      recommendation = { action: 'process', reason: 'before_first_processing', tied: ['process'], margin: null };
      // Before the first processing the current gem is the initial gem.
      reachable = (offer ? ctx.base.offer(state, offer) : fromFreshGem.noReset) > 0;
    } else {
      values.process = layer.offer(state, offer);
      values.complete = 0;
      if (state.rerolls > 0) values.reroll = layer.value(state.pi, state.pair, state.cost, state.remaining, state.rerolls - 1, true);
      else unavailable.reroll = 'no_rerolls';
      if (resetIncluded) values.reset = layer.resetValue;
      else unavailable.reset = 'reset_unavailable';
      reachable = (resetIncluded ? ctx.base.offer(state, offer) : values.process) > 0 || (state.rerolls > 0
        && (resetIncluded ? ctx.base.value(state.pi, state.pair, state.cost, state.remaining, state.rerolls - 1, true) : values.reroll) > 0);
      recommendation = decide(values, reachable);
    }
    return {
      status: 'ok', engineVersion: GEM_RECOMMENDATION_ENGINE_VERSION, modelVersion: GEM_PROCESSING_MODEL.version,
      objective: GEM_RECOMMENDATION_OBJECTIVE, targetMet, reachableOnCurrentGem: reachable, values, unavailable, recommendation,
      fromFreshGem, assumptions: [...ASSUMPTIONS, resetIncluded ? 'reset-included' : 'reset-not-included'],
    };
  }

  return {
    recommend,
    // Typed memo currently held (live layers and released arrays kept for reuse); at most two layers.
    memoryBytes: () => ((context ? 1 + Number(Boolean(context.reset)) : 0) + spare.length) * MEMO_SIZE * Float64Array.BYTES_PER_ELEMENT,
    clear() { release(); spare.length = 0; },
  };
}

// Engine-side transition and offer tables, exposed for equivalence checks against the processing module.
export const __test = Object.freeze({
  canonicalState(core) {
    const { pi, pair, cost, rerolls } = canonicalState(core);
    return { points: pi, pair, cost, rerolls };
  },
  successors(core, outcomeId) {
    const { pi, pair, cost, flip } = canonicalState(core);
    const index = flip ? SWAP_OUTCOME[OUTCOME_INDEX.get(outcomeId)] : OUTCOME_INDEX.get(outcomeId);
    return SUCCESSORS[pair * OUTCOME_COUNT + index].map(branch => ({
      points: (branch.swap ? SWAPPED_POINTS[pi] : pi) + branch.step, pair: branch.pair, cost: cost + branch.cost,
      rerollDelta: branch.rerolls, probability: branch.probability,
    }));
  },
  offerInclusion(core) {
    const { pi, cost, remaining, flip } = canonicalState(core);
    const entry = entryOf(pi, cost, remaining), inclusion = inclusionOf(entry);
    return Array.from(entry.outcomes, (index, j) => ({
      id: GEM_PROCESSING_OUTCOMES[flip ? SWAP_OUTCOME[index] : index].id, inclusionProbability: inclusion[j],
    }));
  },
});
