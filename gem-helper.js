// Controller for gem-helper.html: screen/image source, region alignment, the reading loop, state tracking,
// both target modes and the recommendation worker. Screen data never leaves this page.
import {
  REFERENCE_LAYOUT, VALUE_REGIONS, fieldParsers, interpretReading, stateFromFields, checkState, checkOffers,
  inferTransition, offerToOutcomeId, describeOutcome, describeOffer, deriveRegions, clampBox, buildTarget, isCurrentResult,
} from './gem-screen.js';
import {
  LIMITS, createOcr, createCapture, readWindow, regionSignature, signatureDistance, signatureSpread,
  videoSource, bitmapSource, loadImageFile,
} from './gem-capture.js';

const COPY = (await import('./gem-helper-copy.js').catch(() => ({ default: {} }))).default ?? {};
// Missing copy shows its ID so integration review sees the gap instead of invented text.
const t = (id, params) => {
  const text = COPY[id];
  if (typeof text !== 'string') return id;
  return params ? text.replace(/\{(\w+)\}/g, (match, key) => (params[key] ?? match)) : text;
};

const loaded = await Promise.all([
  import('./gem-helper/engine/arkgrid-gem-processing.js'),
  import('./gem-helper/engine/data/arkgrid-gem-processing.js'),
]).catch(() => null);
const engine = loaded?.[0] ?? null;
const model = loaded ? {
  SUBTYPES: loaded[1].GEM_PROCESSING_SUBTYPES, STARTS: loaded[1].GEM_PROCESSING_STARTS, VERSION: loaded[1].GEM_PROCESSING_MODEL.version,
} : null;
const parsers = model ? fieldParsers(model) : null;

const $ = id => document.getElementById(id);
const ui = {
  status: $('gem-status'), share: $('gem-share'), shareStop: $('gem-share-stop'), alignEdit: $('gem-align-edit'),
  image: $('gem-image'), imageClear: $('gem-image-clear'), sourceState: $('gem-source-state'),
  stage: $('gem-stage'), video: $('gem-video'), still: $('gem-still'), overlay: $('gem-overlay'),
  align: $('gem-align'), alignNeeded: $('gem-align-needed'), alignApply: $('gem-align-apply'), alignCancel: $('gem-align-cancel'), alignReset: $('gem-align-reset'),
  recChip: $('gem-rec-chip'), recAction: $('gem-rec-action'), recReason: $('gem-rec-reason'), recDetail: $('gem-rec-detail'),
  recValues: $('gem-rec-values'), recMargin: $('gem-rec-margin'), recResetNote: $('gem-rec-reset-note'), recAssumptions: $('gem-rec-assumptions'),
  modeAuto: $('gem-mode-auto'), modeManual: $('gem-mode-manual'), auto: $('gem-auto'), autoStatus: $('gem-auto-status'),
  autoControls: $('gem-auto-controls'), character: $('gem-character'), autoRefresh: $('gem-auto-refresh'), autoChecked: $('gem-auto-checked'),
  autoCandidates: $('gem-auto-candidates'), autoCandidateList: $('gem-auto-candidate-list'), autoUse: $('gem-auto-use'), autoCopy: $('gem-auto-copy'),
  manual: $('gem-manual'), manualGem: $('gem-manual-gem'), clauses: $('gem-clauses'), clauseAdd: $('gem-clause-add'), manualStatus: $('gem-manual-status'),
  stateNote: $('gem-state-note'), stateIssue: $('gem-state-issue'), applied: $('gem-applied'), appliedOptions: $('gem-applied-options'),
  appliedEffect: $('gem-applied-effect'), appliedEffectSelect: $('gem-applied-effect-select'), appliedConfirm: $('gem-applied-confirm'),
  change: $('gem-change'), changeReset: $('gem-change-reset'), changeNew: $('gem-change-new'),
  form: $('gem-state-form'), subtype: $('gem-f-subtype'), grade: $('gem-f-grade'), willpower: $('gem-f-willpower'), points: $('gem-f-points'),
  pointsLabel: $('gem-f-points-label'), effect1: $('gem-f-effect1'), level1: $('gem-f-level1'), effect2: $('gem-f-effect2'), level2: $('gem-f-level2'),
  remaining: $('gem-f-remaining'), rerolls: $('gem-f-rerolls'), cost: $('gem-f-cost'), initial1: $('gem-f-initial1'), initial2: $('gem-f-initial2'),
  pointsCheck: $('gem-points-check'), stateConfirm: $('gem-state-confirm'), offerRow: $('gem-offer-row'), offerIssue: $('gem-offer-issue'),
};

const EDITABLE = ['anchor', 'gemName', 'gemPoints', 'offers', 'rerolls', 'cost', 'attempts'];
const REQUIRED = ['anchor', 'offers', 'attempts', ...VALUE_REGIONS];
const REGION_COPY = { anchor: 'gem.align.cluster', gemName: 'gem.align.gemName', gemPoints: 'gem.align.gemPoints', offers: 'gem.align.offersRow', rerolls: 'gem.align.rerolls', cost: 'gem.align.cost', attempts: 'gem.align.attempts' };
const ANCHOR_RATIO = REFERENCE_LAYOUT.anchor[2] / REFERENCE_LAYOUT.anchor[3];
const FAMILY_KEYS = Object.freeze({ 질서: 'order', 혼돈: 'chaos' });
const ACTIONS = ['process', 'reroll', 'complete', 'reset'];
const ENGINE_STATUSES = ['invalid_state', 'invalid_target', 'invalid_offer', 'offer_required', 'model_mismatch', 'initial_effects_required'];
const ACTION_COPY = { process: 'gem.rec.action.process', reroll: 'gem.rec.action.reroll', complete: 'gem.rec.action.complete', reset: 'gem.rec.action.reset' };
const CAPTURE_COPY = { requesting: 'gem.capture.requesting', active: 'gem.capture.active', selfSurface: 'gem.capture.selfSurface', denied: 'gem.capture.denied', failed: 'gem.capture.failed', ended: 'gem.capture.ended', unsupported: 'gem.capture.unsupported', framed: 'gem.capture.framed' };
const IMAGE_ERROR_COPY = { size: 'gem.image.tooLarge', pixels: 'gem.image.tooManyPixels', type: 'gem.image.rejectedType', decode: 'gem.image.decodeFailed' };
const CHIP_COPY = { ok: 'gem.review.confirmed', review: 'gem.review.needsReview', unread: 'gem.review.unread', inferred: 'gem.review.inferred', fixed: 'gem.review.fix', family: 'gem.review.needsReview', effect: 'gem.review.needsReview' };
const BLOCKER_COPY = { engine: 'gem.rec.engineFailed', state: 'gem.rec.blocked.state', conflict: 'gem.rec.blocked.conflict', frame: 'gem.rec.blocked.frame', read: 'gem.rec.blocked.read', target: 'gem.rec.blocked.target' };
const OFFER_ISSUE_COPY = { duplicate: 'gem.read.conflict.duplicate', unavailable: 'gem.read.conflict.unavailable', family: 'gem.read.conflict.family', effect: 'gem.read.conflict.effect' };
const AUTO_COPY = {
  staticHost: 'gem.target.auto.staticHost', checking: 'gem.target.auto.checking', loginRequired: 'gem.target.auto.loginRequired',
  approvalRequired: 'gem.target.auto.approvalRequired', ownershipRequired: 'gem.target.auto.ownershipRequired', loading: 'gem.target.auto.loading',
  unavailable: 'gem.target.auto.unavailable', rateLimited: 'gem.target.auto.reason.rateLimited', officialUnavailable: 'gem.target.auto.officialUnavailable',
  notFound: 'gem.target.auto.notFound', changed: 'gem.target.auto.changed', gridEmpty: 'gem.target.auto.gridEmpty', gridUnreadable: 'gem.target.auto.gridUnreadable',
  maxReached: 'gem.target.auto.maxReached', noUpgrade: 'gem.target.auto.noUpgrade', noGoalForGem: 'gem.target.auto.noGoalForGem',
  needsGem: 'gem.target.auto.needsGem', gemMismatch: 'gem.target.auto.gemMismatch', roleUnknown: 'gem.target.auto.roleUnknown',
};
// Goal entry reasons from the server (web/src/gem-helper-targets.js) to the status above.
const AUTO_REASONS = Object.freeze({
  grid_unreadable: 'gridUnreadable', cores_unverified: 'gridUnreadable', grid_empty: 'gridEmpty', family_core_missing: 'noGoalForGem',
  role_unknown: 'roleUnknown', effects_maxed: 'maxReached', no_same_subtype_gem: 'noUpgrade',
});
const FIELD_KEYS = { 'gem-f-subtype': 'subtype', 'gem-f-grade': 'grade', 'gem-f-willpower': 'willpower', 'gem-f-points': 'points', 'gem-f-effect1': 'effect1', 'gem-f-level1': 'level1', 'gem-f-effect2': 'effect2', 'gem-f-level2': 'level2', 'gem-f-remaining': 'remaining', 'gem-f-rerolls': 'rerolls', 'gem-f-cost': 'cost' };
const CHIP_FIELDS = { subtype: 'subtype', attempts: 'grade', value0: 'willpower', value1: 'points', effect0: 'effect1', value2: 'level1', effect1: 'effect2', value3: 'level2', remaining: 'remaining', rerolls: 'rerolls', cost: 'cost' };
const percent = new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
// A positive chance never reads as 0%, which would look like "cannot reach".
const formatChance = value => (value > 0 && value < 0.0005 ? `<${percent.format(0.001)}` : percent.format(value));
const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
const emptyClause = () => ({ willpower: '', corePoints: '', total: '', effects: [] });
const freshAuto = () => ({ status: 'idle', generation: 0, characters: [], character: '', response: null, subtype: null, candidates: [], index: 0, reason: null, controller: null, waited: false });

