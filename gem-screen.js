// Pure recognition and state logic for gem-helper.html.
// No DOM access, so Node tests import it directly. Engine data and functions are passed in by the caller.

const WILLPOWER_LABEL = '의지력 효율';
const REROLL_LABEL = '다른 항목 보기';
const COST_LABEL = '가공 비용';
const KEEP_LABEL = '가공 상태 유지';
const pointsLabel = family => `${family} 포인트`;
const AXIS_SUFFIX = Object.freeze({ '+1': 'plus1', '+2': 'plus2', '+3': 'plus3', '+4': 'plus4', '-1': 'minus1' });

// Official guide layout (grade-attempts screenshot, 900 px wide). Every region scales with the anchor box,
// which the user aligns to the four current-value diamonds.
export const REFERENCE_LAYOUT = Object.freeze({
  anchor: Object.freeze([492, 200, 230, 192]),
  regions: Object.freeze({
    gemName: Object.freeze([520, 112, 172, 24]),
    gemPoints: Object.freeze([548, 146, 112, 22]),
    valueWillpower: Object.freeze([556, 249, 100, 22]),
    labelEffect1: Object.freeze([494, 284, 96, 18]),
    labelEffect2: Object.freeze([626, 284, 102, 18]),
    valueEffect1: Object.freeze([494, 301, 96, 22]),
    valueEffect2: Object.freeze([626, 301, 102, 22]),
    labelPoints: Object.freeze([556, 335, 100, 17]),
    valuePoints: Object.freeze([556, 350, 100, 22]),
    offers: Object.freeze([418, 436, 377, 42]),
    rerolls: Object.freeze([818, 443, 66, 22]),
    cost: Object.freeze([736, 501, 58, 20]),
    attempts: Object.freeze([628, 579, 144, 26]),
  }),
});
export const VALUE_REGIONS = Object.freeze(['valueWillpower', 'valuePoints', 'valueEffect1', 'valueEffect2']);

export function vocabulary(model) {
  const subtypes = model.SUBTYPES;
  const families = [...new Set(Object.values(subtypes).map(entry => entry.family))];
  const effects = [...new Set(Object.values(subtypes).flatMap(entry => entry.effects))];
  return {
    families, effects,
    pointLabels: families.map(pointsLabel),
    offerLabels: [WILLPOWER_LABEL, ...families.map(pointsLabel), ...effects, REROLL_LABEL, COST_LABEL, KEEP_LABEL],
    gemNames: Object.entries(subtypes).map(([subtype, entry]) => ({ subtype, family: entry.family, text: `${entry.family}의 젬 : ${subtype}` })),
  };
}

export function squash(text) {
  return String(text ?? '').normalize('NFC').replace(/[^\p{Script=Hangul}A-Za-z0-9+\-%/()]/gu, '');
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}

// Closed-set fuzzy match: best substring edit ratio <= maxRatio and a clear lead over the runner-up.
// wholeLabel fields (gem name, point and effect labels) hold only the label, so Hangul syllables left
// outside the matched window count against it; this keeps "공격력" from matching inside "아군 공격 강화".
const syllables = text => (text.match(/[\uAC00-\uD7A3]/g) || []).length;
export function matchLabel(text, options, { maxRatio = 0.34, margin = 0.2, wholeLabel = false } = {}) {
  const squashed = squash(text);
  const unique = [...new Set(options)];
  if (!squashed || !unique.length) return null;
  const scored = unique.map(option => {
    const target = squash(option);
    let best = { score: target.length, end: -1 };
    for (let start = 0; start < squashed.length; start++) {
      for (const width of [target.length - 1, target.length, target.length + 1]) {
        if (width <= 0) continue;
        const end = Math.min(squashed.length, start + width);
        const rest = wholeLabel ? syllables(squashed.slice(0, start) + squashed.slice(end)) : 0;
        const score = editDistance(squashed.slice(start, end), target) + 0.5 * rest;
        if (score < best.score) best = { score, end };
      }
    }
    return { option, ratio: best.score / target.length, end: best.end };
  }).sort((a, b) => a.ratio - b.ratio);
  const [first, second] = scored;
  if (first.ratio > maxRatio || (second && second.ratio - first.ratio < margin)) return null;
  return { option: first.option, ratio: first.ratio, end: first.end, squashed };
}

