(() => {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  // GitHub Pages 사본은 정적 파일만 있고 /api가 없다. 모든 화면·링크·폼은 이 사본 안에 그대로 두고(자동 이동이나
  // 주소 치환 없음), 서버가 필요한 기능은 화면마다 정착된 안내와 운영 서비스로 가는 명시적인 링크만 보인다.
  const serviceOrigin = 'https://pogeunhaeyong.duckdns.org';
  const staticHost = /^https:\/\/[^/]+\.github\.io$/i.test(location.origin);
  window.pogeunStaticHost = Object.freeze({ active: staticHost, serviceOrigin });
  // 정적 안내 문구(docs/static-copy.js). 빠진 키는 그 자리를 비우고 한 번만 알린다.
  const reportedCopy = new Set();
  const staticText = (key, values = {}) => {
    const value = window.POGEUN_STATIC_COPY?.[key];
    if (typeof value === 'string' && value) return value.replace(/\{name\}/g, match => ('name' in values ? String(values.name) : match));
    if (!reportedCopy.has(key)) { reportedCopy.add(key); console.error(`static copy missing: ${key}`); }
    return '';
  };
  // 서버가 필요한 화면(계정·캐릭터·도구)의 정착 안내: 표시·제목·설명과 운영 서비스 링크. 링크는 사용자가 눌러야만 이동한다.
  window.pogeunStaticNotice = ({ area, action = `${area}.action`, href, values }) => {
    const card = document.createElement('section'); card.className = 'site-access-gate static-boundary'; card.setAttribute('role', 'status');
    const badge = document.createElement('p'); badge.className = 'site-access-stage'; badge.textContent = staticText('stage');
    const title = document.createElement('h2'); title.textContent = staticText(`${area}.title`);
    const body = document.createElement('p'); body.textContent = staticText(`${area}.body`);
    const actions = document.createElement('div'); actions.className = 'site-access-actions';
    const link = document.createElement('a'); link.className = 'realm-action primary'; link.href = href; link.textContent = staticText(action, values);
    actions.append(link);
    card.append(badge, title, body, actions);
    return card;
  };
  // 공개·본인·길드 접근(specs/2026-10-14-public-service-contract.md §2). unavailable은 서버 값이 아니라
  // 확인 전·전환 중·조회 실패를 뜻하는 화면 전용 상태다.
  const personalStates = new Set(['anonymous', 'ownership_required', 'ready', 'unavailable']);
  const guildStates = new Set(['anonymous', 'verification_required', 'application_required', 'pending', 'rejected', 'revoked', 'approved', 'unavailable']);
  let settleAccess;
  let accessResolved = false;
  window.pogeunSiteAccess = Object.freeze({ authenticated: false, personal: 'unavailable', guild: 'unavailable' });
  window.pogeunSiteAccessReady = new Promise(resolve => { settleAccess = resolve; });
  const feature = document.querySelector('main[data-site-feature]');
  // 숙제는 본인(personal ready), 길드는 길드 승인이 필요하다. 그 밖의 기능 화면은 공개라 잠그지 않는다.
  const requirement = { todo: 'personal', guild: 'guild' }[feature?.dataset.siteFeature] ?? null;
  let accessCard = null;
  if (requirement) {
    accessCard = document.createElement('section');
    accessCard.className = 'site-access-gate';
    accessCard.setAttribute('role', 'status');
    accessCard.setAttribute('aria-live', 'polite');
    feature.prepend(accessCard);
  } else if (feature) feature.dataset.siteAccess = 'open';
  // [단계, 제목, 설명, 계정 링크]
  const gateCopy = {
    personal: {
      anonymous: ['로그인 필요', '로그인하고 내 숙제표를 이용해 주세요.', '내 숙제표는 로그인과 캐릭터 소유 인증 후 이용할 수 있어요. 길드 가입 승인은 필요하지 않아요.', '로그인'],
      ownership_required: ['소유 인증 필요', '캐릭터 소유 인증을 마쳐 주세요.', '내 계정에서 캐릭터 소유 인증을 마치면 내 숙제표를 이용할 수 있어요. 길드 가입 승인은 필요하지 않아요.', '내 계정에서 인증하기'],
      unavailable: ['상태 확인 필요', '로그인 상태를 확인하지 못했어요.', '잠시 후 다시 확인하거나 내 계정에서 로그인 상태를 확인해 주세요.', '내 계정 확인'],
    },
    guild: {
      anonymous: ['로그인 필요', '길드 일정과 출석은 포근해 길드원 전용이에요.', '로그인한 뒤 내 계정에서 캐릭터 소유 인증과 가입 신청을 진행할 수 있어요.', '로그인·가입'],
      verification_required: ['소유 인증 필요', '길드 일정과 출석은 포근해 길드원 전용이에요.', '내 계정에서 캐릭터 소유 인증을 마친 뒤 가입을 신청해 주세요.', '내 가입 상태 확인'],
      application_required: ['가입 신청', '길드 일정과 출석은 포근해 길드원 전용이에요.', '포근해 길드원이라면 내 계정에서 가입을 신청해 주세요. 운영진이 확인한 뒤 열립니다.', '내 가입 상태 확인'],
      pending: ['승인 검토 중', '운영진이 가입 신청을 확인하고 있어요.', '가입 신청 상태는 내 계정에서 확인할 수 있어요.', '내 가입 상태 확인'],
      rejected: ['신청 확인 필요', '가입 신청이 승인되지 않았어요.', '내 계정에서 신청 상태를 확인해 주세요. 필요한 내용을 보완한 뒤 다시 신청할 수 있어요.', '내 가입 상태 확인'],
      revoked: ['이용 승인 확인 필요', '길드 이용 승인이 변경되었어요.', '내 계정에서 현재 상태를 확인하거나 운영진에게 문의해 주세요.', '내 가입 상태 확인'],
      unavailable: ['상태 확인 필요', '가입 상태를 확인하지 못했어요.', '잠시 후 다시 확인하거나 내 계정에서 가입 상태를 확인해 주세요.', '내 가입 상태 확인'],
    },
  };
  // 페이지가 요구하는 권한을 갖췄는지. 서버 권한 검사를 대신하지 않고 화면 안내와 요청 시작만 가른다.
  const granted = detail => (requirement === 'personal' ? detail.personal === 'ready' : detail.guild === 'approved');
  function renderAccess(detail, initial = false) {
    if (!accessCard) return;
    const wasInGate = accessCard.contains(document.activeElement);
    const wasInside = feature.contains(document.activeElement) && !accessCard.contains(document.activeElement);
    const open = granted(detail);
    feature.dataset.siteAccess = open ? 'open' : 'locked';
    accessCard.hidden = open;
    if (open) {
      if (wasInGate) { if (!feature.hasAttribute('tabindex')) feature.tabIndex = -1; feature.focus({ preventScroll: true }); }
      return;
    }
    const state = detail[requirement];
    const stateKey = `${initial ? 'checking' : state}:${detail.authenticated}`;
    if (accessCard.dataset.accessState === stateKey) return;
    accessCard.dataset.accessState = stateKey;
    // GitHub 사본: auth.js가 세션을 묻지 않고 unavailable을 발표한다. 확인 실패 안내 대신 정적 안내와 운영 서비스의
    // 같은 화면으로 가는 링크를 둔다.
    const area = feature.dataset.siteFeature;
    const staticState = !initial && staticHost;
    const copy = initial ? ['확인 중', '이용 권한을 확인하고 있어요.', '잠시만 기다려 주세요.', '내 계정']
      : staticState ? [staticText('stage'), staticText(`${area}.title`), staticText(`${area}.body`), staticText(`${area}.action`)]
      : gateCopy[requirement][state] || gateCopy[requirement].unavailable;
    const badge = document.createElement('p'); badge.className = 'site-access-stage'; badge.textContent = copy[0];
    const title = document.createElement('h1'); title.textContent = copy[1]; title.tabIndex = -1;
    const description = document.createElement('p'); description.textContent = copy[2];
    const actions = document.createElement('div'); actions.className = 'site-access-actions';
    const account = document.createElement('a'); account.className = 'realm-action primary';
    account.href = staticState ? `${serviceOrigin}/${area}.html` : new URL('account.html', base).href;
    account.textContent = copy[3];
    const home = document.createElement('a'); home.className = 'realm-action'; home.href = new URL('index.html', base).href; home.textContent = '홈으로';
    actions.append(account, home);
    accessCard.replaceChildren(badge, title, description, actions);
    if (wasInside) title.focus({ preventScroll: true });
  }
  // 서버는 비로그인이면 두 값 모두 anonymous, 로그인이면 어느 값도 anonymous가 아니다. 어긋난 조합이나 모르는 값은 확인 불가로 본다.
  function accessState(states, value, authenticated) {
    if (!states.has(value) || value === 'unavailable') return 'unavailable';
    return (value === 'anonymous') === !authenticated ? value : 'unavailable';
  }
  window.publishPogeunSiteAccess = value => {
    const authenticated = value?.authenticated === true;
    const detail = Object.freeze({ authenticated, personal: accessState(personalStates, value?.personal, authenticated),
      guild: accessState(guildStates, value?.guild, authenticated) });
    window.pogeunSiteAccess = detail;
    renderAccess(detail);
    renderAccountLinks(detail);
    if (!accessResolved) { accessResolved = true; settleAccess(detail); }
    document.dispatchEvent(new CustomEvent('site:access', { detail }));
    return detail;
  };
  renderAccess(window.pogeunSiteAccess, true);
  const root = document.querySelector('[data-site-header]');
  if (!root) return;
  const path = name => new URL(name, base).href;
  const icon = document.querySelector('link[rel="icon"]') || document.head.appendChild(document.createElement('link'));
  icon.rel = 'icon'; icon.type = 'image/png'; icon.href = path('assets/pogeun-sprout-logo.png');
  const mark = `<img class="realm-logo" src="${path('assets/pogeun-sprout-logo.png')}" width="32" height="32" alt="" decoding="async">`;
  const searchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path></svg>';
  const updateIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Z"></path><path d="M10 20h4M12 2v2"></path></svg>';
  root.classList.add('realm-header');
  root.innerHTML = `<div class="realm-header-inner"><a class="realm-brand" href="${path('index.html')}" aria-label="포근해용 홈">${mark}<span>포근해용</span></a><nav id="realm-navigation" class="realm-nav" aria-label="주요 메뉴"></nav><div class="realm-header-tools"><a class="realm-icon-link" href="${path('spec.html')}" aria-label="캐릭터 검색" title="캐릭터 검색">${searchIcon}</a><a class="realm-icon-link realm-update-link" href="${path('updates.html')}" aria-label="업데이트 내역" title="업데이트 내역">${updateIcon}</a><div class="realm-account"><a href="${path('account.html')}" data-account-link>로그인</a><a href="${path('account.html')}" data-registration-link>회원가입</a></div><button class="realm-menu-toggle" type="button" aria-expanded="false" aria-controls="realm-navigation realm-menu-panel" aria-label="메뉴 열기"><span></span><span></span><span></span></button></div><div id="realm-menu-panel" class="realm-menu-panel" hidden><a href="${path('account.html')}">내 계정·가입 상태</a><a href="${path('guild.html')}" data-guild-link hidden>우리 길드</a><div data-theme-mount></div></div></div>`;
  const nav = root.querySelector('nav');
  const items = [['home','홈','index.html#intro'],['spec','캐릭터','spec.html'],['ranking','랭킹','ranking.html'],['todo','숙제','todo.html'],['tools','시장·도구','tools.html'],['guild','길드','guild.html'],['commands','명령어','index.html#commands'],['updates','업데이트','index.html#updates']];
  for (const [key,label,url] of items) {
    const a = document.createElement('a'); a.href = path(url); a.textContent = label; a.dataset.nav = key; nav.append(a);
  }
  const button = root.querySelector('.realm-menu-toggle');
  const menuPanel = root.querySelector('.realm-menu-panel');
  button.addEventListener('click', () => { const open = button.getAttribute('aria-expanded') !== 'true'; button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기'); root.classList.toggle('menu-open', open); menuPanel.hidden = !open; });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && root.classList.contains('menu-open')) { button.click(); button.focus(); } });
  nav.addEventListener('click', event => { if (event.target.closest('a') && root.classList.contains('menu-open')) button.click(); });
  document.addEventListener('click', event => { if (!root.contains(event.target) && root.classList.contains('menu-open')) button.click(); });
  function renderAccountLinks(detail) {
    const account = document.querySelector('[data-site-header] [data-account-link]');
    const registration = document.querySelector('[data-site-header] [data-registration-link]');
    if (account) account.textContent = detail.authenticated ? '내 계정' : '로그인';
    if (registration) { registration.textContent = detail.authenticated ? '가입 상태' : '회원가입'; registration.hidden = detail.guild === 'approved'; }
  }
  renderAccountLinks(window.pogeunSiteAccess);
  const memberProfileLink = document.createElement('a');
  memberProfileLink.className = 'realm-member-profile'; memberProfileLink.href = path('account.html');
  memberProfileLink.hidden = true; memberProfileLink.setAttribute('aria-label', '내 대표 캐릭터 · 내 계정');
  root.querySelector('.realm-account').prepend(memberProfileLink);
  let profileGeneration = 0, profileController = null, profileTask = null, profileData = null, profileFetchedAt = 0;
  // 이미지 출처를 자기 사이트로 묶은 페이지는 data-member-avatar="initial"로 첫 글자 아바타만 쓰고 원격 초상화를 요청하지 않는다.
  const remotePortrait = root.dataset.memberAvatar !== 'initial';
  const characterName = value => typeof value === 'string' && /^[가-힣A-Za-z0-9]{2,12}$/.test(value);
  const profileImage = value => typeof value === 'string' && value.length <= 2048 && /^https:\/\/cdn-lostark\.game\.onstove\.com\/armory\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jpg|png|webp)(?:\?v=[A-Za-z0-9_-]{1,64})?$/.test(value);
  const profileNode = (tag, name, text) => { const e = document.createElement(tag); e.className = name; if (text !== undefined) e.textContent = text; return e; };
  function paintMemberProfile(data) {
    const profile = data?.representative;
    memberProfileLink.replaceChildren();
    const available = window.pogeunSiteAccess?.personal === 'ready' && characterName(profile?.characterName);
    memberProfileLink.hidden = !available;
    root.querySelector('[data-account-link]').hidden = available;
    if (!available) return;
    const avatar = profileNode('span', 'realm-member-avatar', profile.characterName.slice(0, 1)); avatar.setAttribute('aria-hidden', 'true');
    if (remotePortrait && profileImage(profile.characterImage)) {
      const img = document.createElement('img'); img.src = profile.characterImage; img.alt = ''; img.decoding = 'async';
      img.addEventListener('error', () => img.remove(), { once: true }); avatar.append(img);
    }
    const info = profileNode('span', 'realm-member-info'), name = profileNode('strong', 'realm-member-name', profile.characterName);
    const level = Number.isFinite(profile.itemLevel) ? profile.itemLevel.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
    const stats = profileNode('span', 'realm-member-stats', `Lv.${level}`);
    const score = data.score;
    if (score?.status === 'ok' && Number.isFinite(score.score) && typeof score.tier?.name === 'string' && score.tier.name.length <= 30) {
      stats.append(profileNode('span', 'realm-member-score', `환산 ${score.score.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`));
      const tier = profileNode('span', 'realm-member-tier', score.tier.name);
      const percentile = score.tier.status === 'ok' && Number.isFinite(score.tier.percentile) && typeof score.tier.source === 'string' && score.tier.source.length <= 20 ? score.tier.percentile : null;
      const topPercent = value => value < 0.005 ? '0.01% 미만' : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + '%';
      const ref = score.tier.reason === 'lopec_record_mismatch' ? score.tier.reference : null;
      const reference = ref && typeof ref === 'object' && Number.isFinite(ref.score) && ref.score > 0 && Number.isFinite(ref.percentile) && ref.percentile > 0 && ref.percentile <= 100
        && typeof ref.source === 'string' && ref.source.length > 0 && ref.source.length <= 20 ? ref : null;
      tier.title = percentile !== null ? `${score.tier.source} 기준 상위 ${topPercent(percentile)}`
        : reference ? `현재 장착 점수 구간 기준 · ${reference.source} 최고 기록 ${Math.round(reference.score).toLocaleString('ko-KR')}점 기준 상위 ${topPercent(reference.percentile)}`
        : '사이트 자체 환산 점수 · 점수 구간 기준';
      if (typeof score.tier.key === 'string' && /^[a-z]{3,12}$/.test(score.tier.key)) {
        // 전용 그림 대상(tier.art)은 배지 파일만 바뀐다; 파일이 없으면 기존 onerror가 배지를 뗀다.
        const badgeKey = score.tier.art && typeof score.tier.art.key === 'string' && /^[a-z]{3,12}$/.test(score.tier.art.key) ? score.tier.art.key : score.tier.key;
        const badge = document.createElement('img'); badge.className = 'realm-member-tier-badge'; badge.src = path(`assets/tiers/${badgeKey}-sm.webp`);
        badge.alt = ''; badge.width = 18; badge.height = 18; badge.decoding = 'async'; badge.addEventListener('error', () => badge.remove(), { once: true }); tier.prepend(badge);
      }
      info.append(name, stats, tier);
    } else info.append(name, stats, profileNode('span', 'realm-member-tier realm-member-unavailable', '환산 점수 확인 필요'));
    memberProfileLink.append(avatar, info);
    memberProfileLink.title = `${profile.characterName} · ${profile.serverName || ''} · ${profile.characterClass || ''} · 내 계정에서 대표 변경`;
    memberProfileLink.setAttribute('aria-label', [profile.characterName, `아이템 레벨 ${level}`,
      score?.status === 'ok' && Number.isFinite(score.score) ? `환산 점수 ${score.score.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}` : '환산 점수 확인 필요',
      score?.tier?.name, '내 계정'].filter(Boolean).join(' · '));
  }
  function clearMemberProfile() {
    profileGeneration++; profileController?.abort(); profileController = null; profileTask = null; profileData = null; profileFetchedAt = 0;
    paintMemberProfile(null);
    document.dispatchEvent(new CustomEvent('site:member-profile', { detail: null }));
  }
  window.getPogeunMemberProfile = function(force = false) {
    if (window.pogeunSiteAccess?.personal !== 'ready' || document.hidden) return Promise.resolve(null);
    if (!force && profileTask) return profileTask;
    if (!force && profileData && Date.now() - profileFetchedAt < 300000) return Promise.resolve(profileData);
    profileController?.abort();
    const controller = new AbortController(), current = ++profileGeneration; profileController = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    const task = (async () => {
      try {
        const response = await fetch('/api/auth/characters/profile', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
        const data = await response.json();
        if (current !== profileGeneration || controller.signal.aborted || window.pogeunSiteAccess?.personal !== 'ready') return null;
        if (!response.ok) {
          // 대표 캐릭터는 본인 경로다. 401은 로그아웃 상태로 바꾸고, 403은 상태를 짐작하지 않고 세션을 다시 확인한다.
          if (response.status === 401) window.publishPogeunSiteAccess({ authenticated: false, personal: 'anonymous', guild: 'anonymous' });
          else if (response.status === 403) void window.refreshPogeunSiteAccess?.();
          throw new Error('Representative profile unavailable');
        }
        if (data?.representative !== null && (!characterName(data?.representative?.characterName) || !Number.isFinite(data.representative.itemLevel))) throw new Error('Invalid representative profile');
        profileData = data; profileFetchedAt = Date.now(); paintMemberProfile(data);
        document.dispatchEvent(new CustomEvent('site:member-profile', { detail: data })); return data;
      } catch {
        if (current === profileGeneration) { profileData = null; paintMemberProfile(null); document.dispatchEvent(new CustomEvent('site:member-profile', { detail: null })); }
        return null;
      } finally { clearTimeout(timer); if (profileTask === task) profileTask = null; if (profileController === controller) profileController = null; }
    })();
    profileTask = task; return task;
  };
  document.addEventListener('site:access', event => { if (event.detail.personal === 'ready') { if (profileData) paintMemberProfile(profileData); void window.getPogeunMemberProfile(); } else clearMemberProfile(); });
  document.addEventListener('site:representative', () => { clearMemberProfile(); if (window.pogeunSiteAccess?.personal === 'ready') void window.getPogeunMemberProfile(true); });
  window.addEventListener('pagehide', clearMemberProfile);
  function active(tab) {
    const section = tab || location.hash.slice(1);
    const key = root.dataset.active === 'home' ? (['commands','emoticons','link','updates'].includes(section) ? section === 'updates' ? 'updates' : 'commands' : 'home') : root.dataset.active;
    for (const link of nav.querySelectorAll('a')) { if (link.dataset.nav === key) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); }
  }
  active(); addEventListener('hashchange', () => active());
  document.addEventListener('site:navigate', event => active(event.detail));
  for (const footer of document.querySelectorAll('body > footer')) {
    footer.className = 'realm-footer'; footer.setAttribute('data-site-footer', '');
    footer.innerHTML = `<div class="realm-footer-inner"><a class="realm-footer-brand" href="${path('index.html')}">${mark}<span>포근해용</span><small>루페온 · 포근해</small></a><nav aria-label="사이트 안내"><a href="${path('terms.html')}">이용약관</a><a href="${path('privacy.html')}">개인정보처리방침</a><a href="${path('updates.html')}">업데이트</a><a href="mailto:ju00moon@naver.com">문의하기</a></nav><div class="realm-footer-source"><span>로스트아크 오픈 API · 로펙 · 비공식 팬 서비스</span><small>게임·이미지 © 각 권리자 · MIT License</small></div></div><p class="realm-footer-attribution">데이터 출처: 로스트아크 오픈 API — 본 사이트는 Smilegate RPG와 무관한 팬 프로젝트입니다. 이모티콘 이미지는 원작자에게 저작권이 있습니다.</p>`;
  }
})();