const app = {
  generation: 0, readGeneration: 0, sourceGeneration: 0, imageLoad: 0,
  source: null, bitmap: null, captureState: 'idle', engineState: 'idle',
  regions: null, savedRegions: null, draft: null, aligning: false,
  frameIssue: null, paused: false, readIssue: null,
  signatures: {}, texts: {}, reading: { running: false, dirty: new Set() }, observed: null,
  touched: new Set(), confirmed: null, applied: null, gemChange: null,
  offers: [null, null, null, null], offerParsed: [null, null, null, null], offerRead: ['unread', 'unread', 'unread', 'unread'],
  offerFixed: [false, false, false, false], offerStatus: [], offerIssue: null,
  target: { mode: 'manual', clauses: [emptyClause()], manual: null, manualError: 'empty_clause', auto: freshAuto() },
  rec: { status: 'blocked', blocker: 'state', requestId: 0, inFlight: null, queued: false, key: '', input: null, result: null },
  workerFailed: false,
};

const ocr = createOcr();
const capture = createCapture(ui.video, { onState: onCaptureState });
let worker = null;

function announce(id, params) { ui.status.textContent = id ? t(id, params) : ''; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function fillSelect(select, options, value = select.value) {
  select.replaceChildren(...options.map(([optionValue, label]) => new Option(label, String(optionValue))));
  select.value = options.some(([optionValue]) => String(optionValue) === String(value)) ? String(value) : String(options[0]?.[0] ?? '');
}
const unknownOption = () => ['', t('gem.review.unread')];

// ---------- state form ----------

function setupForm() {
  fillSelect(ui.subtype, [unknownOption(), ...Object.entries(model.SUBTYPES).map(([subtype, entry]) => [subtype, t('gem.subtype.name', { family: entry.family, subtype })])]);
  fillSelect(ui.grade, [unknownOption(), ...Object.keys(model.STARTS).map(grade => [grade, grade])]);
  for (const select of [ui.willpower, ui.points, ui.level1, ui.level2]) fillSelect(select, [unknownOption(), ...range(1, 5).map(n => [n, String(n)])]);
  fillSelect(ui.cost, [unknownOption(), [-1, t('gem.field.cost.minus')], [0, t('gem.field.cost.none')], [1, t('gem.field.cost.plus')]]);
  refreshDependentOptions();
}

function refreshDependentOptions() {
  const entry = model.SUBTYPES[ui.subtype.value];
  const effects = entry?.effects ?? [];
  for (const select of [ui.effect1, ui.effect2]) fillSelect(select, [unknownOption(), ...effects.map(effect => [effect, effect])]);
  for (const select of [ui.initial1, ui.initial2]) fillSelect(select, [['', t('gem.field.initialEffects.unknown')], ...effects.map(effect => [effect, effect])]);
  ui.pointsLabel.textContent = t('gem.field.corePoints', { family: entry?.family ?? '' });
  const start = model.STARTS[ui.grade.value];
  const total = start?.attempts ?? 0;
  fillSelect(ui.remaining, [unknownOption(), ...range(0, total).map(n => [n, `${n} / ${total}`])]);
  const remaining = ui.remaining.value === '' ? total : Number(ui.remaining.value);
  fillSelect(ui.rerolls, [unknownOption(), ...range(0, start ? start.rerolls + 2 * (total - remaining) : 0).map(n => [n, String(n)])]);
}

function readForm() {
  const number = select => (select.value === '' ? null : Number(select.value));
  const start = model.STARTS[ui.grade.value];
  const initial = [ui.initial1.value, ui.initial2.value];
  return {
    grade: ui.grade.value || null, subtype: ui.subtype.value || null,
    effects: [ui.effect1.value || null, ui.effect2.value || null],
    points: [number(ui.willpower), number(ui.points), number(ui.level1), number(ui.level2)],
    totalAttempts: start?.attempts ?? null, remainingAttempts: number(ui.remaining), rerollsRemaining: number(ui.rerolls), costModifier: number(ui.cost),
    reset: ui.form.querySelector('input[name="gem-reset"]:checked')?.value ?? null,
    initialEffects: initial.every(Boolean) && initial[0] !== initial[1] ? initial : null,
  };
}

function writeForm(fields, { onlyUntouched = false } = {}) {
  const set = (key, select, value) => {
    if ((onlyUntouched && app.touched.has(key)) || value === null || value === undefined) return;
    select.value = String(value);
  };
  set('subtype', ui.subtype, fields.subtype);
  set('grade', ui.grade, fields.grade);
  refreshDependentOptions();
  set('effect1', ui.effect1, fields.effects?.[0]);
  set('effect2', ui.effect2, fields.effects?.[1]);
  set('willpower', ui.willpower, fields.points?.[0]);
  set('points', ui.points, fields.points?.[1]);
  set('level1', ui.level1, fields.points?.[2]);
  set('level2', ui.level2, fields.points?.[3]);
  set('remaining', ui.remaining, fields.remainingAttempts);
  refreshDependentOptions();
  set('rerolls', ui.rerolls, fields.rerollsRemaining);
  set('cost', ui.cost, fields.costModifier);
}

function formState() {
  const state = stateFromFields(readForm());
  return state && checkState(state, engine).ok ? state : null;
}
const currentState = () => app.confirmed?.state ?? formState();
const allowedEffects = () => model.SUBTYPES[app.confirmed?.state.subtype ?? ui.subtype.value]?.effects ?? [];

function chipStatus(chip) {
  if (app.touched.has(CHIP_FIELDS[chip])) return 'fixed';
  const status = app.observed?.status;
  if (!status) return null;
  if (chip === 'subtype') return status.subtype;
  if (chip === 'attempts' || chip === 'remaining') return status.attempts;
  if (chip.startsWith('value')) return status.values[Number(chip.slice(5))] ?? null;
  if (chip.startsWith('effect')) return status.effects[Number(chip.slice(6))] ?? null;
  return status[chip] ?? null;
}

function renderState() {
  for (const chip of ui.form.querySelectorAll('[data-chip]')) {
    const status = chipStatus(chip.dataset.chip);
    chip.dataset.status = status ?? '';
    chip.textContent = status ? t(CHIP_COPY[status]) : '';
    chip.hidden = !status;
  }
  const observed = app.observed;
  const sum = observed?.sum === 'match' ? t('gem.field.sumMatch') : observed?.sum === 'mismatch' ? t('gem.read.conflict.points') : '';
  ui.pointsCheck.textContent = observed?.gemPoints ? `${t('gem.field.gemPoints', { value: observed.gemPoints })} ${sum}`.trim() : '';
  ui.stateNote.textContent = t(app.confirmed ? 'gem.state.tracking' : 'gem.state.startConfirm');
  ui.stateIssue.textContent = app.readIssue === 'transition' ? t('gem.read.conflict.transition') : app.readIssue === 'partial' ? t('gem.read.partial')
    : app.observed?.status.subtype === 'conflict' && !app.confirmed ? t('gem.read.conflict.gemName') : '';
  ui.applied.hidden = !app.applied;
  ui.change.hidden = !app.gemChange;
  ui.stateConfirm.disabled = !engine;
}

// ---------- offers ----------

const offerNodes = [];
function buildOfferRow() {
  for (let index = 0; index < 4; index++) {
    const item = element('li', 'gem-offer');
    const slot = element('p', 'gem-offer-slot', t('gem.offer.slot', { n: index + 1 }));
    const text = element('p', 'gem-offer-text');
    const chip = element('span', 'gem-chip');
    const select = document.createElement('select');
    select.setAttribute('aria-label', t('gem.offer.choose', { n: index + 1 }));
    select.addEventListener('change', () => {
      app.offers[index] = select.value || null;
      app.offerFixed[index] = Boolean(select.value);
      validateOffers();
      renderOffers();
      requestRecommendation();
    });
    item.append(slot, text, chip, select);
    ui.offerRow.append(item);
    offerNodes.push({ text, chip, select, key: '' });
  }
}

function partsText(parts) {
  if (!parts) return t('gem.offer.unread');
  if (parts.kind === 'axis') return t(parts.negative ? 'gem.offer.axisMinus' : 'gem.offer.axisPlus', { name: parts.name, n: parts.amount });
  if (parts.kind === 'effectLevel') return t(parts.negative ? 'gem.offer.effectMinus' : 'gem.offer.effectPlus', { name: parts.name, n: parts.amount });
  if (parts.kind === 'effectChange') return t('gem.offer.effectChange', { name: parts.name });
  if (parts.kind === 'cost') return t(parts.negative ? 'gem.offer.costMinus' : 'gem.offer.costPlus');
  if (parts.kind === 'reroll') return t('gem.offer.reroll', { n: parts.amount });
  return t('gem.offer.unchanged');
}
const describe = (id, family, effects) => partsText(describeOutcome(id, { family, effects }));

function offerIssue(offer, family, effects) {
  if (/ 포인트$/.test(offer.label)) return offer.label === `${family} 포인트` ? 'review' : 'family';
  if (model.SUBTYPES && Object.values(model.SUBTYPES).some(entry => entry.effects.includes(offer.label))) return effects.includes(offer.label) ? 'review' : 'effect';
  return 'review';
}

function setObservedOffers(observed, family, effects) {
  if (!observed?.offers?.length) return;
  observed.offers.forEach((offer, index) => {
    if (app.offerFixed[index]) return;
    const id = family && effects?.every(Boolean) ? offerToOutcomeId(offer, { family, effects }) : null;
    app.offers[index] = id;
    app.offerParsed[index] = offer;
    app.offerRead[index] = !offer ? 'unread' : id ? 'ok' : offerIssue(offer, family, effects ?? []);
  });
}

function validateOffers() {
  const state = currentState();
  const result = state ? checkOffers(app.offers, state, engine) : { ok: false, reason: 'incomplete' };
  app.offerIssue = ['duplicate', 'unavailable'].includes(result.reason) ? result.reason : app.offerRead.find(entry => entry === 'family' || entry === 'effect') ?? null;
  app.offerStatus = app.offers.map((id, index) => {
    if (!id) return app.offerRead[index];
    if (!result.ok && (result.reason === 'duplicate' || result.ineligible?.includes(id))) return 'review';
    return app.offerFixed[index] ? 'fixed' : 'ok';
  });
  if (app.confirmed) app.confirmed.offers = result.ok ? [...app.offers] : null;
  return result.ok;
}

function renderOffers() {
  const state = currentState();
  const family = state ? model.SUBTYPES[state.subtype].family : null;
  const effects = state?.effects ?? [];
  const pool = state ? checkState(state, engine) : null;
  const candidates = pool?.ok && !pool.finished ? pool.candidates : [];
  const key = `${candidates.join(',')}|${family}|${effects.join(',')}`;
  offerNodes.forEach((node, index) => {
    const id = app.offers[index];
    node.text.textContent = id ? describe(id, family, effects) : partsText(describeOffer(app.offerParsed[index], parsers.vocab.effects));
    const status = app.offerStatus[index] ?? app.offerRead[index];
    node.chip.dataset.status = status; node.chip.textContent = t(CHIP_COPY[status] ?? 'gem.review.unread');
    if (node.key !== key) {
      fillSelect(node.select, [['', t('gem.offer.choose', { n: index + 1 })], ...candidates.map(candidate => [candidate, describe(candidate, family, effects)])], id ?? '');
      node.key = key;
    } else if (document.activeElement !== node.select) node.select.value = id ?? '';
    node.select.disabled = !candidates.length;
  });
  ui.offerIssue.textContent = app.offerIssue ? t(OFFER_ISSUE_COPY[app.offerIssue]) : '';
}

// ---------- reading ----------

function onReading() {
  const observed = interpretReading({
    gemName: app.texts.gemName, gemPoints: app.texts.gemPoints, labelPoints: app.texts.labelPoints,
    labelEffects: [app.texts.labelEffect1, app.texts.labelEffect2], attempts: app.texts.attempts, rerolls: app.texts.rerolls,
    cost: app.texts.cost, offers: app.texts.offers, values: VALUE_REGIONS.map(key => app.texts[key] ?? { found: false, votes: [] }),
  }, model);
  app.observed = observed;
  app.needsRefresh = false;
  const message = app.confirmed ? track(observed) : (prefill(observed), null);
  const incomplete = Object.values(observed.status).flat().some(status => status !== 'ok') || observed.offers.some(offer => !offer);
  const issue = app.readIssue === 'transition' ? 'gem.read.conflict.transition' : app.readIssue === 'partial' ? 'gem.read.partial'
    : app.offerIssue ? OFFER_ISSUE_COPY[app.offerIssue] : null;
  announce(message ?? issue ?? (incomplete ? 'gem.read.partial' : 'gem.read.ok'));
  render();
  requestRecommendation();
}

function prefill(observed) {
  writeForm(observed, { onlyUntouched: true });
  const form = readForm();
  const family = model.SUBTYPES[form.subtype]?.family ?? observed.family;
  setObservedOffers(observed, family, form.effects);
  validateOffers();
}

// Returns a copy ID to announce when the tracked gem changed, otherwise null.
function track(observed) {
  const tracked = app.confirmed.state;
  const family = model.SUBTYPES[tracked.subtype].family;
  let next = stateFromFields(observed);
  if (next && !checkState(next, engine).ok) next = null;
  app.readIssue = null;
  const otherGem = (observed.subtype && observed.subtype !== tracked.subtype)
    || (observed.totalAttempts && observed.totalAttempts !== tracked.totalAttempts);
  if (otherGem) { startNewGem(observed); return 'gem.state.newGem'; }
  if (!next) {
    const sameStep = observed.totalAttempts === tracked.totalAttempts && observed.remainingAttempts === tracked.remainingAttempts;
    if (observed.totalAttempts === tracked.totalAttempts && observed.remainingAttempts === tracked.remainingAttempts - 1) { askApplied(tracked, app.confirmed.offers); return app.applied ? 'gem.state.appliedAsk' : null; }
    if (sameStep && observed.rerollsRemaining === tracked.rerollsRemaining - 1) app.confirmed.state = { ...tracked, rerollsRemaining: observed.rerollsRemaining };
    else if (!sameStep || (observed.rerollsRemaining !== null && observed.rerollsRemaining !== tracked.rerollsRemaining)) { app.readIssue = 'partial'; return null; }
    setObservedOffers(observed, family, app.confirmed.state.effects);
    validateOffers();
    return null;
  }
  const transition = inferTransition(tracked, app.confirmed.offers, next, engine);
  if (transition.kind === 'newGem') { startNewGem(observed); return 'gem.state.newGem'; }
  if (transition.kind === 'resetOrNewGem') { app.gemChange = { next, observed }; return 'gem.state.changeAsk'; }
  if (transition.kind === 'ambiguous' || transition.kind === 'unknown') {
    if (next.remainingAttempts === tracked.remainingAttempts - 1) askApplied(tracked, app.confirmed.offers);
    else app.readIssue = 'transition';
    return app.applied ? 'gem.state.appliedAsk' : null;
  }
  if (transition.kind !== 'none') app.confirmed.state = next;
  if (next.processedCount === 0) app.confirmed.initialEffects = [...next.effects];
  setObservedOffers(observed, family, app.confirmed.state.effects);
  validateOffers();
  writeForm(app.confirmed.state);
  return transition.kind === 'processed' ? 'gem.state.appliedAuto' : null;
}

function askApplied(previous, offers) {
  if (!offers) { app.readIssue = 'transition'; return; }
  app.applied = { previous, offers: [...offers] };
  const family = model.SUBTYPES[previous.subtype].family;
  ui.appliedOptions.replaceChildren(...offers.map((id, index) => {
    const label = element('label');
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'gem-applied'; input.value = id;
    input.addEventListener('change', () => renderAppliedEffect());
    label.append(input, ' ', element('span', '', `${t('gem.offer.slot', { n: index + 1 })} · ${describe(id, family, previous.effects)}`));
    return label;
  }));
  ui.appliedEffect.hidden = true;
}

function renderAppliedEffect() {
  const id = ui.appliedOptions.querySelector('input:checked')?.value;
  const result = id ? engine.applyGemProcessingOutcome(app.applied.previous, id) : null;
  const branches = result?.status === 'ok' ? result.branches : [];
  ui.appliedEffect.hidden = branches.length < 2;
  if (branches.length > 1) {
    const index = Number(/^effect([01])/.exec(id)[1]);
    fillSelect(ui.appliedEffectSelect, [['', t('gem.review.unread')], ...branches.map(branch => [branch.state.effects[index], branch.state.effects[index]])], '');
  }
}

function startNewGem(observed) {
  app.confirmed = null; app.applied = null; app.gemChange = null; app.readIssue = null;
  clearForm();
  app.generation++;
  prefill(observed);
}

// Every gem field back to unread, as for a new gem or another account.
function clearForm() {
  app.touched.clear();
  for (const select of [ui.subtype, ui.grade, ui.willpower, ui.points, ui.effect1, ui.level1, ui.effect2, ui.level2, ui.remaining, ui.rerolls, ui.cost, ui.initial1, ui.initial2]) select.value = '';
  for (const input of ui.form.querySelectorAll('input[name="gem-reset"]')) input.checked = false;
  refreshDependentOptions();
}

async function runRead(fields) {
  if (!parsers || !app.source || !app.regions) return;
  if (app.reading.running) { for (const key of fields ?? Object.keys(app.regions)) app.reading.dirty.add(key); return; }
  app.reading.running = true;
  const readGeneration = app.readGeneration;
  const cancelled = () => readGeneration !== app.readGeneration;
  if (!ocr.ready) app.engineState = 'loading';
  renderSource();
  try {
    const result = await readWindow(ocr, app.source, app.regions, parsers, { fields, cancelled });
    if (!result || cancelled()) return;
    app.engineState = 'ready';
    for (const [key, value] of Object.entries(result)) {
      if (key === 'values') value.forEach((slot, index) => { if (slot) app.texts[VALUE_REGIONS[index]] = slot; });
      else app.texts[key] = value;
    }
    if (result.offers) app.offerFixed = [false, false, false, false];
    for (const key of fields ?? Object.keys(app.regions)) { const entry = app.signatures[key]; if (entry) entry.read = entry.last; }
    onReading();
  } catch {
    if (!cancelled()) app.engineState = 'failed';
  } finally {
    app.reading.running = false;
    // Fields queued while this run was busy belong to the current source (a source change clears the queue), so
    // they run even when this run itself was cancelled.
    const next = new Set(app.reading.dirty);
    app.reading.dirty.clear();
    if (next.size && !app.aligning) void runRead(next);
    renderSource();
  }
}

// Sampled on a timer, not per delivered frame: capture may deliver frames only when the screen changes, and a region
// is read once its signature holds still for one tick. startReading() restarts the one loop instead of adding another.
let frameTimer = 0;
function scheduleFrame(current) {
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => onFrame(current), 280);
}