// A value wins only with at least minVotes and no tie for first place.
export function pickVote(values, minVotes = 2) {
  const counts = new Map();
  for (const value of values) if (value !== null && value !== undefined) counts.set(value, (counts.get(value) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < minVotes || (ranked[1] && ranked[1][1] === ranked[0][1])) return null;
  return ranked[0][0];
}

// Offer slot text: label first, then the change after that label (noise before it is ignored). The amount is
// the last allowed digit before the change word ("Lv. 2 증가", "+3 증가", "2회 증가"), because OCR often
// turns the "v." of "Lv." into a digit.
export function parseOfferText(text, vocab) {
  const squashed = squash(text);
  if (!squashed || squashed.includes('변경')) return null; // effect-change wording is unverified: always confirm
  const found = matchLabel(text, vocab.offerLabels);
  if (!found) return null;
  if (found.option === KEEP_LABEL) return { label: KEEP_LABEL, change: '0' };
  const after = found.squashed.slice(found.end);
  const decrease = /[감갑]/.test(after);
  if (found.option === COST_LABEL) {
    const match = after.match(/([+-]?)100%?/);
    return match ? { label: COST_LABEL, change: match[1] === '-' || decrease ? '-100%' : '+100%' } : null;
  }
  const marker = after.search(/[증중감갑회희휘]/);
  const segment = marker >= 0 ? after.slice(0, marker) : after;
  const allowed = found.option === REROLL_LABEL ? '12' : '1234';
  let index = segment.length - 1;
  while (index >= 0 && !allowed.includes(segment[index])) index--;
  if (index < 0) return null;
  const negative = segment[index - 1] === '-' || decrease;
  if (found.option === REROLL_LABEL && negative) return null;
  return { label: found.option, change: `${negative ? '-' : '+'}${segment[index]}` };
}

// Display parts for an offer that was read but could not be mapped to an id yet (for example while the
// gem's effects are still unconfirmed). Same shape as describeOutcome.
export function describeOffer(offer, effectNames) {
  if (!offer) return null;
  if (offer.label === KEEP_LABEL) return { kind: 'unchanged' };
  if (offer.label === REROLL_LABEL) return { kind: 'reroll', amount: Number(offer.change.slice(1)) };
  if (offer.label === COST_LABEL) return { kind: 'cost', negative: offer.change.startsWith('-') };
  return { kind: effectNames.includes(offer.label) ? 'effectLevel' : 'axis', name: offer.label, amount: Number(offer.change.slice(1)), negative: offer.change.startsWith('-') };
}

export function voteOffer(texts, vocab, minVotes = 2) {
  const parsed = texts.map(text => parseOfferText(text, vocab));
  const key = pickVote(parsed.map(offer => offer && `${offer.label}|${offer.change}`), minVotes);
  if (!key) return null;
  const [label, change] = key.split('|');
  return { label, change };
}

export function offerToOutcomeId(offer, { family, effects }) {
  if (!offer) return null;
  if (offer.label === KEEP_LABEL) return 'unchanged';
  if (offer.label === REROLL_LABEL) return offer.change === '+1' ? 'reroll.plus1' : offer.change === '+2' ? 'reroll.plus2' : null;
  if (offer.label === COST_LABEL) return offer.change === '+100%' ? 'cost.plus100' : offer.change === '-100%' ? 'cost.minus100' : null;
  const suffix = AXIS_SUFFIX[offer.change];
  if (!suffix) return null;
  if (offer.label === WILLPOWER_LABEL) return `axis0.${suffix}`;
  if (family && offer.label === pointsLabel(family)) return `axis1.${suffix}`;
  const index = Array.isArray(effects) ? effects.indexOf(offer.label) : -1;
  return index === 0 || index === 1 ? `axis${index + 2}.${suffix}` : null;
}

// Display parts for an outcome id: { kind, name, amount, negative }. kind drives the copy template.
export function describeOutcome(id, { family, effects }) {
  if (id === 'unchanged') return { kind: 'unchanged' };
  if (id === 'cost.plus100') return { kind: 'cost', negative: false };
  if (id === 'cost.minus100') return { kind: 'cost', negative: true };
  const reroll = /^reroll\.plus([12])$/.exec(id ?? '');
  if (reroll) return { kind: 'reroll', amount: Number(reroll[1]) };
  const effect = /^effect([01])\.change$/.exec(id ?? '');
  if (effect) return { kind: 'effectChange', name: effects?.[Number(effect[1])] ?? null };
  const axis = /^axis([0-3])\.(plus|minus)([1-4])$/.exec(id ?? '');
  if (!axis) return null;
  const index = Number(axis[1]);
  const name = index === 0 ? WILLPOWER_LABEL : index === 1 ? (family ? pointsLabel(family) : null) : effects?.[index - 2] ?? null;
  return { kind: index >= 2 ? 'effectLevel' : 'axis', name, amount: Number(axis[3]), negative: axis[2] === 'minus' };
}

export function lastDigit(text, allowed = '12345') {
  const digits = [...String(text ?? '')].filter(char => /[0-9]/.test(char));
  const last = digits[digits.length - 1];
  return last && allowed.includes(last) ? Number(last) : null;
}

export function parseAttempts(text) {
  const match = String(text ?? '').match(/(\d)\s*\/\s*(\d)/);
  if (!match) return null;
  const remaining = Number(match[1]), total = Number(match[2]);
  return [5, 7, 9].includes(total) && remaining <= total ? { remaining, total } : null;
}

export function parseRerolls(text) {
  const match = String(text ?? '').match(/(\d{1,2})\s*[회희휘]/);
  return match ? Number(match[1]) : null;
}

export function parseGemPoints(text) {
  const squashed = squash(text);
  const match = squashed.match(/트(\d{1,2})/) || squashed.match(/(\d{1,2})\??$/);
  const value = match ? Number(match[1]) : null;
  return value !== null && value >= 4 && value <= 20 ? value : null;
}

export function parseGold(text) {
  const match = String(text ?? '').replace(/[,.\s]/g, '').match(/^\D*(\d{1,5})\D*$/);
  return match ? Number(match[1]) : null;
}

export function costModifierFromGold(gold, grade, model) {
  if (!Number.isInteger(gold) || !grade) return null;
  if (gold === 0) return -1;
  const base = model.STARTS[grade]?.baseGold;
  if (!Number.isInteger(base)) return null;
  return gold === base ? 0 : gold === base * 2 ? 1 : null;
}

export function gradeForTotal(total, model) {
  const entry = Object.entries(model.STARTS).find(([, start]) => start.attempts === total);
  return entry ? entry[0] : null;
}

// One parser per screen field. The capture loop uses them to stop early once two variants agree,
// and interpretReading uses the same functions for the final vote.
export function fieldParsers(model) {
  const vocab = vocabulary(model);
  const names = vocab.gemNames.map(entry => entry.text);
  return {
    vocab,
    gemName: text => vocab.gemNames.find(entry => entry.text === matchLabel(text, names)?.option)?.subtype ?? null,
    labelPoints: text => matchLabel(text, vocab.pointLabels)?.option ?? null,
    labelEffect: (text, allowed = vocab.effects) => matchLabel(text, allowed, { wholeLabel: true })?.option ?? null,
    gemPoints: parseGemPoints,
    attempts: text => { const parsed = parseAttempts(text); return parsed && `${parsed.remaining}/${parsed.total}`; },
    rerolls: parseRerolls,
    cost: parseGold,
    offer: text => { const parsed = parseOfferText(text, vocab); return parsed && `${parsed.label}|${parsed.change}`; },
  };
}

// ---- pixel helpers (ImageData-like { width, height, data }) ----

export const isTextYellow = (r, g, b) => r > 165 && g > 140 && b < 75 && Math.min(r, g) - b > 110;
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const lumaPlane = ({ width, height, data }) => {
  const values = new Float32Array(width * height);
  for (let p = 0; p < values.length; p++) values[p] = luma(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
  return values;
};

// Ink by shape instead of colour: a pixel that stands above darker pixels within `reach` on both sides of its row
// or its column, which is how the value font's dark outline frames a thin stroke. Brightness keeps full resolution
// in 4:2:0 screen-share video while colour does not, and the flat diamond interior (no outline nearby) drops out.
export function outlinedInk(image, { reach = Math.max(2, Math.round(image.height * 0.2)), contrast = 60 } = {}) {
  const { width, height } = image;
  const values = lumaPlane(image);
  const darker = (x, y, dx, dy, limit) => {
    for (let k = 1; k <= reach; k++) {
      const nx = x + dx * k, ny = y + dy * k;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
      if (values[ny * width + nx] < limit) return true;
    }
    return false;
  };
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const limit = values[y * width + x] - contrast;
    if (limit <= 0) continue;
    if ((darker(x, y, -1, 0, limit) && darker(x, y, 1, 0, limit)) || (darker(x, y, 0, -1, limit) && darker(x, y, 0, 1, limit))) mask[y * width + x] = 1;
  }
  return mask;
}

// Mean of each pixel's (2r+1)² neighbourhood, clipped at the edges, from a summed-area table.
export function localMean(values, width, height, r) {
  const sums = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) { row += values[y * width + x]; sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row; }
  }
  const mean = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(width, x + r + 1), y1 = Math.min(height, y + r + 1);
    const total = sums[y1 * (width + 1) + x1] - sums[y0 * (width + 1) + x1] - sums[y1 * (width + 1) + x0] + sums[y0 * (width + 1) + x0];
    mean[y * width + x] = total / ((x1 - x0) * (y1 - y0));
  }
  return mean;
}

