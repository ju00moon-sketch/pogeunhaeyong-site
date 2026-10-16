/* Ranking page: one role board of the published LOPEC top-100 snapshot (data/lopec-rankings.json, contract v1).
   File values go in as text only, links point at the fixed LOPEC page, and a file outside the contract shows the error
   state instead of a smaller or empty board. Words come from ranking-copy.js. */
(() => {
  'use strict';
  const model = window.PogeunRankingModel;
  const main = document.getElementById('main-content');
  if (!model || !main) return;
  const copy = window.POGEUN_RANKING_COPY ?? {};
  const reported = new Set();
  const text = key => {
    if (typeof copy[key] === 'string' && copy[key] !== '') return copy[key];
    if (!reported.has(key)) { reported.add(key); console.error(`ranking copy missing: ${key}`); }
    return '';
  };
  // Puts a copy template into a node; its slots become text, or the element given for that slot.
  const put = (node, key, values, elements = {}) => node.replaceChildren(
    ...model.templateParts(text(key), values).map(part => (typeof part === 'string' ? part : elements[part.slot] ?? String(part.value))),
  );

  for (const node of main.querySelectorAll('[data-copy]')) node.textContent = text(node.dataset.copy);
  for (const node of main.querySelectorAll('[data-copy-placeholder]')) node.placeholder = text(node.dataset.copyPlaceholder);
  for (const node of main.querySelectorAll('[data-copy-label]')) node.setAttribute('aria-label', text(node.dataset.copyLabel));
  if (text('meta.title')) document.title = text('meta.title');
  if (text('meta.description')) {
    const meta = document.querySelector('meta[name="description"]') ?? document.head.appendChild(document.createElement('meta'));
    meta.name = 'description'; meta.content = text('meta.description');
  }

  const ui = {
    roles: [...main.querySelectorAll('[data-role]')],
    filters: document.getElementById('ranking-filters'),
    search: document.getElementById('ranking-search'),
    server: document.getElementById('ranking-server'),
    className: document.getElementById('ranking-class'),
    reset: document.getElementById('ranking-reset'),
    source: main.querySelector('[data-ranking-source]'),
    notice: main.querySelector('[data-ranking-notice]'),
    coverage: main.querySelector('[data-ranking-coverage]'),
    collected: main.querySelector('[data-ranking-collected]'),
    count: main.querySelector('[data-ranking-count]'),
    table: main.querySelector('.ranking-table'),
    caption: main.querySelector('[data-ranking-caption]'),
    rows: main.querySelector('[data-ranking-rows]'),
    status: main.querySelector('[data-ranking-status]'),
  };
  const emptyFilters = () => ({ query: '', server: '', className: '' });
  const view = { data: null, role: model.ROLES[0], filters: emptyFilters() };

  function fillSelect(select, values, selected, allLabel) {
    const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
    select.replaceChildren(option('', allLabel), ...values.map(value => option(value, value)));
    select.value = selected;
  }

  // loading and error keep the board closed; only ready shows coverage, time, count and rows.
  function show(state) {
    main.dataset.rankingState = state;
    main.setAttribute('aria-busy', String(state === 'loading'));
    const ready = state === 'ready';
    for (const control of [...ui.roles, ui.search, ui.server, ui.className, ui.reset]) control.disabled = !ready;
    ui.coverage.hidden = ui.collected.hidden = ui.count.hidden = !ready;
    if (!ready) {
      ui.table.hidden = true;
      ui.status.hidden = false;
      ui.status.textContent = text(state === 'loading' ? 'state.loading' : 'state.error');
    }
  }

  const cell = (tag, name, value) => { const node = document.createElement(tag); node.className = name; node.textContent = value; return node; };
  function row(item) {
    const tr = document.createElement('tr');
    if (item.rank <= 3) tr.className = 'ranking-top';
    const level = model.formatLevel(item.itemLevel);
    const name = cell('th', 'ranking-name', '');
    name.scope = 'row';
    // On phones the server, class and level columns fold into lines under the name (one of the two is display:none).
    const sub = cell('span', 'ranking-sub', '');
    sub.append(cell('span', 'ranking-sub-job', `${item.server} · ${item.classLabel}`), cell('span', 'ranking-sub-level', `Lv.${level}`));
    name.append(cell('span', 'ranking-character', item.characterName), sub);
    tr.append(cell('td', 'ranking-rank', String(item.rank)), name, cell('td', 'ranking-server', item.server),
      cell('td', 'ranking-class', item.classLabel), cell('td', 'ranking-level', level), cell('td', 'ranking-score', model.formatScore(item.score)));
    return tr;
  }

  function render(rebuildOptions = false) {
    const board = view.data.boards[view.role];
    for (const button of ui.roles) button.setAttribute('aria-pressed', String(button.dataset.role === view.role));
    ui.source.href = board.sourceUrl;
    if (rebuildOptions) {
      const { servers, classes } = model.options(board.entries);
      fillSelect(ui.server, servers, view.filters.server, text('filter.server.all'));
      fillSelect(ui.className, classes, view.filters.className, text('filter.class.all'));
    }
    const rows = model.filterEntries(board.entries, view.filters);
    put(ui.caption, 'table.caption', { role: text(`role.${view.role}`) });
    put(ui.count, 'result.count', { shown: rows.length, total: board.entries.length });
    ui.rows.replaceChildren(...rows.map(row));
    ui.table.hidden = rows.length === 0;
    ui.status.hidden = rows.length !== 0;
    ui.status.textContent = rows.length ? '' : text('state.empty');
  }

  async function load() {
    show('loading');
    const controller = new AbortController();
    // One 15-second deadline for the whole answer, headers and body alike.
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      // Only this site's own copy of the file; another origin, a redirect or a partial answer never becomes the board.
      const url = new URL('data/lopec-rankings.json', document.baseURI);
      if (url.origin !== location.origin) throw new Error('snapshot origin');
      const response = await fetch(url, { signal: controller.signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } });
      const result = model.parse(await model.readSnapshot(response, url.href));
      if (!result.ok) throw new Error(`contract: ${result.reason}`);
      view.data = result.value;
    } catch (error) {
      controller.abort();
      console.error('ranking data unavailable', error);
      show('error');
      return;
    } finally {
      clearTimeout(timer);
    }
    const time = document.createElement('time');
    time.dateTime = view.data.collectedAt;
    time.textContent = model.formatCollected(view.data.collectedAt);
    put(ui.collected, 'collected', { time: time.textContent }, { time });
    put(ui.coverage, 'coverage', { limit: view.data.limitPerRole });
    show('ready');
    render(true);
  }

  put(ui.notice, 'notice', { limit: model.LIMIT });
  fillSelect(ui.server, [], '', text('filter.server.all'));
  fillSelect(ui.className, [], '', text('filter.class.all'));
  for (const button of ui.roles) {
    button.addEventListener('click', () => {
      if (!view.data || button.dataset.role === view.role) return;
      view.role = button.dataset.role;
      view.filters = model.reconcile(view.filters, view.data.boards[view.role].entries);
      render(true);
    });
  }
  ui.filters.addEventListener('submit', event => event.preventDefault());
  ui.search.addEventListener('input', () => { view.filters.query = ui.search.value; if (view.data) render(); });
  ui.server.addEventListener('change', () => { view.filters.server = ui.server.value; if (view.data) render(); });
  ui.className.addEventListener('change', () => { view.filters.className = ui.className.value; if (view.data) render(); });
  ui.reset.addEventListener('click', () => {
    view.filters = emptyFilters();
    ui.search.value = ''; ui.server.value = ''; ui.className.value = '';
    if (view.data) render();
  });
  void load();
})();