function onFrame(current) {
  if (current !== app.sourceGeneration || app.source?.kind !== 'stream') return;
  scheduleFrame(current);
  if (document.hidden || app.aligning || !app.regions) return;
  if (ui.video.videoWidth !== app.source.width || ui.video.videoHeight !== app.source.height) { onSizeChange(); return; }
  const dirty = new Set();
  let spread = 0;
  for (const [key, box] of Object.entries(app.regions)) {
    if (key === 'anchor') continue;
    const signature = regionSignature(app.source, box);
    spread = Math.max(spread, signatureSpread(signature));
    const entry = app.signatures[key];
    if (!entry || signatureDistance(entry.last, signature) > 6) { app.signatures[key] = { last: signature, read: entry?.read ?? null, settled: false }; continue; }
    if (!entry.settled) { entry.settled = true; if (signatureDistance(entry.read, signature) > 6) dirty.add(key); }
  }
  const black = spread < 4;
  if (black !== (app.frameIssue === 'black')) {
    app.frameIssue = black ? 'black' : null;
    renderSource();
    requestRecommendation();
  }
  if (!black && dirty.size) void runRead(dirty);
}

function onSizeChange() {
  const previous = app.source, next = videoSource(ui.video);
  if (!next.width || !next.height) return;
  const sx = next.width / previous.width, sy = next.height / previous.height;
  app.source = next;
  app.readGeneration++; app.generation++;
  if (app.regions) app.regions = Object.fromEntries(Object.entries(app.regions).map(([key, [x, y, w, h]]) => [key, [x * sx, y * sy, w * sx, h * sy]]));
  app.frameIssue = 'sizeChanged';
  announce('gem.frame.sizeChanged');
  startAlign();
}