// Ink by local brightness: pixels clearly brighter than their neighbourhood, for value glyphs whose dark outline is
// faint against a bright diamond. Brightness only, like outlinedInk.
export function brighterInk(image, { radius = Math.max(3, Math.round(image.height / 3)), margin = 18, floor = 110 } = {}) {
  const { width, height } = image;
  const values = lumaPlane(image);
  const mean = localMean(values, width, height, radius);
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) mask[p] = values[p] > floor && values[p] > mean[p] + margin ? 1 : 0;
  return mask;
}

export function otsuThreshold(values) {
  const histogram = new Array(256).fill(0);
  for (const value of values) histogram[Math.max(0, Math.min(255, Math.round(value)))]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumBackground = 0, weightBackground = 0, best = -1, threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (!weightBackground) continue;
    const weightForeground = values.length - weightBackground;
    if (!weightForeground) break;
    sumBackground += t * histogram[t];
    const between = weightBackground * weightForeground * (sumBackground / weightBackground - (sum - sumBackground) / weightForeground) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// ink: (r, g, b) => boolean per pixel, or a ready mask (Uint8Array, one entry per pixel).
export function components(image, ink) {
  const { width, height, data } = image;
  let mask = ink;
  if (typeof ink === 'function') {
    mask = new Uint8Array(width * height);
    for (let p = 0; p < width * height; p++) mask[p] = ink(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) ? 1 : 0;
  }
  const seen = new Uint8Array(width * height);
  const list = [];
  for (let start = 0; start < width * height; start++) {
    if (!mask[start] || seen[start]) continue;
    const stack = [start], pixels = [];
    seen[start] = 1;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    while (stack.length) {
      const p = stack.pop(), x = p % width, y = (p - x) / width;
      pixels.push(p);
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    list.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area: pixels.length, pixels });
  }
  return list;
}

