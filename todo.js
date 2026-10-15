(() => {
  'use strict';
  // 숙제표: 내 원정대에서 고른 캐릭터의 일일·주간 숙제를 체크한다(specs/2026-09-20-homework-board-design.md).
  // 공식 API는 클리어 여부를 주지 않으므로 체크는 직접 하고, 06:00(주간은 수요일)에 서버가 새 주기로 넘긴다.
  // GitHub Pages 사본에서는 renewal.js가 이 화면을 운영 서비스로 넘기므로 요청을 시작하지 않는다.
  if (window.pogeunStaticHost?.active) return;
  const byId = id => document.getElementById(id);
  const status = byId('todo-status');
  const board = byId('todo-board');
  const picker = byId('todo-picker');
  const rosterList = byId('todo-roster');
  const summary = byId('todo-summary');
  const node = (tag, text, className = '') => {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  };
  const number = value => value.toLocaleString('ko-KR');
  const level = value => value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let data = null;
  let ready = false;
  let generation = 0;
  let busy = false;
  let picking = false;
  // 아직 보내지 않은 새 의도. 칸마다 마지막으로 누른 값만 남긴다.
  let pending = new Map();
  // 확인받지 못한 요청 한 건. 응답을 잃거나 일시 오류가 나면 처음 본문·처음 인증 그대로 다시 보낸다(계약 §4).
  let unconfirmed = null;
  let chain = Promise.resolve();
  let sendTimer = null;
  let resetTimer = null;
  let drafts = new Map();
  let openPickers = new Set();
  let autoTried = false;
  // 선택창을 연 동안 사용자가 바꾼 상자(아직 저장 전). 체크 응답 등으로 다시 그려도 이 선택을 쓰고, 닫거나 저장하면 버린다.
  let pickerDraft = null;
  const controllers = new Set();
  // 아직 보내지 않은 의도의 차례. 표 바꾸기(캐릭터 저장·자동 선정)는 누를 때의 값을 잡아 두고, 차례가 왔을 때 값이 바뀌었으면
  // 보내지 않는다. 충돌·한도·권한 오류, 요청 revision+1보다 앞선 판, 그사이 다른 곳에서 바뀐 판, 세션 폐기 때 올린다(계약 §4:
  // 최신 revision에 옛 의도를 저절로 붙이지 않는다).
  let intentEpoch = 0;
  // 줄 서 있고 아직 보내지 않은 표 바꾸기 수. 의도를 버릴 때 안내가 표 바꾸기도 적용하지 않았다고 알리게 한다.
  let unsentBoards = 0;
  const DROPPED_NOTICE = '그사이 숙제표 정보가 갱신되어 최신 상태를 보여 드려요. 아직 보내지 않은 체크와 표 변경은 적용하지 않았으니 확인 후 다시 해 주세요.';

  function announce(message, error = false) {
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('error', error);
  }

  async function request(path, options = {}) {
    if (!ready) throw new Error('Personal access required');
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      if (!controller.signal.aborted) {
        // 본인 경로의 401은 로그아웃 상태로 바꾸고, 403은 상태를 짐작하지 않고 세션을 다시 확인한다.
        if (response.status === 401) window.publishPogeunSiteAccess?.({ authenticated: false, personal: 'anonymous', guild: 'anonymous' });
        else if (response.status === 403) void window.refreshPogeunSiteAccess?.();
      }
      const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (!response.ok) { const error = new Error('request failed'); error.status = response.status; error.code = body?.error; throw error; }
      if (!body) throw new Error('invalid response');
      return body;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }

  // 서버가 준 판만 그린다. 모양이 어긋나면 화면을 비우고 다시 확인하게 둔다. 쓰기 응답은 replayed까지 확인한다.
  function valid(value, write = false) {
    return value && typeof value === 'object' && Array.isArray(value.characters) && Array.isArray(value.daily) &&
      Array.isArray(value.weekly) && Array.isArray(value.raids) && value.periods && typeof value.periods.daily === 'string' &&
      typeof value.periods.weekly === 'string' && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
      value.limits && Number.isSafeInteger(value.limits.raids) && typeof value.csrfToken === 'string' &&
      (!write || typeof value.replayed === 'boolean');
  }

  const raidOf = id => data.raids.find(entry => entry.id === id) ?? null;
  const itemsOf = scope => (scope === 'daily' ? data.daily : data.weekly);
  // 화면 값은 서버 판에 확인받지 못한 체크와 아직 보내지 않은 체크를 얹은 값이다. 서버 판(data)은 응답 그대로 둔다.
  function valueOf(character, scope, itemId) {
    const key = `${character.characterName}|${scope}|${itemId}`;
    const change = pending.get(key) ?? unconfirmed?.changes.get(key);
    return change ? change.value : character[scope][itemId] ?? 0;
  }

  // 이번 주 레이드 골드: 체크한 관문의 골드에서 더보기 비용을 뺀다.
  function goldOf(character) {
    let gold = 0;
    for (const id of character.raids) {
      const raid = raidOf(id);
      if (!raid) continue;
      raid.gates.forEach((gate, index) => {
        if (valueOf(character, 'weekly', `${id}|${index}`)) gold += gate.g;
        if (valueOf(character, 'weekly', `${id}|${index}|bonus`)) gold -= gate.bonus;
      });
    }
    return gold;
  }

  function dailyLeft(character) {
    return data.daily.reduce((left, item) => left + Math.max(0, item.max - valueOf(character, 'daily', item.id)), 0);
  }

  // 판을 바꾸는 요청(체크 저장·캐릭터 저장·자동 선정·새로 읽기)은 한 번에 하나씩 차례로 보낸다. 늦게 온 이전 응답이 새
  // 화면을 덮거나, 다른 요청이 도는 동안 예약해 둔 체크가 버려지지 않게 한다(2026-09-23 교차 검토 F-P2-1·F-P2-2).
  // 차례 안의 작업은 다른 차례를 기다리지 않는다. 기다리면 줄이 막힌다.
  function serial(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  // 아직 보내지 않은 의도를 모두 버린다. 대기 체크는 비우고, 줄 서 있는 표 바꾸기는 차례가 와도 보내지 않는다.
  function dropIntents() {
    intentEpoch++;
    pending = new Map();
    clearTimeout(sendTimer);
  }

  // 서버가 준 판을 받는다. 체크 저장 응답에는 원정대 목록이 없고, 새로 읽을 때 원정대 조회가 잠시 실패하면 null이 온다.
  // 그때는 직전에 받은 목록을 이어 쓴다. 그러지 않으면 「캐릭터 고르기」가 비어 빈 명단이 저장될 수 있다(2026-09-23 회원 화면 점검).
  function adopt(result) {
    if (!Array.isArray(result.roster) && Array.isArray(data?.roster)) {
      result.roster = data.roster;
      result.rosterUpdatedAt = data.rosterUpdatedAt;
    }
    // 기간이 바뀐 판에는 옛 판에서 누른 의도를 옮기지 않는다.
    if (data && (result.periods.daily !== data.periods.daily || result.periods.weekly !== data.periods.weekly)) pending = new Map();
    data = result;
    scheduleReset();
  }
  const rosterOf = () => (Array.isArray(data?.roster) ? data.roster : []);

  // 체크 한 칸을 바로 화면에 반영하고, 잠깐 모았다가 한 번에 보낸다.
  function queue(characterName, scope, itemId, value) {
    if (busy || !data || !data.characters.some(entry => entry.characterName === characterName)) return;
    pending.set(`${characterName}|${scope}|${itemId}`, { characterName, scope, itemId, value });
    render();
    clearTimeout(sendTimer);
    sendTimer = setTimeout(flush, 500);
  }

  function flush() {
    clearTimeout(sendTimer);
    return serial(sendChecks);
  }

  // 다시 보내면 될 실패인가: 연결·시간 초과·서버 오류·429 rate_limited·모양이 어긋난 응답. 저장 한도(429 homework_capacity)는
  // 다음 초기화 전까지 다시 보내도 받아 주지 않으므로 여기 들지 않는다.
  const retryable = error => !error.status || error.status >= 500 || (error.status === 429 && error.code === 'rate_limited');

  // 다시 보내지 않는 실패의 안내: [저장된 판을 다시 읽었을 때, 읽지 못했을 때].
  const resetNotices = {
    period_changed: ['초기화 시점이 지나 새 숙제표를 불러왔어요. 바뀐 내용을 확인하고 다시 체크해 주세요.',
      '초기화 시점이 지났어요. 새 숙제표를 확인하지 못했으니 잠시 후 「새로고침」을 눌러 주세요.'],
    homework_changed: ['숙제표 정보가 갱신되어 최신 상태로 다시 불러왔어요. 확인 후 다시 체크해 주세요.',
      '숙제표 정보가 갱신됐어요. 최신 상태를 확인하지 못했으니 잠시 후 「새로고침」을 눌러 주세요.'],
    operation_conflict: ['처리 중 내용이 엇갈려 최신 숙제표를 다시 불러왔어요. 확인 후 다시 시도해 주세요.',
      '처리 중 내용이 엇갈렸어요. 최신 숙제표를 확인하지 못했으니 잠시 후 「새로고침」을 눌러 주세요.'],
    homework_capacity: ['오늘 숙제 저장 한도에 도달했어요. 다음 초기화(한국 시간 오전 6시) 이후에 다시 이용할 수 있어요.',
      '오늘 숙제 저장 한도에 도달했어요. 다음 초기화(한국 시간 오전 6시) 이후에 다시 이용할 수 있어요. 지금 숙제표는 확인하지 못했어요.'],
    forbidden: ['로그인 정보가 바뀌어 저장하지 못했어요. 최신 숙제표를 다시 불러왔으니 확인 후 다시 체크해 주세요.',
      '로그인 정보가 바뀌어 저장하지 못했어요. 최신 숙제표를 확인하지 못했으니 「새로고침」을 눌러 주세요.'],
    member_roster_selection_invalid: ['내 원정대에 없는 캐릭터는 표에 올릴 수 없어요. 저장된 숙제표를 다시 불러왔어요.',
      '내 원정대에 없는 캐릭터는 표에 올릴 수 없어요. 저장된 숙제표는 확인하지 못했으니 잠시 후 「새로고침」을 눌러 주세요.'],
  };
  const resetDefault = ['저장하지 못했어요. 저장된 숙제표를 다시 불러왔으니 확인 후 다시 시도해 주세요.',
    '저장하지 못했어요. 저장된 숙제표를 확인하지 못했으니 잠시 후 「새로고침」을 눌러 주세요.'];

  function retryNotice(entry, failure) {
    const check = entry.changes.size > 0;
    if (failure.status === 429) {
      return check ? '요청이 많아 체크를 아직 저장하지 못했어요. 조금 뒤 「새로고침」을 누르면 같은 체크를 다시 보내요.'
        : '요청이 많아 숙제표를 아직 저장하지 못했어요. 조금 뒤 「새로고침」을 누르면 같은 요청을 다시 보내요.';
    }
    return check ? '체크 저장 결과를 확인하지 못했어요. 누른 체크는 화면에 남겨 두었고, 「새로고침」을 누르면 같은 요청을 다시 보내 확인해요.'
      : '숙제표 저장 결과를 확인하지 못했어요. 「새로고침」을 누르면 같은 요청을 다시 보내 확인해요.';
  }

  // 쓰기 요청 한 건을 만든다. 직렬 차례가 왔을 때 직전 판의 revision·두 기간과 그때의 CSRF로 고정한다.
  function envelope(path, payload, changes = new Map()) {
    const body = JSON.stringify({ operationId: crypto.randomUUID(), revision: data.revision,
      periods: { daily: data.periods.daily, weekly: data.periods.weekly }, ...payload });
    return { path, body, csrf: data.csrfToken, revision: data.revision, changes };
  }

  // 확인받지 못한 요청을 처음 본문·처음 인증 그대로 보내고 결과를 반영한다. 돌려주는 값:
  // 'saved' 확인됨, 'changed' 그사이 다른 저장이 있어 대기 의도를 버림, 'retry' 다시 보낼 실패라 요청을 남김,
  // 'reset' 요청과 의도를 버리고 판을 다시 읽음, 'stale' 접근·화면이 바뀌어 그만둠.
  async function settle() {
    const entry = unconfirmed;
    if (!entry) return 'saved';
    if (!data || !ready) return 'stale';
    // 세션이 바뀌어 토큰이 달라졌으면 옛 명령에 새 인증을 붙여 다시 보내지 않는다.
    if (entry.csrf !== data.csrfToken) return discard('forbidden');
    const current = generation;
    let result = null, failure = null;
    try {
      result = await request(entry.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': entry.csrf },
        body: entry.body,
      });
      if (!valid(result, true)) throw new Error('invalid response');
    } catch (error) { failure = error; }
    if (current !== generation || unconfirmed !== entry) return 'stale';
    if (failure) {
      if (failure.status === 401 || (failure.status === 403 && failure.code !== 'forbidden')) { handleError(failure, ''); return 'stale'; }
      if (retryable(failure)) { announce(retryNotice(entry, failure), true); return 'retry'; }
      return discard(failure.code);
    }
    unconfirmed = null;
    // 명령 하나는 revision을 정확히 1 올린다. 그보다 앞선 판이면 사이에 다른 저장이나 레벨 동기화가 있었으니
    // 옛 판 기준의 대기 의도를 새 revision에 붙이지 않고 버린다. 다른 탭의 취소를 덮지 않기 위해서다.
    if (result.revision > entry.revision + 1) {
      const dropped = pending.size > 0 || unsentBoards > 0;
      dropIntents();
      adopt(result);
      render();
      announce(dropped ? DROPPED_NOTICE : '그사이 숙제표 정보가 갱신되어 최신 상태를 보여 드려요.', dropped);
      return 'changed';
    }
    adopt(result);
    render();
    announce(entry.changes.size ? '숙제 체크를 저장했어요.' : '숙제표를 저장했어요.');
    return 'saved';
  }

  // 다시 보내지 않는 실패: 확인받지 못한 요청과 아직 보내지 않은 의도를 모두 버리고 저장된 판을 직접 읽어 안내한다.
  // 다시 읽은 판의 revision을 옛 의도에 붙이지 않는다.
  async function discard(code) {
    unconfirmed = null;
    dropIntents();
    render();
    const { state } = await refetch();
    if (state === 'stale') return 'stale';
    const [loaded, failed] = resetNotices[code] || resetDefault;
    announce(state === 'loaded' ? loaded : failed, true);
    return 'reset';
  }

  // 저장된 판을 직접 읽는다. state는 'loaded'·'failed'·'stale' 가운데 하나다. moved는 보고 있던 판과 revision·기간이 달라
  // 그사이 다른 곳에서 바뀐 판을 받았다는 뜻이다.
  async function refetch() {
    const current = generation, was = busy;
    busy = true;
    render();
    try {
      const result = await request('/api/auth/homework');
      if (current !== generation) return { state: 'stale' };
      if (!valid(result)) throw new Error('invalid response');
      // 보고 있던 판과 CSRF가 다르면 그사이 세션이 바뀌었다(다른 계정일 수 있다). 처음 읽기(data 없음)는 비교하지 않는다. 이 판은
      // 쓰지 않고 옛 판·대기 체크·줄 선 표 바꾸기·확인받지 못한 요청을 먼저 버린 뒤 공통 확인에 교체를 알린다. 공통 경로가 진행 중인
      // 옛 확인을 끊고 확인 불가를 먼저 발표해 머리글과 함께 비우고, 새 확인이 ready를 발표하면 처음 읽기로 다시 불러온다. 옛 명령을
      // 새 CSRF로 보내지 않는다(2026-10-14 최종 검토 F3 후속: 전에는 판만 새 계정이고 머리글은 이전 계정이었다).
      if (data && result.csrfToken !== data.csrfToken) {
        discardSession();
        void window.refreshPogeunSiteAccess?.({ sessionChanged: true });
        return { state: 'stale' };
      }
      const moved = Boolean(data) && (result.revision !== data.revision ||
        result.periods.daily !== data.periods.daily || result.periods.weekly !== data.periods.weekly);
      adopt(result);
      return { state: 'loaded', moved };
    } catch (error) {
      if (current !== generation) return { state: 'stale' };
      if (error.status === 401 || (error.status === 403 && error.code !== 'forbidden')) { handleError(error, ''); return { state: 'stale' }; }
      return { state: 'failed', error };
    } finally {
      if (current === generation) { busy = was; render(); }
    }
  }

  // 모인 체크를 60칸씩 보낸다. 확인받지 못한 요청이 있으면 그것부터 처음 그대로 다시 보내고, 그 요청에 새 의도를 섞지 않는다.
  // 보내는 동안 새로 누른 체크는 응답을 받은 뒤 새 revision으로 이어서 보낸다. 모두 확인됐을 때만 'saved'를 돌려줘
  // 뒤에 줄 선 표 바꾸기·새로 읽기가 앞선 실패를 덮지 않는다(2026-09-23 교차 검토 F-R1).
  async function sendChecks() {
    let outcome = await settle();
    while (outcome === 'saved' && pending.size && data && ready) {
      const batch = [...pending].slice(0, 60);
      for (const [key] of batch) pending.delete(key);
      unconfirmed = envelope('/api/auth/homework/check', { changes: batch.map(([, change]) => change) }, new Map(batch));
      outcome = await settle();
    }
    return outcome;
  }

  function handleError(error, message) {
    if (error.status === 401 || (error.status === 403 && error.code !== 'forbidden')) {
      clearBoard();
      announce(error.status === 401 ? '로그인이 필요합니다.' : '내 숙제표는 로그인과 캐릭터 소유 인증 후 이용할 수 있어요.', true);
      return;
    }
    announce(error.status === 429 ? '요청이 많아 잠시 기다려야 해요. 조금 뒤 다시 시도해 주세요.' : message, true);
  }

  function clearBoard() {
    data = null;
    clearTimeout(sendTimer);
    clearTimeout(resetTimer);
    pending = new Map();
    unconfirmed = null;
    drafts = new Map();
    openPickers = new Set();
    board.replaceChildren();
    summary.hidden = true;
    picker.hidden = true;
    picking = false;
    pickerDraft = null;
    byId('todo-period').textContent = '';
    byId('todo-note').textContent = '';
  }

  // 다음 일일·주간 초기화 시각에 판을 다시 읽는다. 단말 시각이 서버보다 앞서 이미 지난 초기화를 같은 기간으로 다시 받으면
  // 곧바로 반복해 읽지 않도록 30초 뒤에 다시 확인한다.
  function scheduleReset() {
    clearTimeout(resetTimer);
    const next = Math.min(...['daily', 'weekly'].map(scope => data?.resets?.[scope]).filter(Number.isSafeInteger));
    if (!Number.isFinite(next)) return;
    const wait = next - Date.now();
    resetTimer = setTimeout(() => { void load(); }, wait > 0 ? wait + 1000 : 30000);
  }

  function resetLabel() {
    const daily = data.resets?.daily, weekly = data.resets?.weekly;
    const fmt = value => (Number.isSafeInteger(value)
      ? new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(new Date(value))
      : '');
    const resets = [daily && `일일 초기화 ${fmt(daily)}`, weekly && `주간 초기화 ${fmt(weekly)}`].filter(Boolean);
    return [`이번 주 ${data.periods.weekly} 시작`, ...resets, resets.length && '한국 시간'].filter(Boolean).join(' · ');
  }

  // 0 → 1 → … → max → 0 으로 도는 칸. max가 1이면 그냥 켜고 끈다.
  function counter(character, scope, item) {
    const value = valueOf(character, scope, item.id);
    const button = node('button', '', `todo-item${value >= item.max ? ' done' : value ? ' partial' : ''}`);
    button.type = 'button';
    button.disabled = busy;
    button.setAttribute('aria-pressed', String(value >= item.max));
    button.append(node('span', item.short || item.name, 'todo-item-name'));
    if (item.max > 1) button.append(node('span', `${value}/${item.max}`, 'todo-item-count'));
    button.addEventListener('click', () => queue(character.characterName, scope, item.id, (value + 1) % (item.max + 1)));
    return button;
  }

  function raidRow(character, id) {
    const raid = raidOf(id);
    if (!raid) return null;
    const row = node('div', '', 'todo-raid');
    const cleared = raid.gates.every((gate, index) => valueOf(character, 'weekly', `${id}|${index}`));
    row.append(node('span', `${raid.name} ${raid.diff}`, `todo-raid-name${cleared ? ' done' : ''}`));
    const gates = node('div', '', 'todo-gates');
    raid.gates.forEach((gate, index) => {
      const gateId = `${id}|${index}`;
      const done = valueOf(character, 'weekly', gateId);
      const bonus = valueOf(character, 'weekly', `${gateId}|bonus`);
      const cell = node('div', '', 'todo-gate');
      const clear = node('button', `${index + 1}관`, `todo-gate-clear${done ? ' done' : ''}`);
      clear.type = 'button';
      clear.disabled = busy;
      clear.setAttribute('aria-pressed', String(Boolean(done)));
      clear.title = `${number(gate.g)} G`;
      clear.addEventListener('click', () => queue(character.characterName, 'weekly', gateId, done ? 0 : 1));
      const more = node('button', '더보기', `todo-gate-bonus${bonus ? ' done' : ''}`);
      more.type = 'button';
      more.disabled = busy;
      more.setAttribute('aria-pressed', String(Boolean(bonus)));
      more.title = `더보기 ${number(gate.bonus)} G`;
      more.addEventListener('click', () => queue(character.characterName, 'weekly', `${gateId}|bonus`, bonus ? 0 : 1));
      cell.append(clear, more);
      gates.append(cell);
    });
    row.append(gates);
    return row;
  }

  const draftOf = character => drafts.get(character.characterName) ?? character.raids;
  const sameRaids = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

  // 그 캐릭터가 갈 수 있는 레이드를 칩으로 보여 준다. 세 개까지 골라 둔 뒤 「적용」을 누르면 한 번에 저장한다.
  function raidPicker(character) {
    const name = character.characterName;
    const draft = draftOf(character);
    const wrap = node('div', '', 'todo-raid-picker');
    wrap.append(node('p', `${data.limits.raids}개까지 고른 뒤 「적용」을 누르면 한 번에 저장돼요.`, 'todo-picker-hint'));
    const chips = node('div', '', 'todo-chips');
    const available = data.raids.filter(entry => character.itemLevel >= entry.ilvl);
    for (const raid of available) {
      const chosen = draft.includes(raid.id);
      const chip = node('button', `${raid.name} ${raid.diff}`, `todo-chip${chosen ? ' chosen' : ''}`);
      chip.type = 'button';
      chip.disabled = busy || (!chosen && draft.length >= data.limits.raids);
      chip.setAttribute('aria-pressed', String(chosen));
      chip.addEventListener('click', () => {
        drafts.set(name, chosen ? draft.filter(entry => entry !== raid.id) : [...draft, raid.id]);
        render();
      });
      chips.append(chip);
    }
    if (!available.length) chips.append(node('p', '아직 들어갈 수 있는 레이드가 없어요.', 'todo-empty'));
    wrap.append(chips);
    if (available.length) {
      const changed = !sameRaids(draft, character.raids);
      const actions = node('div', '', 'todo-draft-actions');
      actions.append(node('span', `고른 레이드 ${draft.length} / ${data.limits.raids}`, 'todo-draft-count'));
      const apply = node('button', '적용', 'home-button');
      apply.type = 'button';
      apply.disabled = busy || !changed;
      apply.addEventListener('click', () => {
        const picked = [...draft];
        drafts.delete(name);
        saveCharacters(data.characters.map(entry => ({
          characterName: entry.characterName,
          raids: entry.characterName === name ? picked : entry.raids,
        })), `${name}의 주간 레이드 ${picked.length}개를 저장했어요.`);
      });
      const reset = node('button', '되돌리기', 'quiet-button');
      reset.type = 'button';
      reset.disabled = busy || !changed;
      reset.addEventListener('click', () => { drafts.delete(name); render(); });
      actions.append(apply, reset);
      wrap.append(actions);
    }
    return wrap;
  }

  function card(character) {
    const article = node('article', '', 'todo-card');
    const head = node('div', '', 'todo-card-head');
    head.append(node('h2', character.characterName, 'todo-card-name'));
    head.append(node('span', `${character.characterClass} · ${level(character.itemLevel)}`, 'todo-card-meta'));
    const gold = goldOf(character);
    head.append(node('span', gold ? `${number(gold)} G` : '', 'todo-card-gold'));
    article.append(head);

    const daily = node('div', '', 'todo-line');
    daily.append(node('span', '일일', 'todo-line-label'));
    const dailyItems = node('div', '', 'todo-items');
    for (const item of data.daily) dailyItems.append(counter(character, 'daily', item));
    daily.append(dailyItems);
    article.append(daily);

    const weekly = node('div', '', 'todo-line');
    weekly.append(node('span', '주간', 'todo-line-label'));
    const weeklyItems = node('div', '', 'todo-items');
    for (const item of data.weekly) weeklyItems.append(counter(character, 'weekly', item));
    weekly.append(weeklyItems);
    article.append(weekly);

    const raids = node('div', '', 'todo-raids');
    for (const id of character.raids) {
      const row = raidRow(character, id);
      if (row) raids.append(row);
    }
    if (!character.raids.length) raids.append(node('p', '주간 레이드를 아직 고르지 않았어요.', 'todo-empty'));
    article.append(raids);

    const details = document.createElement('details');
    details.className = 'todo-raid-edit';
    details.open = openPickers.has(character.characterName);
    details.append(node('summary', '주간 레이드 고르기'));
    details.addEventListener('toggle', () => {
      if (details.open) openPickers.add(character.characterName);
      else { openPickers.delete(character.characterName); drafts.delete(character.characterName); }
    });
    details.append(raidPicker(character));
    article.append(details);
    return article;
  }

  function render() {
    if (!ready || !data) { clearBoard(); return; }
    byId('todo-period').textContent = resetLabel();
    board.replaceChildren();
    for (const character of data.characters) board.append(card(character));
    if (!data.characters.length) {
      board.append(node('p', '표가 비어 있어요. 위의 「자동 선정」을 누르면 아이템 레벨이 높은 캐릭터와 레이드를 골라 주고, 「캐릭터 고르기」로 직접 정할 수도 있어요.', 'todo-empty todo-empty-board'));
    }
    summary.hidden = !data.characters.length;
    byId('todo-count').textContent = number(data.characters.length);
    byId('todo-daily-left').textContent = number(data.characters.reduce((sum, entry) => sum + dailyLeft(entry), 0));
    byId('todo-gold').textContent = number(data.characters.reduce((sum, entry) => sum + goldOf(entry), 0));
    byId('todo-note').textContent = [
      '공식 API는 클리어 여부를 알려 주지 않아 체크는 직접 해요',
      '한국 시간 기준 일일은 매일 06시, 주간은 수요일 06시에 새로 시작해요',
      `콘텐츠 자료 ${data.dataDate} 기준`,
    ].join(' · ');
    if (picking) renderPicker();
  }

  function renderPicker() {
    const roster = rosterOf();
    pickerDraft ??= new Set(data.characters.map(entry => entry.characterName));
    const chosen = pickerDraft;
    rosterList.replaceChildren();
    byId('todo-save').disabled = !roster.length;
    if (!roster.length) {
      rosterList.append(node('p', '원정대를 불러오지 못했어요. 잠시 후 새로고침해 주세요.', 'todo-empty'));
      byId('todo-picker-count').textContent = '';
      return;
    }
    // 이번 원정대 조회에 없지만 저장된 캐릭터도 저장된 정보로 함께 보여 주고 처음부터 체크해 둔다. 숨기면 열고 그대로 저장해도 제거
    // 요청이 된다(specs/2026-10-14-public-service-contract.md §3 「원정대 조회 누락과 명시적 제거」). 원정대 조회가 실패했거나 빈
    // 목록이면 위에서 저장을 막는다.
    const listed = new Set(roster.map(character => character.characterName));
    const missing = data.characters.filter(entry => !listed.has(entry.characterName));
    const counted = () => [...roster, ...missing].filter(character => chosen.has(character.characterName)).length;
    // 저장 뒤 자동 선정이 채우는 규칙을 미리 알린다(specs/2026-09-20-homework-board-design.md §3). 동작은 그대로다.
    const auto = data.limits.auto ?? 6;
    const hint = node('p', `${auto}명보다 적게 고르면 저장할 때 아이템 레벨이 높은 순으로 ${auto}명까지 채우고, 비어 있는 주간 레이드도 레벨에 맞게 골라 드려요.`, 'todo-picker-hint');
    hint.style.gridColumn = '1 / -1'; // 원정대 목록은 격자라 안내가 한 칸에 갇히지 않게 한 줄 전체를 쓴다.
    rosterList.append(hint);
    const row = (character, describedBy = '') => {
      const label = node('label', '', 'todo-roster-row');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = character.characterName;
      box.checked = chosen.has(character.characterName);
      box.disabled = busy;
      if (describedBy) box.setAttribute('aria-describedby', describedBy);
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(character.characterName); else chosen.delete(character.characterName);
        byId('todo-picker-count').textContent = `${counted()} / ${data.limits.characters}명 선택`;
      });
      label.append(box, node('span', character.characterName, 'todo-roster-name'),
        node('span', `${character.characterClass} · ${level(character.itemLevel)}`, 'todo-roster-meta'));
      return label;
    };
    for (const character of roster) rosterList.append(row(character));
    if (missing.length) {
      const note = node('p', '아래 캐릭터는 이번 원정대 조회에 없어 이전에 저장한 정보로 보여 드려요. 체크를 해제하고 저장할 때만 표에서 빠져요.', 'todo-picker-hint');
      note.id = 'todo-roster-missing-note';
      note.style.gridColumn = '1 / -1';
      rosterList.append(note);
      for (const character of missing) rosterList.append(row(character, note.id));
    }
    byId('todo-picker-count').textContent = `${counted()} / ${data.limits.characters}명 선택`;
  }

  // 표를 바꾸는 요청(캐릭터 저장·자동 선정). 모인 체크와 확인받지 못한 요청을 먼저 끝낸 뒤 그 판의 revision으로 표를 바꾼다.
  // 앞선 저장이 확인되지 않았으면 표는 그대로 두고 그 안내를 남긴다. 표를 바꾼 뒤 보내면 그 사이 빠진 캐릭터의 체크가 거절된다.
  // 서버가 표를 바꿔 저장했을 때만 true여서 뒤따르는 자동 선정이 실패를 덮지 않는다(2026-09-23 교차 검토 P2:
  // 캐릭터 저장이 422·503·연결 끊김으로 실패해도 /auto가 이어져 기본 인원으로 저장되고 실패 안내가 사라졌다).
  // 누른 때의 세대와 의도 차례를 잡아 두고, 차례가 오기 전이나 모인 체크를 보내는 동안 의도를 버렸으면 보내지 않는다. 다시 읽은
  // 판의 revision이나 새 인증으로 저절로 보내면 다른 곳의 변경을 덮고 충돌 안내가 저장 완료 안내로 덮인다(2026-10-14 교차 검토 P1).
  function changeBoard(path, payload, message, after = () => {}) {
    if (busy || !data) return Promise.resolve(false);
    const current = generation, epoch = intentEpoch;
    busy = true;
    unsentBoards++;
    render();
    clearTimeout(sendTimer);
    return serial(async () => {
      let unsent = true;
      const leaveQueue = () => { if (unsent && current === generation) unsentBoards--; unsent = false; };
      try {
        if (current !== generation || epoch !== intentEpoch) return false;
        if (await sendChecks() !== 'saved' || !data || current !== generation || epoch !== intentEpoch) return false;
        leaveQueue();
        unconfirmed = envelope(path, payload);
        if (await settle() !== 'saved' || current !== generation) return false;
        after();
        announce(message);
        return true;
      } finally {
        leaveQueue();
        if (current === generation) { busy = false; render(); }
      }
    });
  }

  const saveCharacters = (characters, message) => changeBoard('/api/auth/homework/characters', { characters }, message);

  // 서버가 표를 채운다. 레이드는 세 개까지, 캐릭터는 주간 골드를 받는 여섯 명까지 레벨이 높은 순으로 올린다.
  const autoFill = message => changeBoard('/api/auth/homework/auto', {}, message, () => { drafts = new Map(); });

  // 자동 선정이 채울 것이 남았나. 레이드가 덜 찬 캐릭터가 있거나 골드를 받는 인원이 덜 찼을 때. 레이드는 이번 원정대에 있는
  // 캐릭터만 본다. 원정대 조회에 없는 저장 캐릭터는 오래된 레벨로 레이드를 새로 추천받지 않으므로(계약 §3) 그 빈 레이드 때문에
  // 자동 선정을 더 보내지 않는다.
  function needsAuto() {
    if (!data) return false;
    const limit = data.limits.raids ?? 3;
    const listed = new Set(rosterOf().map(entry => entry.characterName));
    const short = data.characters.some(entry => {
      if (!listed.has(entry.characterName) || entry.raids.length >= limit) return false;
      const names = new Set(entry.raids.map(id => raidOf(id)?.name));
      return data.raids.some(raid => entry.itemLevel >= raid.ilvl && !names.has(raid.name));
    });
    if (short) return true;
    const want = Math.min(data.limits.auto ?? 6, data.limits.characters ?? 24, rosterOf().length);
    return data.characters.length < want;
  }

  // 새로 읽기도 같은 차례를 탄다. 모인 체크와 확인받지 못한 요청을 먼저 끝내야 읽어 온 판이 방금 누른 체크를 되돌리지 않는다.
  function load(message = '') {
    if (!ready || document.hidden) return Promise.resolve();
    clearTimeout(sendTimer);
    const current = generation;
    return serial(async () => {
      if (!ready || document.hidden || current !== generation) return;
      // 다시 보내도 확인되지 않은 요청이 남았으면 판을 덮지 않고 그 안내를 남긴다. 요청을 버렸거나('reset') 그사이 바뀐 판을
      // 받았으면('changed') 이미 최신 판을 보여 주고 있다.
      if (await sendChecks() !== 'saved') return;
      // 보여 줄 판이 아직 없으면(처음 읽기·권한을 다시 얻은 뒤) 응답을 기다리는 동안 상태 줄을 비워 두지 않는다. 판이 있으면 그 판과
      // 지금 안내(충돌·저장 오류 등)를 그대로 둔다. 응답·실패·권한 상실은 각자의 안내로 이 문구를 바꾼다.
      if (!data) announce('숙제표를 불러오고 있어요.');
      const { state, error, moved } = await refetch();
      if (state === 'stale') return;
      if (state === 'failed') { handleError(error, '숙제표를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.'); return; }
      // 그사이 다른 곳에서 바뀐 판이면 줄 서 있던 표 바꾸기도 옛 판 기준이라 보내지 않는다.
      const dropped = moved && unsentBoards > 0;
      if (moved) dropIntents();
      announce(dropped ? DROPPED_NOTICE : message || (data.characters.length ? '현재 숙제 현황이에요. 칸을 눌러 체크할 수 있어요.' : '표에 올릴 캐릭터를 골라 주세요.'), dropped);
      if (!autoTried && !data.characters.length && Array.isArray(data.roster) && data.roster.length) {
        autoTried = true;
        // 이 차례가 끝난 다음 차례로 선다(여기서 기다리지 않는다).
        void autoFill(`원정대에서 아이템 레벨이 높은 최대 ${data.limits.auto ?? 6}캐릭터를 올리고 주간 레이드를 골랐어요. 「캐릭터 고르기」와 카드의 「주간 레이드 고르기」로 바꿀 수 있어요.`);
      }
    });
  }

  byId('todo-pick').addEventListener('click', () => {
    if (!data || busy) return;
    picking = !picking;
    picker.hidden = !picking;
    pickerDraft = null; // 열 때마다 저장된 표에서 시작한다.
    if (picking) { renderPicker(); byId('picker-title').focus({ preventScroll: true }); }
  });
  byId('todo-cancel').addEventListener('click', () => { picking = false; picker.hidden = true; pickerDraft = null; });
  byId('todo-save').addEventListener('click', async () => {
    if (!data || busy) return;
    // 고를 목록이 없을 때 누른 저장은 빈 명단 저장이 되므로 보내지 않는다.
    if (!rosterOf().length) {
      announce('원정대 목록을 불러오지 못해 저장하지 않았어요. 「새로고침」 뒤 다시 골라 주세요.', true);
      return;
    }
    // 고른 수가 상한을 넘으면 새로 고른 캐릭터부터 뒤에서 덜어 낸다. 저장된 캐릭터를 잘라 숨은 제거 요청을 만들지 않는다.
    const stored = new Set(data.characters.map(entry => entry.characterName));
    const names = [...rosterList.querySelectorAll('input:checked')].map(box => box.value);
    for (let index = names.length - 1; names.length > data.limits.characters && index >= 0; index--) {
      if (!stored.has(names[index])) names.splice(index, 1);
    }
    const keep = new Map(data.characters.map(entry => [entry.characterName, entry.raids]));
    picking = false;
    picker.hidden = true;
    pickerDraft = null;
    const saved = await saveCharacters(names.map(name => ({ characterName: name, raids: keep.get(name) ?? [] })), '표에 올릴 캐릭터를 저장했어요.');
    if (saved && needsAuto()) await autoFill('표에 올린 캐릭터와 레벨에 맞는 주간 레이드를 저장했어요.');
  });
  byId('todo-auto').addEventListener('click', () =>
    autoFill(`아이템 레벨이 높은 최대 ${data?.limits?.auto ?? 6}캐릭터를 올리고 캐릭터마다 주간 레이드를 최대 ${data?.limits?.raids ?? 3}개까지 채웠어요.`));
  byId('todo-refresh').addEventListener('click', () => { if (!busy) load('현재 숙제 현황을 다시 확인했어요.'); });
  // 지금 세대를 끝낸다(로그아웃·계정 전환·같은 계정 세션 교체·페이지를 떠남). 진행 중 요청을 끊고 그 세대의 진행 상태를 푼다.
  // 옛 차례의 finally는 세대가 달라 아무것도 되돌리지 않으므로 여기서 풀지 않으면 새 세대의 숙제표가 잠긴 채 남는다
  // (2026-10-14 교차 검토 P1).
  function endGeneration() {
    generation++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    busy = false;
    unsentBoards = 0;
  }
  window.addEventListener('pagehide', endGeneration);
  // 숨김·오프라인에서 돌아오면 기간을 다시 확인한다.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('online', () => { load(); });

  // 지금 세션의 화면을 모두 버린다(접근 상실·확인 불가, 판에서 세션 교체를 알았을 때). 세대를 끝내고 대기 의도·옛 판·확인받지 못한
  // 요청을 비운다.
  function discardSession() {
    endGeneration();
    dropIntents();
    clearBoard();
    announce('');
  }

  function accessChanged(detail) {
    const was = ready;
    ready = detail?.personal === 'ready';
    if (!ready) discardSession();
    else if (!was) load();
  }
  document.addEventListener('site:access', event => accessChanged(event.detail));
  accessChanged(window.pogeunSiteAccess);
})();