// ---------- source ----------

function onCaptureState(state) {
  app.captureState = state;
  if (state === 'active' || state === 'selfSurface') useSource('stream');
  else if (state !== 'requesting' && app.source?.kind === 'stream') dropSource();
  render();
  requestRecommendation();
}

function useSource(kind) {
  const source = kind === 'stream' ? videoSource(ui.video) : bitmapSource(app.bitmap);
  if (!source.width || !source.height) {
    if (kind === 'stream') ui.video.addEventListener('loadedmetadata', () => { if (capture.active && !app.source) useSource('stream'); }, { once: true });
    return;
  }
  app.sourceGeneration++; app.readGeneration++; app.generation++;
  app.source = source;
  app.needsRefresh = true;
  const saved = app.savedRegions;
  app.regions = saved && saved.width === source.width && saved.height === source.height ? saved.regions : null;
  if (!ocr.ready) {
    app.engineState = 'loading';
    // A start cut short by the next source change must not mark the next source's engine as failed.
    const current = app.sourceGeneration;
    ocr.ensure().then(
      () => { if (current === app.sourceGeneration && app.engineState === 'loading') { app.engineState = 'ready'; renderSource(); } },
      () => { if (current === app.sourceGeneration) { app.engineState = 'failed'; renderSource(); } });
  }
  if (app.regions) { buildOverlay(); startReading(); } else startAlign();
  render();
}

function clearScreenData() {
  app.readGeneration++; app.generation++;
  app.texts = {}; app.signatures = {}; app.observed = null; app.reading.dirty.clear();
  app.offers = [null, null, null, null]; app.offerRead = ['unread', 'unread', 'unread', 'unread']; app.offerFixed = [false, false, false, false];
  app.offerStatus = []; app.offerIssue = null; app.offerParsed = [null, null, null, null];
  if (app.confirmed) app.confirmed.offers = null;
  app.applied = null; app.gemChange = null; app.readIssue = null; app.frameIssue = null;
}

function releaseBitmap() {
  app.bitmap?.close();
  app.bitmap = null;
  ui.still.getContext('2d')?.clearRect(0, 0, ui.still.width, ui.still.height);
  ui.still.width = 1; ui.still.height = 1;
}

// Share end, new share, image change or clear: tracks/bitmaps/workers are released, an image still decoding is made
// stale, and OCR text and the recommendation are cleared. The confirmed gem state and the target stay for manual
// continuation.
function dropSource() {
  app.sourceGeneration++; app.imageLoad++;
  app.source = null; app.aligning = false; app.draft = null;
  releaseBitmap();
  clearScreenData();
  void ocr.stop();
  app.engineState = 'idle';
  stopWorker();
  ui.overlay.replaceChildren(); roiNodes.clear();
}

// Page exit and a change of signed-in account (sign-out included) end the share and every screen datum, the gem
// state, the alignment and the auto goal. An account change also clears the gem form and the typed target, which
// belong to the previous account.
function teardown(reason) {
  if (capture.active) capture.stop('idle');
  dropSource();
  app.confirmed = null; app.applied = null; app.gemChange = null; app.savedRegions = null; app.regions = null;
  app.touched.clear();
  clearAuto();
  if (reason === 'account') {
    clearForm();
    app.target.clauses = [emptyClause()];
    renderClauses();
    recomputeManual();
  }
  render();
}

function startReading() {
  if (!app.source || !app.regions || app.aligning) return;
  if (app.source.kind === 'image') void runRead(null);
  else scheduleFrame(app.sourceGeneration);
}

function renderSource() {
  const kind = app.source?.kind;
  ui.stage.hidden = !kind;
  ui.video.hidden = kind !== 'stream';
  ui.still.hidden = kind !== 'image';
  ui.align.hidden = !app.aligning;
  ui.alignNeeded.textContent = t(kind === 'image' ? 'gem.mobile.imageAlign' : 'gem.align.needed');
  ui.shareStop.hidden = !capture.active;
  ui.share.textContent = t(capture.active || ['ended', 'denied', 'failed'].includes(app.captureState) ? 'gem.capture.restart' : 'gem.capture.start');
  ui.share.disabled = !engine || app.captureState === 'requesting' || ['unsupported', 'framed'].includes(app.captureState);
  ui.image.disabled = !engine;
  ui.alignEdit.hidden = !kind || app.aligning;
  ui.imageClear.hidden = kind !== 'image';
  const lines = [];
  if (CAPTURE_COPY[app.captureState]) lines.push(t(CAPTURE_COPY[app.captureState]));
  if (app.paused && kind === 'stream') lines.push(t('gem.capture.paused'));
  if (app.frameIssue === 'black') lines.push(t('gem.frame.black'));
  if (app.frameIssue === 'sizeChanged') lines.push(t('gem.frame.sizeChanged'));
  if (app.engineState === 'loading') lines.push(t('gem.read.engineLoading'));
  if (app.engineState === 'failed') lines.push(t('gem.read.engineFailed'));
  if (app.reading.running) lines.push(t('gem.read.running'));
  ui.sourceState.textContent = lines.join(' ');
}