// Value line under a diamond label. Effect slots read "Lv. N" (the digit is the rightmost cap-height glyph);
// willpower and point slots read a lone "N" (the cap-height glyph nearest the band centre). Glyphs must sit on
// the same text line as the tallest one, which drops background specks of the same colour. maxHeight (share of the
// band) lets the outline pass drop the diamond's edge lines, which are taller than any glyph.
export function selectValueGlyphs(image, { level = false, predicate = isTextYellow, maxHeight = 0.85 } = {}) {
  const { width, height } = image;
  const sized = components(image, predicate).filter(c => c.h >= 0.27 * height && c.h <= maxHeight * height
    && c.w <= 0.8 * height && c.x0 > 0 && c.x1 < width - 1 && c.area >= 6);
  if (!sized.length) return null;
  const tallest = sized.reduce((best, c) => (c.h > best.h ? c : best));
  const overlap = c => (Math.min(c.y1, tallest.y1) - Math.max(c.y0, tallest.y0) + 1) / c.h;
  const line = sized.filter(c => overlap(c) >= 0.7).sort((a, b) => a.x0 - b.x0);
  const capitals = line.filter(c => c.h >= 0.75 * tallest.h);
  if (level) return { glyphs: line, digit: capitals[capitals.length - 1] };
  const centre = width / 2;
  const digit = capitals.reduce((best, c) => (Math.abs((c.x0 + c.x1) / 2 - centre) < Math.abs((best.x0 + best.x1) / 2 - centre) ? c : best));
  return { glyphs: [digit], digit };
}

