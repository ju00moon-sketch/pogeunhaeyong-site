(() => {
  'use strict';
  // UI catalog: filters, device/theme views and a viewer over the captured screens. All visible text comes from the
  // generated page (copy.json via scripts/build-ui-catalog.py); this script only switches states.
  const root = document.querySelector('.ui-catalog');
  const data = JSON.parse(document.getElementById('ui-items').textContent);
  const items = new Map(data.items.map(item => [item.id, item]));
  const cards = [...document.querySelectorAll('.ui-card')];
  const groups = [...document.querySelectorAll('.ui-group')];
  const controls = document.querySelector('.ui-controls');
  const count = document.querySelector('.ui-count');
  const viewer = document.querySelector('.ui-viewer');
  const state = { version: 'all', group: 'all', device: 'pc', theme: 'dark' };
  const params = new URLSearchParams(location.search);
  for (const key of Object.keys(state)) {
    const value = params.get(key);
    if (value && document.querySelector(`[data-${key === 'device' || key === 'theme' ? 'view' : 'filter'}-${key}="${CSS.escape(value)}"]`)) state[key] = value;
  }

  function shot(item, device, theme) {
    return item.shots[device]?.[theme] || item.shots.pc?.[theme] || item.shots.pc.dark;
  }
  function paintCard(card) {
    const item = items.get(card.dataset.id);
    const s = shot(item, state.device, state.theme);
    const img = card.querySelector('.ui-thumb img');
    img.src = s.thumb; img.width = s.thumbWidth; img.height = s.thumbHeight; img.alt = s.alt;
    card.querySelector('.ui-thumb').href = s.src;
  }
  function visible(card) {
    return (state.version === 'all' || card.dataset.version === state.version) && (state.group === 'all' || card.dataset.group === state.group);
  }
  function render() {
    root.dataset.device = state.device;
    for (const button of controls.querySelectorAll('button')) {
      const [kind, value] = Object.entries(button.dataset).find(([key]) => /^(filter|view)/.test(key)) || [];
      if (!kind) continue;
      const key = kind.replace(/^(filter|view)/, '').toLowerCase();
      button.setAttribute('aria-pressed', String(state[key] === value));
    }
    let shown = 0;
    for (const card of cards) { const on = visible(card); card.hidden = !on; if (on) { shown++; paintCard(card); } }
    for (const group of groups) group.hidden = !group.querySelector('.ui-card:not([hidden])');
    count.textContent = count.dataset.template.replace('{n}', String(shown));
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(state)) if (value !== { version: 'all', group: 'all', device: 'pc', theme: 'dark' }[key]) query.set(key, value);
    history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}${location.hash}`);
  }
  controls.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const entry = Object.entries(button.dataset).find(([key]) => /^(filter|view)/.test(key));
    if (!entry) return;
    state[entry[0].replace(/^(filter|view)/, '').toLowerCase()] = entry[1];
    render();
  });

  // Viewer
  const view = { id: null, device: 'pc', theme: 'dark', opener: null };
  const stage = viewer.querySelector('.ui-viewer-images');
  const live = viewer.querySelector('[data-viewer-live]');
  const noLive = viewer.querySelector('[data-viewer-nolive]');
  const counterpart = viewer.querySelector('[data-viewer-counterpart]');
  const segmentsNote = viewer.querySelector('.ui-viewer-segments');
  const themeLabel = theme => viewer.querySelector(`[data-viewer-theme="${theme}"]`).textContent;
  function order() { return cards.filter(card => !card.hidden).map(card => card.dataset.id); }
  function twin(id) { const other = id.startsWith('previous-') ? id.replace(/^previous-/, 'current-') : id.replace(/^current-/, 'previous-'); return items.has(other) ? other : null; }
  // A long page is stored as consecutive segments; they are stacked so the page reads as one continuous image.
  function figure(item, theme, caption) {
    const s = shot(item, view.device, theme);
    const fig = document.createElement('figure');
    if (caption) { const cap = document.createElement('figcaption'); cap.textContent = themeLabel(theme); fig.append(cap); }
    for (const [index, part] of (s.segments || [s]).entries()) {
      const img = document.createElement('img');
      img.src = part.src; img.width = s.width; img.height = part.height; img.decoding = 'async';
      img.alt = index ? '' : s.alt;
      fig.append(img);
    }
    return fig;
  }
  function paintViewer() {
    const item = items.get(view.id);
    const card = cards.find(c => c.dataset.id === view.id);
    viewer.querySelector('.ui-viewer-title h2').textContent = card.querySelector('h3').textContent;
    viewer.querySelector('.ui-viewer-title p').textContent = card.querySelector('.ui-card-meta').textContent.replace(/\s+/g, ' ').trim();
    for (const button of viewer.querySelectorAll('[data-viewer-device]')) button.setAttribute('aria-pressed', String(button.dataset.viewerDevice === view.device));
    for (const button of viewer.querySelectorAll('[data-viewer-theme]')) button.setAttribute('aria-pressed', String(button.dataset.viewerTheme === view.theme));
    const themes = view.theme === 'compare' ? ['dark', 'light'] : [view.theme];
    const figures = themes.map(theme => figure(item, theme, themes.length > 1));
    stage.dataset.count = String(figures.length);
    stage.replaceChildren(...figures);
    const parts = Math.max(...themes.map(theme => shot(item, view.device, theme).segments?.length || 1));
    segmentsNote.hidden = parts < 2;
    if (parts > 1) segmentsNote.textContent = segmentsNote.dataset.template.replace('{n}', String(parts));
    live.hidden = !item.live; noLive.hidden = !!item.live;
    if (item.live) live.href = item.live;
    const other = twin(view.id);
    counterpart.hidden = !other;
    if (other) counterpart.textContent = counterpart.dataset[other.startsWith('previous-') ? 'labelPrevious' : 'labelCurrent'];
    viewer.querySelector('[data-viewer-prev]').disabled = !neighbour(-1);
    viewer.querySelector('[data-viewer-next]').disabled = !neighbour(1);
    viewer.querySelector('.ui-viewer-stage').scrollTo({ top: 0, behavior: 'instant' });
    history.replaceState(null, '', `${location.pathname}${location.search}#ui-${view.id}`);
  }
  function open(id, opener) {
    if (!items.has(id)) return;
    view.id = id; view.device = state.device; view.theme = state.theme; view.opener = opener || null;
    paintViewer();
    if (!viewer.open) viewer.showModal();
  }
  // Buttons and arrow keys share this boundary: an item outside the filtered list (counterpart view or a deep link
  // that the filter hides) has no previous/next neighbour.
  function neighbour(delta) {
    const list = order();
    const index = list.indexOf(view.id);
    return index === -1 ? null : list[index + delta] || null;
  }
  function step(delta) {
    const next = neighbour(delta);
    if (next) { view.id = next; paintViewer(); }
  }
  viewer.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (event.target === viewer) { viewer.close(); return; }
    if (!target) return;
    if (target.dataset.viewerDevice) { view.device = target.dataset.viewerDevice; paintViewer(); }
    else if (target.dataset.viewerTheme) { view.theme = target.dataset.viewerTheme; paintViewer(); }
    else if (target.hasAttribute('data-viewer-prev')) step(-1);
    else if (target.hasAttribute('data-viewer-next')) step(1);
    else if (target.hasAttribute('data-viewer-counterpart')) { const other = twin(view.id); if (other) { view.id = other; paintViewer(); } }
    else if (target.hasAttribute('data-viewer-close')) viewer.close();
  });
  viewer.addEventListener('keydown', event => {
    if (event.target.closest('input, select, textarea')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
  });
  // Focus after closing: the shown item's card if it is visible, else the control that opened the viewer, else the
  // main region (a deep link to an item the filter hides has neither).
  viewer.addEventListener('close', () => {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    const card = cards.find(c => c.dataset.id === view.id);
    const opener = view.opener?.isConnected && !view.opener.closest('[hidden]') ? view.opener : null;
    (card && !card.hidden ? card.querySelector('.ui-thumb') : opener || root).focus({ preventScroll: false });
  });
  for (const card of cards) {
    card.querySelector('.ui-thumb').addEventListener('click', event => { event.preventDefault(); open(card.dataset.id, event.currentTarget); });
    card.querySelector('[data-open]')?.addEventListener('click', event => open(card.dataset.id, event.currentTarget));
  }

  controls.hidden = false;
  for (const button of document.querySelectorAll('.ui-card [data-open]')) button.hidden = false;
  render();
  const deep = location.hash.match(/^#ui-(.+)$/);
  if (deep && items.has(decodeURIComponent(deep[1]))) open(decodeURIComponent(deep[1]));
})();