// ---------- alignment ----------

let roiNodes = new Map();
let drag = null;

function defaultAnchor({ width, height }) {
  const w = width * 0.256;
  return [width * 0.674 - w / 2, height * 0.47 - w / ANCHOR_RATIO / 2, w, w / ANCHOR_RATIO];
}

function startAlign() {
  if (!app.source) return;
  const anchor = app.regions?.anchor ?? defaultAnchor(app.source);
  const offsets = {};
  if (app.regions) {
    const derived = deriveRegions(anchor);
    for (const key of EDITABLE) if (key !== 'anchor' && app.regions[key]) offsets[key] = app.regions[key].map((value, index) => value - derived[key][index]);
  }
  app.draft = { anchor: [...anchor], offsets };
  app.aligning = true;
  buildOverlay();
  renderSource();
  roiNodes.get('anchor')?.focus({ preventScroll: true });
}

function draftRegions() {
  const derived = deriveRegions(app.draft.anchor);
  const regions = { anchor: [...app.draft.anchor] };
  for (const [key, box] of Object.entries(derived)) {
    const offset = app.draft.offsets[key];
    regions[key] = offset ? box.map((value, index) => value + offset[index]) : box;
  }
  return regions;
}

function buildOverlay() {
  ui.overlay.replaceChildren();
  roiNodes = new Map();
  const regions = app.aligning ? draftRegions() : app.regions;
  if (!regions) return;
  for (const key of Object.keys(regions)) {
    const editable = app.aligning && EDITABLE.includes(key);
    const node = document.createElement(editable ? 'button' : 'span');
    node.className = 'gem-roi';
    node.dataset.region = key;
    node.dataset.kind = editable ? 'edit' : 'shown';
    if (editable) {
      node.type = 'button';
      node.setAttribute('aria-label', t(REGION_COPY[key]));
      node.append(element('span', 'gem-roi-handle'));
    } else node.setAttribute('aria-hidden', 'true');
    ui.overlay.append(node);
    roiNodes.set(key, node);
  }
  updateOverlay();
}

function updateOverlay() {
  const regions = app.aligning ? draftRegions() : app.regions;
  if (!regions || !app.source) return;
  const { width, height } = app.source;
  for (const [key, node] of roiNodes) {
    const [x, y, w, h] = regions[key];
    node.style.left = `${(x / width) * 100}%`;
    node.style.top = `${(y / height) * 100}%`;
    node.style.width = `${(w / width) * 100}%`;
    node.style.height = `${(h / height) * 100}%`;
  }
}

function nudge(key, dx, dy, resize) {
  if (key === 'anchor') {
    const [x, y, w] = app.draft.anchor;
    const width = resize ? Math.max(48, w + (dx || dy)) : w;
    app.draft.anchor = resize ? [x, y, width, width / ANCHOR_RATIO] : [x + dx, y + dy, w, w / ANCHOR_RATIO];
    return;
  }
  const [ox, oy, ow, oh] = app.draft.offsets[key] ?? [0, 0, 0, 0];
  app.draft.offsets[key] = resize ? [ox, oy, ow + dx, oh + dy] : [ox + dx, oy + dy, ow, oh];
}

function applyAlign() {
  if (!app.draft || !app.source) return;
  const { width, height } = app.source;
  const regions = {};
  for (const [key, box] of Object.entries(draftRegions())) {
    const clamped = clampBox(box, width, height);
    if (!clamped || clamped[2] * clamped[3] > LIMITS.regionPixels) {
      if (REQUIRED.includes(key)) { announce('gem.align.outOfBounds'); return; }
      continue;
    }
    regions[key] = clamped;
  }
  app.regions = regions;
  app.savedRegions = { width, height, regions };
  app.aligning = false; app.draft = null; app.frameIssue = null;
  app.signatures = {}; app.texts = {}; app.readGeneration++; app.generation++;
  buildOverlay();
  render();
  startReading();
}

function cancelAlign() {
  if (!app.regions) { app.draft = { anchor: defaultAnchor(app.source), offsets: {} }; updateOverlay(); return; }
  app.aligning = false; app.draft = null;
  buildOverlay();
  renderSource();
  startReading();
}

ui.overlay.addEventListener('pointerdown', event => {
  const node = event.target.closest('.gem-roi[data-kind="edit"]');
  if (!node || !app.aligning) return;
  event.preventDefault();
  node.setPointerCapture(event.pointerId);
  node.focus({ preventScroll: true });
  const key = node.dataset.region;
  drag = {
    key, resize: event.target.classList.contains('gem-roi-handle'), x: event.clientX, y: event.clientY,
    scale: app.source.width / Math.max(1, ui.overlay.clientWidth), anchor: [...app.draft.anchor], offset: [...(app.draft.offsets[key] ?? [0, 0, 0, 0])],
  };
});
ui.overlay.addEventListener('pointermove', event => {
  if (!drag) return;
  const dx = (event.clientX - drag.x) * drag.scale, dy = (event.clientY - drag.y) * drag.scale;
  if (drag.key === 'anchor') {
    const [x, y, w] = drag.anchor;
    const width = drag.resize ? Math.max(48, w + dx) : w;
    app.draft.anchor = drag.resize ? [x, y, width, width / ANCHOR_RATIO] : [x + dx, y + dy, w, w / ANCHOR_RATIO];
  } else {
    const [ox, oy, ow, oh] = drag.offset;
    app.draft.offsets[drag.key] = drag.resize ? [ox, oy, ow + dx, oh + dy] : [ox + dx, oy + dy, ow, oh];
  }
  updateOverlay();
});
for (const type of ['pointerup', 'pointercancel']) ui.overlay.addEventListener(type, () => { drag = null; });
ui.overlay.addEventListener('keydown', event => {
  const node = event.target.closest('.gem-roi[data-kind="edit"]');
  if (!node || !app.aligning) return;
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (direction) {
    event.preventDefault();
    const step = (event.shiftKey ? 10 : 1) * (app.source.width / Math.max(1, ui.overlay.clientWidth));
    nudge(node.dataset.region, direction[0] * step, direction[1] * step, event.altKey);
    updateOverlay();
  } else if (event.key === 'Enter') { event.preventDefault(); applyAlign(); }
  else if (event.key === 'Escape') { event.preventDefault(); cancelAlign(); }
});

// ---------- target ----------

function setMode(mode) {
  if (app.target.mode === mode) return;
  app.target.mode = mode;
  app.generation++;
  // Leaving the auto mode cancels its pending load, so a late answer never comes back as the goal. A goal that had
  // already arrived is kept: each fetch counts against the server's per-IP character limit.
  if (mode !== 'auto' && app.target.auto.controller) clearAuto();
  if (mode === 'auto' && !(app.target.auto.response && app.target.auto.status === 'ready')) void loadAuto();
  render();
  requestRecommendation();
}

function recomputeManual() {
  const built = buildTarget(app.target.clauses, allowedEffects());
  app.target.manual = built.target ?? null;
  app.target.manualError = built.error ?? null;
  ui.manualStatus.textContent = t(!built.error ? 'gem.target.manual.ready' : built.error === 'empty_clause' ? 'gem.target.manual.incomplete' : 'gem.target.manual.invalid');
  if (app.target.mode === 'manual') { app.generation++; requestRecommendation(); }
}

// Clause controls are rebuilt only when their structure or the allowed effects change, so a reading
// arriving mid-edit does not steal focus from an open select.
function clausesKey() {
  return `${allowedEffects().join('|')}#${app.target.clauses.map(clause => clause.effects.length).join(',')}`;
}

function numberSelect(label, value, from, to) {
  const wrap = element('label', 'gem-field');
  wrap.append(element('span', '', label));
  const select = document.createElement('select');
  fillSelect(select, [['', t('gem.target.manual.noLimit')], ...range(from, to).map(n => [n, String(n)])], value);
  wrap.append(select);
  return { wrap, select };
}