// The game font draws "1" as a plain vertical bar, which OCR drops; its shape is one vote for 1.
export function isBarGlyph(component, imageWidth) {
  if (!component || component.h < 7) return false;
  const rows = new Set(component.pixels.map(p => Math.floor(p / imageWidth))).size;
  return component.w <= Math.max(3, Math.round(0.34 * component.h)) && rows / component.h >= 0.85;
}

// ---- interpretation ----

// slots: [{ found, votes: [1..5|null] }] in points[] order. A slot needs two agreeing votes; one vote is
// accepted only when the whole assignment equals the separately read gem points.
export function resolveValues(slots, gemPoints) {
  const direct = slots.map(slot => (slot?.found ? pickVote(slot.votes, 2) : null));
  const values = slots.map((slot, index) => direct[index] ?? (slot?.found ? pickVote(slot.votes, 1) : null));
  const status = slots.map((slot, index) => (direct[index] !== null ? 'ok' : slot?.found ? 'review' : 'unread'));
  let sum = 'unknown';
  if (Number.isInteger(gemPoints)) {
    const missing = values.flatMap((value, index) => (value === null ? [index] : []));
    const total = values.reduce((acc, value) => acc + (value ?? 0), 0);
    if (!missing.length) {
      sum = total === gemPoints ? 'match' : 'mismatch';
      status.fill(sum === 'match' ? 'ok' : 'review');
    } else if (missing.length === 1 && status.every((entry, index) => index === missing[0] || entry === 'ok')) {
      const inferred = gemPoints - total;
      if (inferred >= 1 && inferred <= 5) { values[missing[0]] = inferred; status[missing[0]] = 'inferred'; sum = 'inferred'; }
      else sum = 'mismatch';
    }
  }
  return { values, status, sum };
}

export function resolveSubtype({ name, family, effects }, model) {
  let candidates = Object.keys(model.SUBTYPES);
  let sources = 0;
  if (name) { candidates = candidates.filter(subtype => subtype === name); sources++; }
  if (family) { candidates = candidates.filter(subtype => model.SUBTYPES[subtype].family === family); sources++; }
  const known = (effects || []).filter(Boolean);
  if (known.length) { candidates = candidates.filter(subtype => known.every(effect => model.SUBTYPES[subtype].effects.includes(effect))); sources++; }
  if (candidates.length !== 1) return { subtype: null, status: candidates.length ? 'review' : 'conflict' };
  return { subtype: candidates[0], status: sources >= 2 ? 'ok' : 'review' };
}

// reading: OCR texts per field (strings stay in memory only) plus value-slot evidence.
export function interpretReading(reading, model) {
  const parsers = fieldParsers(model);
  const vocab = parsers.vocab;
  // Name and family are single cross-checks: one unique reading counts, but resolveSubtype still needs two
  // independent sources (name, family, effects) before the subtype counts as read.
  const name = pickVote((reading.gemName || []).map(parsers.gemName), 1);
  const familyLabel = pickVote((reading.labelPoints || []).map(parsers.labelPoints), 1);
  const offers = (reading.offers || []).map(texts => voteOffer(texts, vocab));
  // Offers only name the gem's own family and effects, so they are an independent source for both.
  const offerFamilies = [...new Set(offers.filter(offer => vocab.pointLabels.includes(offer?.label)).map(offer => offer.label.replace(/ 포인트$/, '')))];
  const offerEffects = [...new Set(offers.filter(offer => vocab.effects.includes(offer?.label)).map(offer => offer.label))];
  const family = familyLabel ? familyLabel.replace(/ 포인트$/, '') : offerFamilies.length === 1 ? offerFamilies[0] : null;
  const looseEffects = [0, 1].map(index => pickVote((reading.labelEffects?.[index] || []).map(text => parsers.labelEffect(text))));
  const subtype = resolveSubtype({ name, family, effects: [...new Set([...looseEffects.filter(Boolean), ...offerEffects])] }, model);
  const allowed = subtype.subtype ? model.SUBTYPES[subtype.subtype].effects : vocab.effects;
  const labelVotes = [0, 1].map(index => (reading.labelEffects?.[index] || []).map(text => parsers.labelEffect(text, allowed)));
  const effects = labelVotes.map(votes => pickVote(votes));
  const effectStatus = effects.map(effect => (effect ? 'ok' : 'unread'));
  if (subtype.subtype) {
    for (const index of [0, 1]) {
      if (effects[index]) continue;
      const other = effects[1 - index];
      const single = pickVote(labelVotes[index], 1);
      const fromOffers = offerEffects.filter(effect => allowed.includes(effect) && effect !== other);
      if (single && single !== other && fromOffers.includes(single)) { effects[index] = single; effectStatus[index] = 'ok'; }
      else if (other && fromOffers.length === 1 && (!single || single === fromOffers[0])) { effects[index] = fromOffers[0]; effectStatus[index] = 'inferred'; }
    }
  }
  const gemPoints = pickVote((reading.gemPoints || []).map(parsers.gemPoints));
  const values = resolveValues(reading.values || [], gemPoints);
  const attemptsKey = pickVote((reading.attempts || []).map(parsers.attempts));
  const [remaining, total] = attemptsKey ? attemptsKey.split('/').map(Number) : [null, null];
  const grade = total ? gradeForTotal(total, model) : null;
  const rerolls = pickVote((reading.rerolls || []).map(parsers.rerolls));
  const gold = pickVote((reading.cost || []).map(parsers.cost));
  const costModifier = costModifierFromGold(gold, grade, model);
  const resolvedFamily = subtype.subtype ? model.SUBTYPES[subtype.subtype].family : family;
  const status = {
    subtype: subtype.subtype ? subtype.status : 'unread',
    effects: effectStatus,
    values: values.status,
    gemPoints: gemPoints === null ? 'unread' : 'ok',
    attempts: attemptsKey ? 'ok' : 'unread',
    rerolls: rerolls === null ? 'unread' : 'ok',
    cost: costModifier === null ? 'unread' : 'ok',
  };
  return {
    subtype: subtype.subtype, family: resolvedFamily, grade, effects, points: values.values, sum: values.sum,
    gemPoints, remainingAttempts: remaining, totalAttempts: total, rerollsRemaining: rerolls, costModifier, offers, status,
  };
}

