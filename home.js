(() => {
  'use strict';
  const controllers = new Set(), namePattern = /^[가-힣A-Za-z0-9]{2,12}$/;
  let loaded = false, epoch = 0, charactersMode = 'recent', goldRequest = 0, personalReady = false;
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = String(text); return e; };
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const date = x => finite(x) && Math.abs(x) <= 8640000000000000;
  const money = x => finite(x) && x >= 0 ? x.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
  const shortDate = x => date(x) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit' }).format(x).replace(/\.$/, '') : '';
  const time = x => date(x) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(x) : '';
  const byId = id => document.getElementById(id);
  let homeCharacterTouched = false;
  function representative(data) {
    const target = byId('home-representative'), character = data?.representative;
    target.replaceChildren(); target.hidden = !personalReady;
    if (!personalReady) return;
    if (!character || !namePattern.test(character.characterName || '')) {
      if (!homeCharacterTouched) byId('home-character').value = '';
      const link = node('a', '', '내 계정에서 대표 캐릭터 설정'); link.href = 'account.html'; target.append(link); return;
    }
    const link = node('a', 'dashboard-representative-link'); link.href = `spec.html?characterName=${encodeURIComponent(character.characterName)}`;
    const content = node('span'); content.append(node('small', '', '내 대표 캐릭터'), node('strong', '', character.characterName), node('span', '', `${character.serverName} · ${character.characterClass} · Lv.${money(character.itemLevel)}`));
    link.append(content, node('span', 'dashboard-representative-go', '바로 조회')); target.append(link);
    if (!homeCharacterTouched) byId('home-character').value = character.characterName;
  }
  function svg(tag, attrs = {}) { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, String(value)); return e; }
  function safeUrl(value, image = false) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash && (image ? ['cdn-lostark.game.onstove.com', 'img.lostark.co.kr'].includes(u.hostname) : u.hostname === 'lostark.game.onstove.com') ? u.href : null; } catch { return null; } }
  function picture(value, target) { const url = safeUrl(value, true); if (!url) return; const img = node('img'); img.src = url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.addEventListener('error', () => img.remove(), { once: true }); target.append(img); }
  function empty(target, text) { target.replaceChildren(node('p', 'realm-empty', text)); }
  // 게임 정보·시세·최근 조회는 누구나 본다. 로그인과 소유 인증이 필요한 내 숙제표 안내만 #home-access-status에 둔다.
  function showAccess(detail) {
    const status = byId('home-access-status');
    status.replaceChildren();
    const copy = detail?.personal === 'anonymous'
      ? ['캐릭터 조회와 시세 계산은 누구나 이용할 수 있어요. 내 숙제표는 로그인과 캐릭터 소유 인증 후 이용할 수 있고, 길드 일정과 출석은 가입 승인 후 열립니다.', '로그인']
      : detail?.personal === 'ownership_required'
        ? ['내 숙제표는 캐릭터 소유 인증 후 이용할 수 있고, 길드 일정과 출석은 가입 승인 후 열립니다.', '내 계정에서 인증하기']
        : null;
    if (!copy) return;
    const link = node('a', '', copy[1]); link.href = 'account.html';
    status.append(copy[0], ' ', link);
  }
  async function json(path) {
    const controller = new AbortController(); controllers.add(controller); const timeout = setTimeout(() => controller.abort(), 12000);
    try { const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } }); if (!response.ok) throw Object.assign(new Error(), { status: response.status }); const data = await response.json(); controller.signal.throwIfAborted(); return data; }
    finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  async function load(id, path, render) {
    const current = epoch, target = byId(id);
    try { const data = await json(path); if (current === epoch) render(target, data); }
    catch (error) {
      if (current !== epoch) return;
      const p = node('p', 'realm-empty', error.status === 429 ? '조회 요청이 많습니다. 잠시 후 다시 확인해 주세요. ' : '정보를 불러오지 못했습니다. ');
      const retry = node('button', 'realm-action', '다시 불러오기'); retry.type = 'button'; retry.addEventListener('click', () => { empty(target, '불러오는 중입니다.'); void load(id, path, render); }); p.append(retry); target.replaceChildren(p);
    }
  }
  function characters() {
    const target = byId('home-characters'); let names = [];
    try { const raw = JSON.parse(localStorage.getItem(charactersMode === 'favorites' ? 'pogeun-character-favorites' : 'pogeun-character-recent')); if (Array.isArray(raw)) names = [...new Map(raw.filter(name => typeof name === 'string').map(name => name.normalize('NFC').trim()).filter(name => namePattern.test(name)).map(name => [name.toLowerCase(), name])).values()].slice(0, 5); } catch { /* Storage is optional. */ }
    target.replaceChildren();
    if (!names.length) { const content = node('div', 'dashboard-personal-empty'); content.append(node('p', '', charactersMode === 'favorites' ? '캐릭터 화면에서 즐겨찾기를 추가하세요.' : '조회한 캐릭터가 여기에 표시됩니다.')); const a = node('a', '', '캐릭터 검색하기'); a.href = 'spec.html'; content.append(a); target.append(content); return; }
    names.forEach(name => { const a = node('a', 'dashboard-character'); a.href = `spec.html?characterName=${encodeURIComponent(name)}`; a.title = `${name} 스펙 조회`; const avatar = node('span', 'dashboard-character-avatar', name.slice(0, 1)); avatar.setAttribute('aria-hidden', 'true'); a.append(avatar, node('span', 'dashboard-character-name', name), node('small', 'dashboard-character-open', '스펙 보기')); target.append(a); });
  }
  function events(target, data) {
    const items = Array.isArray(data.items) ? data.items.filter(item => item && typeof item.title === 'string' && safeUrl(item.url) && (!date(item.endAt) || item.endAt >= Date.now())).slice(0, 5) : [];
    target.replaceChildren(); if (!items.length) return empty(target, '현재 표시할 이벤트가 없습니다.');
    for (const item of items) { const a = node('a', 'dashboard-event'); a.href = safeUrl(item.url); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = item.title; picture(item.image, a); const text = node('div'); text.append(node('b', '', item.title), node('small', '', date(item.endAt) ? `${shortDate(item.endAt)}까지` : '공식 이벤트')); a.append(text); target.append(a); }
  }
  function calendar(target, data) {
    const now = Date.now(); const items = (Array.isArray(data.items) ? data.items : []).filter(item => item && typeof item.name === 'string' && Array.isArray(item.starts)).map(item => ({ ...item, next: item.starts.filter(value => date(value) && value >= now && value < now + 7 * 86400000).sort((a,b) => a-b)[0] })).filter(item => item.next).sort((a,b) => a.next-b.next).slice(0, 5);
    target.replaceChildren(); if (!items.length) return empty(target, '공식 일정에 등록된 다음 콘텐츠가 없습니다.');
    for (const item of items) { const row = node('div', 'dashboard-calendar-item'); row.title = `${item.name} · ${shortDate(item.next)} ${time(item.next)} 한국 시간`; const when = node('div', 'dashboard-time'); when.append(node('span', '', shortDate(item.next)), node('b', '', time(item.next))); row.append(when); picture(item.icon, row); const content = node('div'); content.append(node('strong', '', item.name), node('small', '', `${item.category || '콘텐츠'}${item.minItemLevel ? ` · Lv.${money(item.minItemLevel)}` : ''}`)); row.append(content); target.append(row); }
  }
  function notices(target, data) {
    const items = Array.isArray(data.items) ? data.items.filter(item => item && typeof item.title === 'string' && safeUrl(item.url)).slice(0, 5) : [];
    target.replaceChildren(); if (!items.length) return empty(target, '현재 표시할 공지가 없습니다.');
    for (const item of items) { const a = node('a', 'dashboard-notice'); a.href = safeUrl(item.url); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = item.title; const when = node('time', '', shortDate(item.date)); if (date(item.date)) when.dateTime = new Date(item.date).toISOString(); const content = node('div'); content.append(node('b', '', item.title), node('small', '', item.type || '공지')); a.append(when, content); target.append(a); }
  }
  function change(value) { const e = node('span', `dashboard-change${finite(value) ? value > 0 ? ' up' : value < 0 ? ' down' : '' : ''}`, finite(value) ? `${value > 0 ? '▲ +' : value < 0 ? '▼ ' : ''}${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%` : '비교 정보 없음'); e.title = '전일 평균가 대비 현재 최저가'; return e; }
  function itemLink(item, category) { return `tools.html?${new URLSearchParams({ q: item.name, category: String(Number.isSafeInteger(category) && category > 0 ? category : 50010) })}`; }
  function goldHistory(target, data) {
    if (data?.unit?.gold !== 10000 || data.unit.currency !== 'KRW' || data.server?.id !== byId('home-gold-server').value || !Array.isArray(data.history)) return empty(target, '같은 서버의 시세 기록을 확인할 수 없습니다.');
    const rows = data.history.filter(row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && date(row.time) && finite(row.price) && row.price > 0).sort((a,b) => a.time-b.time).slice(-14);
    if (!rows.length) return empty(target, '확인된 골드 시세가 없습니다.');
    const latest = rows.at(-1), today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    target.replaceChildren(); const summary = node('div', 'dashboard-history-value');
    const delta = change(data.changePercent); delta.title = '전일 마감가 대비';
    summary.append(node('b', '', data.server.name + ' · 1만 골드'), node('strong', '', money(latest.price) + ' 원'), delta, node('small', '', latest.date === today ? '오늘 현재가' : latest.date + ' 마감가'));
    const plot = node('div', 'dashboard-history-plot'); plot.append(node('p', '', '일별 시세 · 1만 골드당 원'));
    const chart = svg('svg', { viewBox: '0 0 280 112', role: 'img', 'aria-label': data.server.name + ' 골드 시세. ' + rows[0].date + '부터 ' + latest.date + '까지' });
    const description = svg('desc'); description.textContent = rows.map(row => row.date + ': ' + money(row.price) + '원').join('; '); chart.append(description);
    const minimum = Math.min(...rows.map(row => row.price)), maximum = Math.max(...rows.map(row => row.price)), padding = maximum === minimum ? Math.max(1, maximum * .05) : (maximum - minimum) * .15, low = Math.max(0, minimum - padding), high = maximum + padding;
    const first = rows[0].time, span = latest.time-first;
    const x = row => span ? 38 + (row.time-first)/span*232 : 155, y = value => 81 - (value-low)/(high-low)*67;
    for (const level of [low, (low+high)/2, high]) { const py = y(level); chart.append(svg('line', { x1:38, x2:272, y1:py, y2:py, class:'dashboard-chart-grid' })); const label = svg('text', { x:31, y:py+3, 'text-anchor':'end' }); label.textContent = Math.round(level).toLocaleString('ko-KR'); chart.append(label); }
    let segment = [], prior = null;
    const flush = () => { if (segment.length > 1) chart.append(svg('polyline', { points:segment.join(' '), class:'dashboard-chart-line' })); segment = []; };
    for (const row of rows) { if (prior && row.time-prior.time !== 86400000) flush(); segment.push(x(row)+','+y(row.price)); prior = row; } flush();
    for (const row of rows) { const point = svg('circle', { cx:x(row), cy:y(row.price), r:2.2, class:'dashboard-chart-point' }), label = svg('title'); label.textContent = row.date + ' · ' + money(row.price) + ' 원'; point.append(label); chart.append(point); }
    for (const i of new Set([0, Math.floor((rows.length-1)/2), rows.length-1])) { const label = svg('text', { x:x(rows[i]), y:103, 'text-anchor':i===0?'start':i===rows.length-1?'end':'middle' }); label.textContent = rows[i].date.slice(5).replace('-','.'); chart.append(label); }
    plot.append(chart, node('small', 'dashboard-history-note', (time(data.updatedAt) ? time(data.updatedAt)+' 조회 · ' : '')+'전일 마감가 대비'));
    target.append(summary, plot);
  }
  async function loadGold() {
    const current = epoch, sequence = ++goldRequest, server = byId('home-gold-server').value, target = byId('home-history');
    byId('home-gold-source').href = 'https://gamebit.co.kr/' + server;
    empty(target, byId('home-gold-server').selectedOptions[0].textContent + ' 시세를 불러오는 중입니다.');
    const valid = () => current === epoch && sequence === goldRequest;
    try { const data = await json('/api/market/gold-history?server='+encodeURIComponent(server)); if (valid()) goldHistory(target, data); }
    catch (error) { if (!valid()) return; const p = node('p','realm-empty',error.status===429?'조회 요청이 많습니다. 잠시 후 다시 확인해 주세요. ':'골드 시세를 불러오지 못했습니다. '), retry = node('button','realm-action','다시 불러오기'); retry.type='button'; retry.addEventListener('click',loadGold); p.append(retry); target.replaceChildren(p); }
  }
  function market(target, data) {
    const items = Array.isArray(data.items) ? data.items.filter(item => item && typeof item.name === 'string' && Number.isSafeInteger(item.id) && item.id > 0 && Number.isSafeInteger(item.bundleCount) && item.bundleCount > 0).slice(0, 5) : [];
    target.replaceChildren(); if (!items.length) return empty(target, '현재 조회된 재련 재료가 없습니다.');
    for (const item of items) { const a = node('a', 'dashboard-price'); a.href = itemLink(item, data.category); a.title = `${item.name} · ${item.bundleCount}개 묶음`; picture(item.icon, a); a.append(node('b', '', item.name), node('strong', '', money(item.currentMinPrice)), change(item.changePercent), node('small', '', `${item.bundleCount}개 묶음 · G`)); target.append(a); }
    byId('home-market-time').textContent = `${time(data.updatedAt) ? `${time(data.updatedAt)} 조회 · ` : ''}등락은 전일 평균가 대비`;
  }
  // 공개 정보는 로그인 조회 결과와 상관없이 홈 탭이 열려 있을 때 한 번 불러온다.
  function start() {
    characters(); if (loaded || !byId('panel-intro').classList.contains('active')) return; loaded = true;
    for (const id of ['home-events', 'home-calendar', 'home-history', 'home-market', 'home-notices']) empty(byId(id), '불러오는 중입니다.');
    byId('home-gold-server').disabled = false; void loadGold();
    byId('home-date').textContent = `${shortDate(Date.now())} KST`;
    void load('home-events', '/api/lounge?section=events', events); void load('home-calendar', '/api/lounge?section=calendar', calendar); void load('home-notices', '/api/lounge?section=notices', notices);
    void load('home-market', '/api/market/search?kind=market&q=%EC%9A%B4%EB%AA%85%EC%9D%98&category=50010&sort=CURRENT_MIN_PRICE&order=ASC&page=1', market);
  }
  function applyAccess(value) {
    const was = personalReady;
    personalReady = value?.personal === 'ready';
    if (was && !personalReady) { homeCharacterTouched = false; byId('home-character').value = ''; }
    if (!personalReady) representative(null);
    showAccess(value);
  }
  function suspend() { epoch++; for (const controller of controllers) controller.abort(); loaded = false; }
  // GitHub Pages 사본에는 /api가 없다. 실시간 정보 패널은 숨기고(homepage.css), 검색 아래에 운영 서비스 안내를 둔다.
  if (window.pogeunStaticHost?.active) {
    document.querySelector('.realm-dashboard').dataset.staticHost = '';
    const service = node('a', '', 'pogeunhaeyong.duckdns.org'); service.href = `${window.pogeunStaticHost.serviceOrigin}/`;
    byId('home-access-status').append('포근해용 정적 안내 페이지입니다. 버전별 업데이트 내역과 기능 가이드를 확인하실 수 있으며, 캐릭터 검색·도구 계산·소셜 로그인·개인 숙제표·길드 일정 등 실시간 서비스 기능은 기존 운영 서비스(', service, ')로 연결됩니다.');
    return;
  }
  // Character search is public: the form submits to spec.html for every visitor.
  byId('home-character').addEventListener('input', () => { homeCharacterTouched = true; });
  document.addEventListener('site:member-profile', event => representative(event.detail));
  for (const button of document.querySelectorAll('[data-characters]')) button.addEventListener('click', () => { charactersMode = button.dataset.characters; for (const other of document.querySelectorAll('[data-characters]')) { const selected = other === button; other.classList.toggle('active', selected); other.setAttribute('aria-pressed', String(selected)); } characters(); });
  byId('home-gold-server').addEventListener('change', loadGold);
  addEventListener('storage', characters); addEventListener('pageshow', () => { applyAccess(window.pogeunSiteAccess); start(); }); addEventListener('pagehide', suspend); addEventListener('hashchange', start);
  document.addEventListener('site:navigate', () => queueMicrotask(start)); document.addEventListener('site:access', event => applyAccess(event.detail)); applyAccess(window.pogeunSiteAccess); start();
})();