function renderClauses() {
  const allowed = allowedEffects();
  ui.manualGem.hidden = allowed.length > 0;
  app.target.clausesKey = clausesKey();
  ui.clauses.replaceChildren(...app.target.clauses.map((clause, index) => {
    const box = element('fieldset', 'gem-clause');
    box.append(element('legend', '', t('gem.target.manual.clause', { n: index + 1 })));
    const grid = element('div', 'gem-clause-grid');
    const fields = [
      ['willpower', t('gem.target.meaning.willpower'), 1, 5], ['corePoints', t('gem.target.meaning.corePoints'), 1, 5], ['total', t('gem.target.meaning.totalPoints'), 4, 20],
    ];
    for (const [key, label, from, to] of fields) {
      const { wrap, select } = numberSelect(label, clause[key], from, to);
      select.addEventListener('change', () => { clause[key] = select.value; recomputeManual(); });
      grid.append(wrap);
    }
    box.append(grid);
    box.append(element('p', 'gem-hint', t('gem.target.meaning.effects')));
    clause.effects.forEach((effect, effectIndex) => {
      const row = element('div', 'gem-effect-row');
      const name = document.createElement('select');
      name.setAttribute('aria-label', t('gem.target.manual.effectName'));
      fillSelect(name, [unknownOption(), ...allowed.map(entry => [entry, entry])], effect.name);
      name.addEventListener('change', () => { effect.name = name.value; recomputeManual(); });
      const level = document.createElement('select');
      level.setAttribute('aria-label', t('gem.field.effectLevel'));
      fillSelect(level, range(1, 5).map(n => [n, String(n)]), effect.level);
      level.addEventListener('change', () => { effect.level = Number(level.value); recomputeManual(); });
      const remove = element('button', 'gem-button', t('gem.target.manual.removeEffect'));
      remove.type = 'button';
      remove.addEventListener('click', () => { clause.effects.splice(effectIndex, 1); renderClauses(); recomputeManual(); });
      row.append(name, level, remove);
      box.append(row);
    });
    const actions = element('div', 'gem-actions');
    const addEffect = element('button', 'gem-button', t('gem.target.manual.addEffect'));
    addEffect.type = 'button';
    addEffect.disabled = clause.effects.length >= 2 || !allowed.length;
    addEffect.addEventListener('click', () => { clause.effects.push({ name: '', level: 1 }); renderClauses(); recomputeManual(); });
    actions.append(addEffect);
    if (app.target.clauses.length > 1) {
      const removeClause = element('button', 'gem-button', t('gem.target.manual.removeClause'));
      removeClause.type = 'button';
      removeClause.addEventListener('click', () => { app.target.clauses.splice(index, 1); renderClauses(); recomputeManual(); });
      actions.append(removeClause);
    }
    box.append(actions);
    return box;
  }));
  ui.clauseAdd.disabled = app.target.clauses.length >= 25;
}

// Signed in by the shared access check is enough to ask; approval and ownership are the server's answer
// (403 approval_required / ownership_required are shown as such). A static host never calls the API.
// Shared access (auth.js through renewal.js): { authenticated, personal, guild }. A signed-out answer is 'anonymous' in
// both fields; 'unavailable' in both means not checked yet, the tab is hidden or the check failed.
const accessIs = (access, state) => access?.personal === state && access?.guild === state;
function autoGate() {
  if (window.pogeunStaticHost?.active === true) return 'staticHost';
  const access = window.pogeunSiteAccess;
  if (access?.authenticated === true) return 'ready';
  return accessIs(access, 'anonymous') ? 'loginRequired' : app.target.auto.waited ? 'unavailable' : 'checking';
}

function apiStatus({ status, data }) {
  if (status === 401) return 'loginRequired';
  if (status === 403) return data?.error === 'ownership_required' ? 'ownershipRequired' : 'approvalRequired';
  if (status === 422) return 'notFound';
  if (status === 429) return 'rateLimited';
  if (status === 409) return 'changed';
  return status >= 500 ? 'officialUnavailable' : 'unavailable';
}

async function apiGet(path, signal) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json().catch(() => null) : null;
  return { ok: response.ok, status: response.status, data };
}

// Own-character API: only after the user picks the auto mode and the shared access check says signed in; never on
// a static host. Late answers (older generation) change nothing; a 401/403 at either step drops the character list,
// the choice and the goal (dropAutoAnswer).
async function loadAuto({ refresh = false } = {}) {
  const auto = app.target.auto;
  const gate = autoGate();
  if (gate !== 'ready') { auto.status = gate; renderTarget(); return; }
  auto.controller?.abort();
  const controller = new AbortController();
  auto.controller = controller;
  const generation = ++auto.generation;
  // Leaving the auto mode, another account or a newer load replaces or bumps this state; a late answer then changes
  // nothing, success, failure or cleanup alike.
  const live = () => app.target.auto === auto && generation === auto.generation;
  auto.status = 'loading';
  renderTarget();
  try {
    if (!auto.characters.length || refresh) {
      const list = await apiGet('/api/auth/characters', controller.signal);
      if (!live()) return;
      if (!list.ok) { auto.status = apiStatus(list); if ([401, 403].includes(list.status)) { dropAutoAnswer(auto); void window.refreshPogeunSiteAccess?.(); } return; }
      auto.characters = (list.data?.characters ?? []).map(entry => entry?.characterName).filter(name => typeof name === 'string' && name);
      const preferred = list.data?.representative?.characterName;
      if (!auto.characters.includes(auto.character)) auto.character = auto.characters.includes(preferred) ? preferred : auto.characters[0] ?? '';
    }
    if (!auto.character) { auto.status = 'unavailable'; return; }
    const query = new URLSearchParams({ name: auto.character });
    if (refresh) query.set('refresh', '1');
    const result = await apiGet(`/api/auth/gem-helper/character?${query}`, controller.signal);
    if (!live()) return;
    if (!result.ok) { auto.status = apiStatus(result); auto.response = null; auto.candidates = []; if ([401, 403].includes(result.status)) { dropAutoAnswer(auto); void window.refreshPogeunSiteAccess?.(); } return; }
    auto.response = result.data;
    auto.status = 'ready';
    auto.subtype = null;
    selectAutoCandidates();
  } catch {
    if (live()) auto.status = 'unavailable';
  } finally {
    if (auto.controller === controller) auto.controller = null;
    if (live()) { app.generation++; renderTarget(); requestRecommendation(); }
  }
}

// A 401/403 from the own-character API ends what the page held from it: the character list, the choice and the goal,
// so the recommendation stops with them. Screen, typed target and gem state stay; another account is cleared whole
// by site:account-change.
function dropAutoAnswer(auto) {
  Object.assign(auto, { characters: [], character: '', response: null, subtype: null, candidates: [], index: 0, reason: null });
}

function selectAutoCandidates() {
  const auto = app.target.auto;
  auto.candidates = []; auto.reason = null; auto.index = 0;
  const response = auto.response;
  if (!response) return;
  if (response.grid?.status !== 'ok' || response.grid.reason === 'grid_empty') { auto.reason = response.grid?.reason === 'grid_empty' ? 'gridEmpty' : 'gridUnreadable'; return; }
  const subtype = app.confirmed?.state.subtype ?? null;
  if (!subtype) { auto.reason = 'needsGem'; return; }
  const entry = response.goals?.[FAMILY_KEYS[model.SUBTYPES[subtype].family]]?.[subtype];
  const list = entry ? [entry.default, ...(entry.alternatives ?? [])].filter(candidate => candidate?.target) : [];
  auto.subtype = subtype;
  if (!list.length) {
    auto.reason = AUTO_REASONS[entry?.reason] ?? 'noGoalForGem';
    return;
  }
  auto.candidates = list;
}

function clearAuto() {
  app.target.auto.controller?.abort();
  const waited = app.target.auto.waited;
  app.target.auto = { ...freshAuto(), waited };
  app.generation++;
}

function summarizeTarget(target, family) {
  return (target?.anyOf ?? []).map(clause => [
    clause.willpowerEfficiencyAtLeast && t('gem.target.summary.willpower', { n: clause.willpowerEfficiencyAtLeast }),
    clause.corePointsAtLeast && t('gem.target.summary.corePoints', { family, n: clause.corePointsAtLeast }),
    clause.totalPointsAtLeast && t('gem.target.summary.total', { n: clause.totalPointsAtLeast }),
    ...(clause.effects ?? []).map(effect => t('gem.target.summary.effect', { name: effect.name, n: effect.levelAtLeast })),
  ].filter(Boolean).join(', ')).join(` ${t('gem.target.summary.or')} `);
}

function candidateLabel(candidate, family) {
  const place = { core: (candidate.coreSlot ?? 0) + 1, gem: (candidate.gemSlot ?? 0) + 1, from: candidate.fromPoints, to: candidate.toPoints };
  const head = t(candidate.kind === 'effect-upgrade' ? 'gem.target.auto.candidate.effectUpgrade' : 'gem.target.auto.candidate.coreThreshold', place);
  return `${head} · ${summarizeTarget(candidate.target, family)}`;
}