export function stateFromFields(fields) {
  const { grade, subtype, effects, points, totalAttempts, remainingAttempts, rerollsRemaining, costModifier } = fields;
  const complete = grade && subtype && Array.isArray(effects) && effects.every(Boolean) && Array.isArray(points)
    && points.length === 4 && points.every(Number.isInteger) && Number.isInteger(totalAttempts)
    && Number.isInteger(remainingAttempts) && Number.isInteger(rerollsRemaining) && Number.isInteger(costModifier);
  if (!complete) return null;
  return {
    grade, subtype, effects: [...effects], points: [...points], totalAttempts,
    processedCount: totalAttempts - remainingAttempts, remainingAttempts, rerollsRemaining, costModifier,
  };
}

export function checkState(state, engine) {
  if (!state) return { ok: false, reason: 'incomplete' };
  const result = engine.getGemProcessingCandidates(state);
  if (result.status === 'unavailable') return { ok: false, reason: result.reason };
  return { ok: true, finished: result.status === 'complete', candidates: result.candidates.map(outcome => outcome.id) };
}

export function checkOffers(ids, state, engine) {
  if (!Array.isArray(ids) || ids.length !== 4 || ids.some(id => !id)) return { ok: false, reason: 'incomplete' };
  if (new Set(ids).size !== 4) return { ok: false, reason: 'duplicate' };
  const pool = checkState(state, engine);
  if (!pool.ok) return pool;
  if (pool.finished) return { ok: false, reason: 'finished' };
  const ineligible = ids.filter(id => !pool.candidates.includes(id));
  return ineligible.length ? { ok: false, reason: 'unavailable', ineligible } : { ok: true };
}

const sameState = (a, b) => a.grade === b.grade && a.subtype === b.subtype && a.remainingAttempts === b.remainingAttempts
  && a.rerollsRemaining === b.rerollsRemaining && a.costModifier === b.costModifier
  && a.points.every((point, index) => point === b.points[index]) && a.effects.every((effect, index) => effect === b.effects[index]);

