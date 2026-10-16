/* Ranking page model: checks the published LOPEC snapshot against static-data contract v1 and filters one role
   board. No DOM here; ranking.js renders what this returns. */
(function (root) {
  'use strict';
  const SOURCE_URL = 'https://lopec.kr/rank/specPoint';
  const ROLES = Object.freeze(['dealer', 'support']);
  // The public first page observed for each role; a board may link only to its own one, exactly.
  const BOARD_URLS = Object.freeze({ dealer: SOURCE_URL, support: `${SOURCE_URL}?role=sup` });
  const LIMIT = 100;
  const MAX_BYTES = 256 * 1024;
  // Shared contract: every public text field, classLabel included, is at most 64 UTF-16 code units (the provider's limit).
  const MAX_TEXT = 64;

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  // Public text from the source: non-blank, within the shared limit, no control characters. Shown trimmed.
  const publicText = value => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT
    && !/[\u0000-\u001f\u007f]/.test(value);
  const measure = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const collectedAt = value => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value) && Number.isFinite(Date.parse(value));

  // classLabel is the whole class cell as the source shows it ("서폿 바드"); className is the plain class split out of it,
  // used only by the class filter.
  function entry(raw, index) {
    if (!isObject(raw) || raw.rank !== index + 1) return null;
    const { characterName, server, className, classLabel, itemLevel, score } = raw;
    if (![characterName, server, className, classLabel].every(publicText)) return null;
    if (!measure(itemLevel) || !measure(score)) return null;
    return Object.freeze({
      rank: raw.rank, characterName: characterName.trim(), server: server.trim(), className: className.trim(),
      classLabel: classLabel.trim(), itemLevel, score,
    });
  }

  // Returns { ok: true, value } or { ok: false, reason }. A snapshot that is incomplete or off-contract never comes
  // back as a smaller board.
  function validate(data) {
    const fail = reason => ({ ok: false, reason });
    if (!isObject(data)) return fail('shape');
    if (data.schemaVersion !== 1) return fail('schemaVersion');
    if (!isObject(data.source) || data.source.id !== 'lopec' || data.source.url !== SOURCE_URL) return fail('source');
    if (!collectedAt(data.collectedAt)) return fail('collectedAt');
    if (data.limitPerRole !== LIMIT) return fail('limitPerRole');
    if (!Array.isArray(data.boards) || data.boards.length !== ROLES.length) return fail('boards');
    const boards = {};
    for (const board of data.boards) {
      if (!isObject(board) || !ROLES.includes(board.role) || boards[board.role]) return fail('role');
      if (board.sourceUrl !== BOARD_URLS[board.role]) return fail('sourceUrl');
      if (!Array.isArray(board.entries) || board.entries.length !== LIMIT) return fail('entries');
      const entries = board.entries.map(entry);
      if (entries.includes(null)) return fail('entry');
      boards[board.role] = Object.freeze({ role: board.role, sourceUrl: board.sourceUrl, entries: Object.freeze(entries) });
    }
    return { ok: true, value: Object.freeze({ collectedAt: data.collectedAt, limitPerRole: LIMIT, boards: Object.freeze(boards) }) };
  }

  function parse(text) {
    if (typeof text !== 'string') return { ok: false, reason: 'shape' };
    if (new TextEncoder().encode(text).length > MAX_BYTES) return { ok: false, reason: 'size' };
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, reason: 'json' }; }
    return validate(data);
  }

  // Reads the snapshot answer the same way the server's bounded readers do (src/notice-site.js): only an exact 200
  // application/json answer from the expected address, never redirected, at most MAX_BYTES counted while it streams,
  // strict UTF-8. Anything else is cancelled and rejected before a single row is shown.
  async function readSnapshot(response, expectedUrl) {
    const refuse = reason => {
      void response.body?.cancel?.()?.catch?.(() => {});
      throw Object.assign(new Error(`snapshot ${reason}`), { reason });
    };
    if (response.status !== 200) refuse('status');
    if (response.redirected || response.url !== expectedUrl) refuse('url');
    if ((response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') refuse('type');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) refuse('size');
    const reader = response.body?.getReader?.();
    if (!reader) refuse('body');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) throw Object.assign(new Error('snapshot size'), { reason: 'size' });
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
    }
  }

  const collator = new Intl.Collator('ko-KR');
  const distinct = values => [...new Set(values)].sort(collator.compare);
  const options = entries => ({ servers: distinct(entries.map(item => item.server)), classes: distinct(entries.map(item => item.className)) });
  const fold = value => String(value ?? '').normalize('NFC').trim().toLocaleLowerCase('ko-KR');

  // A role change keeps the name search; a server or class the new board does not have goes back to "all".
  function reconcile(filters, entries) {
    const { servers, classes } = options(entries);
    return {
      query: filters.query,
      server: servers.includes(filters.server) ? filters.server : '',
      className: classes.includes(filters.className) ? filters.className : '',
    };
  }

  // Filters within the captured board only; entries keep their source rank.
  function filterEntries(entries, filters) {
    const query = fold(filters.query);
    return entries.filter(item => (!filters.server || item.server === filters.server)
      && (!filters.className || item.className === filters.className)
      && (!query || fold(item.characterName).includes(query)));
  }

  const seoul = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  // Collection time in Korea, short 24-hour form, e.g. "2026. 10. 16. 15:04".
  function formatCollected(iso) {
    const part = Object.fromEntries(seoul.formatToParts(new Date(iso)).map(item => [item.type, item.value]));
    return `${part.year}. ${part.month}. ${part.day}. ${part.hour}:${part.minute}`;
  }
  // The source shows both item level and score with two decimals.
  const twoDecimals = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatLevel = value => twoDecimals.format(value);
  const formatScore = value => twoDecimals.format(value);

  // Splits a copy template into text and named slots, so callers can put elements (a <time>) into a sentence.
  function templateParts(template, values) {
    const parts = [];
    let last = 0;
    for (const match of template.matchAll(/\{(limit|time|shown|total|role)\}/g)) {
      if (!(match[1] in values)) continue;
      parts.push(template.slice(last, match.index), { slot: match[1], value: values[match[1]] });
      last = match.index + match[0].length;
    }
    parts.push(template.slice(last));
    return parts.filter(part => part !== '');
  }
  const fill = (template, values) => templateParts(template, values).map(part => (typeof part === 'string' ? part : String(part.value))).join('');

  root.PogeunRankingModel = Object.freeze({
    SOURCE_URL, BOARD_URLS, ROLES, LIMIT, MAX_BYTES, validate, parse, readSnapshot, options, reconcile, filterEntries,
    formatCollected, formatLevel, formatScore, templateParts, fill,
  });
})(typeof window !== 'undefined' ? window : globalThis);