function renderTarget() {
  const { mode, auto } = app.target;
  ui.modeAuto.setAttribute('aria-pressed', String(mode === 'auto'));
  ui.modeManual.setAttribute('aria-pressed', String(mode === 'manual'));
  ui.auto.hidden = mode !== 'auto';
  ui.manual.hidden = mode !== 'manual';
  // Hidden auto controls keep no names, goals or time that are no longer held (401/403, another account, cleared).
  ui.autoChecked.textContent = auto.response?.checkedAt ? t('gem.target.auto.checkedAt', { time: new Date(auto.response.checkedAt).toLocaleString('ko-KR') }) : '';
  if (!auto.characters.length && ui.character.options.length) { ui.character.replaceChildren(); delete ui.character.dataset.key; }
  if (!auto.candidates.length && ui.autoCandidateList.childElementCount) { ui.autoCandidateList.replaceChildren(); ui.autoCandidateList.dataset.key = ''; }
  if (mode === 'manual') { if (app.target.clausesKey !== clausesKey()) renderClauses(); return; }
  const subtype = app.confirmed?.state.subtype ?? null;
  const mismatch = Boolean(auto.subtype && subtype && auto.subtype !== subtype);
  const key = mismatch ? 'gemMismatch' : auto.status === 'ready' ? auto.reason : auto.status === 'idle' ? null : auto.status;
  ui.autoStatus.textContent = key ? t(AUTO_COPY[key]) : '';
  ui.autoControls.hidden = !auto.characters.length;
  const characterKey = auto.characters.join('|');
  if (auto.characters.length && ui.character.dataset.key !== characterKey && document.activeElement !== ui.character) {
    fillSelect(ui.character, auto.characters.map(name => [name, name]), auto.character);
    ui.character.dataset.key = characterKey;
  }
  ui.autoRefresh.disabled = auto.status === 'loading';
  const showCandidates = auto.candidates.length > 0 && !mismatch;
  ui.autoCandidates.hidden = !showCandidates;
  const listKey = showCandidates ? `${auto.subtype}|${auto.response?.checkedAt}|${auto.candidates.length}` : '';
  if (showCandidates && ui.autoCandidateList.dataset.key !== listKey) {
    const family = model.SUBTYPES[auto.subtype].family;
    ui.autoCandidateList.replaceChildren(...auto.candidates.map((candidate, index) => {
      const label = element('label', 'gem-candidate');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'gem-auto-candidate'; input.value = String(index); input.checked = index === auto.index;
      input.addEventListener('change', () => { auto.index = index; app.generation++; requestRecommendation(); });
      label.append(input, ' ', element('span', '', `${t(index === 0 ? 'gem.target.auto.default' : 'gem.target.auto.alternative')} · ${candidateLabel(candidate, family)}`));
      return label;
    }));
  }
  ui.autoCandidateList.dataset.key = listKey;
  ui.autoUse.hidden = !mismatch;
  ui.autoCopy.hidden = !showCandidates;
}

function activeTarget() {
  if (app.target.mode === 'manual') return app.target.manual;
  const auto = app.target.auto;
  const subtype = app.confirmed?.state.subtype;
  if (!auto.candidates.length || !subtype || auto.subtype !== subtype) return null;
  return auto.candidates[auto.index]?.target ?? null;
}

// ---------- recommendation worker ----------

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./gem-helper/recommendation-worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', () => {
    stopWorker();
    app.workerFailed = true;
    app.rec.status = 'blocked'; app.rec.blocker = 'engine';
    renderRec();
  });
  return worker;
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  app.rec.inFlight = null; app.rec.queued = false; app.rec.key = ''; app.rec.result = null;
  app.rec.status = 'blocked'; app.rec.blocker = recBlocker() ?? 'state';
}

function recBlocker() {
  if (!engine || !model || app.workerFailed) return 'engine';
  if (!app.confirmed || app.applied || app.gemChange) return 'state';
  if (app.readIssue === 'transition') return 'conflict';
  if (app.source?.kind === 'stream' && (app.frameIssue || app.paused || app.needsRefresh)) return 'frame';
  if (app.source && app.readIssue === 'partial') return 'read';
  if (!activeTarget()) return 'target';
  return null;
}

function requestRecommendation() {
  const blocker = recBlocker();
  if (blocker) {
    app.rec.status = 'blocked'; app.rec.blocker = blocker; app.rec.key = ''; app.rec.result = null; app.rec.queued = false;
    renderRec();
    return;
  }
  const state = app.confirmed.state;
  const input = {
    modelVersion: model.VERSION, target: activeTarget(),
    state: { ...state, resetAvailable: app.confirmed.reset === 'unused' && state.remainingAttempts > 0, initialEffects: app.confirmed.initialEffects },
    offer: app.confirmed.offers ? [...app.confirmed.offers] : null,
  };
  const key = JSON.stringify(input);
  if (key === app.rec.key && (app.rec.status === 'ok' || app.rec.inFlight)) return;
  app.rec.key = key; app.rec.input = input;
  if (app.rec.inFlight) {
    if (app.rec.inFlight.generation === app.generation) { app.rec.queued = true; return; }
    stopWorker();
    app.rec.key = key; app.rec.input = input;
  }
  send(input);
}

function send(input) {
  const requestId = ++app.rec.requestId;
  app.rec.inFlight = { requestId, generation: app.generation };
  app.rec.status = 'computing'; app.rec.result = null;
  renderRec();
  ensureWorker().postMessage({ type: 'recommend', requestId, generation: app.generation, input });
}

function onWorkerMessage({ data }) {
  if (data?.type !== 'result' || data.requestId !== app.rec.inFlight?.requestId) return;
  const pending = app.rec.inFlight;
  app.rec.inFlight = null;
  if (app.rec.queued) { app.rec.queued = false; send(app.rec.input); return; }
  if (!isCurrentResult(data, pending, app.generation)) return;
  app.rec.result = data.result;
  app.rec.status = data.result.status === 'ok' ? 'ok' : 'error';
  renderRec();
}

function renderRec() {
  const { status, blocker, result } = app.rec;
  if (status !== 'blocked' && status !== 'computing' && !result) { app.rec.status = 'blocked'; app.rec.blocker = recBlocker() ?? 'state'; renderRec(); return; }
  ui.recDetail.hidden = status !== 'ok';
  ui.recChip.hidden = true;
  ui.recAction.textContent = '';
  if (status !== 'ok') { ui.recValues.replaceChildren(); ui.recMargin.textContent = ''; ui.recAssumptions.replaceChildren(); }
  if (status === 'blocked') { ui.recReason.textContent = t(BLOCKER_COPY[blocker]); return; }
  if (status === 'computing') { ui.recReason.textContent = t('gem.rec.stale'); return; }
  if (status === 'error') { ui.recReason.textContent = t(ENGINE_STATUSES.includes(result.status) ? `gem.rec.status.${result.status}` : 'gem.rec.failed'); return; }
  const action = result.recommendation?.action;
  ui.recAction.textContent = action ? t(ACTION_COPY[action]) : '';
  ui.recReason.textContent = result.recommendation?.reason ? t(`gem.rec.reason.${result.recommendation.reason}`) : '';
  const chip = result.targetMet ? 'gem.rec.goalMet' : result.reachableOnCurrentGem === false ? 'gem.rec.unreachable' : null;
  if (app.confirmed?.state.remainingAttempts === 0) { ui.recChip.hidden = false; ui.recChip.textContent = `${t('gem.state.finished')}${chip ? ` · ${t(chip)}` : ''}`; }
  else if (chip) { ui.recChip.hidden = false; ui.recChip.textContent = t(chip); }
  ui.recValues.replaceChildren(...ACTIONS.flatMap(key => {
    const value = result.values?.[key];
    const reason = result.unavailable?.[key];
    const term = element('dt', '', t(ACTION_COPY[key]));
    const detail = element('dd', '', Number.isFinite(value) ? formatChance(value) : reason ? t(`gem.rec.unavailable.${reason}`) : t('gem.rec.valueUnavailable'));
    if (key === action) { term.dataset.best = ''; detail.dataset.best = ''; }
    return [term, detail];
  }));
  const margin = result.recommendation?.margin;
  // A tie note only for a real tie on positive chances; "complete" when nothing reaches the goal and "reset" first
  // when only a reset can are rules, explained by their reason text.
  const tied = result.recommendation?.reason === 'higher_probability' && result.recommendation.tied?.length > 1;
  ui.recMargin.textContent = tied ? t('gem.rec.tied') : Number.isFinite(margin) && margin > 0 ? t('gem.rec.margin', { value: margin < 0.0005 ? `<${decimal.format(0.1)}` : decimal.format(margin * 100) }) : '';
  ui.recResetNote.hidden = app.confirmed?.reset !== 'exclude';
  ui.recAssumptions.replaceChildren(...(result.assumptions ?? []).map(code => element('li', '', t(`gem.rec.assumption.${code}`))));
}