// How the tracked state can turn into the newly read one. Only a unique processed match may be applied
// without asking; everything else stops the recommendation until the user confirms.
export function inferTransition(previous, previousOffers, next, engine) {
  if (!previous || !next) return { kind: 'unknown', matches: [] };
  if (previous.subtype !== next.subtype || previous.grade !== next.grade) return { kind: 'newGem', matches: [] };
  if (sameState(previous, next)) return { kind: 'none', matches: [] };
  const sameBody = previous.costModifier === next.costModifier && previous.points.every((point, index) => point === next.points[index])
    && previous.effects.every((effect, index) => effect === next.effects[index]);
  if (sameBody && next.remainingAttempts === previous.remainingAttempts && next.rerollsRemaining === previous.rerollsRemaining - 1) {
    return { kind: 'reroll', matches: [] };
  }
  if (next.remainingAttempts === next.totalAttempts && previous.processedCount > 0) return { kind: 'resetOrNewGem', matches: [] };
  if (next.remainingAttempts === previous.remainingAttempts - 1 && Array.isArray(previousOffers)) {
    const matches = [];
    for (const id of previousOffers) {
      const result = engine.applyGemProcessingOutcome(previous, id);
      if (result.status !== 'ok') continue;
      if (result.branches.some(branch => sameState(branch.state, next))) matches.push(id);
    }
    return { kind: matches.length === 1 ? 'processed' : matches.length ? 'ambiguous' : 'unknown', matches };
  }
  return { kind: 'unknown', matches: [] };
}

// ---- regions ----

export function deriveRegions(anchor) {
  const [ax, ay, aw, ah] = anchor;
  const [rx, ry, rw, rh] = REFERENCE_LAYOUT.anchor;
  const sx = aw / rw, sy = ah / rh;
  return Object.fromEntries(Object.entries(REFERENCE_LAYOUT.regions).map(([key, [x, y, w, h]]) => [key, [ax + (x - rx) * sx, ay + (y - ry) * sy, w * sx, h * sy]]));
}

export function clampBox(box, width, height, minSide = 4) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
  const x0 = Math.max(0, Math.round(box[0])), y0 = Math.max(0, Math.round(box[1]));
  const x1 = Math.min(width, Math.round(box[0] + box[2])), y1 = Math.min(height, Math.round(box[1] + box[3]));
  return x1 - x0 >= minSide && y1 - y0 >= minSide ? [x0, y0, x1 - x0, y1 - y0] : null;
}

export function splitRow([x, y, w, h], parts = 4) {
  return Array.from({ length: parts }, (_, index) => [x + (index * w) / parts, y, w / parts, h]);
}

// ---- targets ----

// clauses: [{ willpower, corePoints, total, effects: [{ name, level }] }] with '' meaning "no limit".
export function buildTarget(clauses, allowedEffects) {
  if (!Array.isArray(clauses) || clauses.length < 1 || clauses.length > 25) return { error: 'clause_count' };
  const anyOf = [];
  for (const clause of clauses) {
    const entry = {};
    const number = value => (value === '' || value === null || value === undefined ? undefined : Number(value));
    const willpower = number(clause.willpower), corePoints = number(clause.corePoints), total = number(clause.total);
    if (willpower !== undefined) { if (!Number.isInteger(willpower) || willpower < 1 || willpower > 5) return { error: 'range' }; entry.willpowerEfficiencyAtLeast = willpower; }
    if (corePoints !== undefined) { if (!Number.isInteger(corePoints) || corePoints < 1 || corePoints > 5) return { error: 'range' }; entry.corePointsAtLeast = corePoints; }
    if (total !== undefined) { if (!Number.isInteger(total) || total < 4 || total > 20) return { error: 'range' }; entry.totalPointsAtLeast = total; }
    const effects = (clause.effects || []).filter(effect => effect && effect.name);
    if (effects.length > 2) return { error: 'effect_count' };
    if (new Set(effects.map(effect => effect.name)).size !== effects.length) return { error: 'duplicate_effect' };
    for (const effect of effects) {
      const level = Number(effect.level);
      if (!allowedEffects?.includes(effect.name)) return { error: 'effect_not_allowed' };
      if (!Number.isInteger(level) || level < 1 || level > 5) return { error: 'range' };
    }
    if (effects.length) entry.effects = effects.map(effect => ({ name: effect.name, levelAtLeast: Number(effect.level) }))
      .sort((a, b) => allowedEffects.indexOf(a.name) - allowedEffects.indexOf(b.name));
    if (!Object.keys(entry).length) return { error: 'empty_clause' };
    anyOf.push(entry);
  }
  return { target: { anyOf } };
}

// A worker result is used only for the request still pending and for the current generation.
export function isCurrentResult(message, pending, generation) {
  return Boolean(message && message.type === 'result' && pending && message.requestId === pending.requestId
    && message.generation === generation && pending.generation === generation && message.result && message.result.status !== 'cancelled');
}