function render() {
  renderSource();
  renderState();
  renderOffers();
  renderTarget();
  renderRec();
}

// ---------- events ----------

function wire() {
  ui.share.addEventListener('click', () => {
    app.imageLoad++;
    if (app.source) dropSource();
    void capture.start();
  });
  ui.shareStop.addEventListener('click', () => capture.stop('ended'));
  ui.alignEdit.addEventListener('click', () => startAlign());
  ui.alignApply.addEventListener('click', applyAlign);
  ui.alignCancel.addEventListener('click', cancelAlign);
  ui.alignReset.addEventListener('click', () => { if (!app.source) return; app.draft = { anchor: defaultAnchor(app.source), offsets: {} }; updateOverlay(); });
  ui.image.addEventListener('change', async () => {
    const file = ui.image.files?.[0];
    ui.image.value = '';
    if (!file) return;
    // Clearing, another file, a new share or another account while this file decodes makes it stale: the decoded
    // picture is closed unseen and a stale failure is not reported.
    const load = ++app.imageLoad;
    const result = await loadImageFile(file);
    if (load !== app.imageLoad) { result.bitmap?.close(); return; }
    if (result.error) { announce(IMAGE_ERROR_COPY[result.error]); return; }
    if (capture.active) capture.stop('idle');
    dropSource();
    app.bitmap = result.bitmap;
    ui.still.width = result.bitmap.width; ui.still.height = result.bitmap.height;
    ui.still.getContext('2d').drawImage(result.bitmap, 0, 0);
    useSource('image');
  });
  ui.imageClear.addEventListener('click', () => { dropSource(); render(); requestRecommendation(); });
  ui.form.addEventListener('change', event => {
    const key = FIELD_KEYS[event.target.id];
    if (key) app.touched.add(key);
    if (['gem-f-subtype', 'gem-f-grade', 'gem-f-remaining'].includes(event.target.id)) refreshDependentOptions();
    if (event.target.id === 'gem-f-subtype') { renderClauses(); recomputeManual(); }
    if (!app.confirmed) { const form = readForm(); setObservedOffers(app.observed, model.SUBTYPES[form.subtype]?.family, form.effects); validateOffers(); }
    renderState();
    renderOffers();
  });
  ui.stateConfirm.addEventListener('click', () => {
    const form = readForm();
    if (!form.reset) { announce('gem.state.resetRequired'); ui.form.querySelector('input[name="gem-reset"]')?.focus(); return; }
    const state = stateFromFields(form);
    if (!checkState(state, engine).ok) { announce('gem.state.invalid'); return; }
    const sameGem = app.confirmed?.state.subtype === state.subtype && app.confirmed?.state.grade === state.grade;
    app.confirmed = { state, reset: form.reset, initialEffects: state.processedCount === 0 ? [...state.effects] : form.initialEffects ?? (sameGem ? app.confirmed.initialEffects : null), offers: null };
    app.applied = null; app.gemChange = null; app.readIssue = null;
    app.generation++;
    validateOffers();
    if (app.target.mode === 'auto' && !app.target.auto.subtype && app.target.auto.response) selectAutoCandidates();
    renderClauses();
    recomputeManual();
    announce('gem.state.confirmed');
    render();
    requestRecommendation();
  });
  ui.appliedConfirm.addEventListener('click', () => {
    const id = ui.appliedOptions.querySelector('input:checked')?.value;
    if (!id || !app.applied) return;
    const result = engine.applyGemProcessingOutcome(app.applied.previous, id);
    if (result.status !== 'ok') return;
    let branch = result.branches[0];
    if (result.branches.length > 1) {
      const index = Number(/^effect([01])/.exec(id)[1]);
      branch = result.branches.find(entry => entry.state.effects[index] === ui.appliedEffectSelect.value);
      if (!branch) { renderAppliedEffect(); ui.appliedEffectSelect.focus(); return; }
    }
    app.confirmed.state = branch.state;
    app.applied = null; app.readIssue = null;
    app.generation++;
    if (app.observed) setObservedOffers(app.observed, model.SUBTYPES[branch.state.subtype].family, branch.state.effects);
    validateOffers();
    writeForm(branch.state);
    render();
    requestRecommendation();
  });
  ui.changeReset.addEventListener('click', () => {
    if (!app.gemChange) return;
    const { next, observed } = app.gemChange;
    app.confirmed = { state: next, reset: 'used', initialEffects: [...next.effects], offers: null };
    app.gemChange = null;
    app.generation++;
    setObservedOffers(observed, model.SUBTYPES[next.subtype].family, next.effects);
    validateOffers();
    writeForm(next);
    ui.form.querySelector('input[name="gem-reset"][value="used"]').checked = true;
    announce('gem.state.reset');
    render();
    requestRecommendation();
  });
  ui.changeNew.addEventListener('click', () => {
    if (!app.gemChange) return;
    const { observed } = app.gemChange;
    startNewGem(observed);
    announce('gem.state.newGem');
    render();
    requestRecommendation();
  });
  ui.modeAuto.addEventListener('click', () => setMode('auto'));
  ui.modeManual.addEventListener('click', () => setMode('manual'));
  ui.character.addEventListener('change', () => {
    app.target.auto.character = ui.character.value;
    app.target.auto.response = null; app.target.auto.candidates = []; app.target.auto.subtype = null;
    app.generation++;
    void loadAuto();
  });
  ui.autoRefresh.addEventListener('click', () => { void loadAuto({ refresh: true }); });
  ui.autoUse.addEventListener('click', () => { selectAutoCandidates(); app.generation++; renderTarget(); requestRecommendation(); });
  ui.autoCopy.addEventListener('click', () => {
    const target = activeTarget();
    if (!target) return;
    app.target.clauses = target.anyOf.map(clause => ({
      willpower: clause.willpowerEfficiencyAtLeast ?? '', corePoints: clause.corePointsAtLeast ?? '', total: clause.totalPointsAtLeast ?? '',
      effects: (clause.effects ?? []).map(effect => ({ name: effect.name, level: effect.levelAtLeast })),
    }));
    renderClauses();
    setMode('manual');
    recomputeManual();
  });
  ui.clauseAdd.addEventListener('click', () => {
    if (app.target.clauses.length >= 25) return;
    app.target.clauses.push(emptyClause());
    renderClauses();
    recomputeManual();
  });
  // Sign-out and account changes arrive as site:account-change (spec line 126). Here a changed answer only lets a
  // waiting auto mode load or show why it cannot. The check repeats every minute, and publishes 'unavailable' while
  // the tab is hidden or a check fails: neither drops anything, and a refused load is not retried until the answer
  // itself changes.
  document.addEventListener('site:access', event => {
    const previous = lastAccess;
    lastAccess = event.detail;
    const changed = !previous || previous.authenticated !== lastAccess?.authenticated || previous.personal !== lastAccess?.personal
      || previous.guild !== lastAccess?.guild;
    const auto = app.target.auto;
    if (changed && !accessIs(lastAccess, 'unavailable') && app.target.mode === 'auto' && !auto.response && !auto.controller) void loadAuto();
    renderTarget();
    requestRecommendation();
  });
  document.addEventListener('site:account-change', () => teardown('account'));
  document.addEventListener('visibilitychange', () => {
    app.paused = document.hidden;
    if (document.hidden) app.needsRefresh = true;
    if (!document.hidden) for (const entry of Object.values(app.signatures)) entry.read = null;
    renderSource();
    requestRecommendation();
  });
  window.addEventListener('pagehide', () => teardown('pagehide'));
  setTimeout(() => { app.target.auto.waited = true; if (app.target.mode === 'auto' && autoGate() !== 'ready') void loadAuto(); }, 6000);
}

let lastAccess = window.pogeunSiteAccess ?? null;

function init() {
  for (const node of document.querySelectorAll('[data-copy]')) node.textContent = t(node.dataset.copy);
  for (const node of document.querySelectorAll('[data-copy-label]')) node.setAttribute('aria-label', t(node.dataset.copyLabel));
  document.title = `${t('gem.page.title')} · 포근해용`;
  if (!engine || !model) {
    for (const control of [ui.share, ui.image, ui.stateConfirm, ui.modeAuto, ui.modeManual, ui.clauseAdd]) control.disabled = true;
    ui.recReason.textContent = t('gem.rec.engineFailed');
    return;
  }
  if (capture.framed()) app.captureState = 'framed';
  else if (!capture.supported()) app.captureState = 'unsupported';
  setupForm();
  buildOfferRow();
  wire();
  recomputeManual();
  render();
}

init();
