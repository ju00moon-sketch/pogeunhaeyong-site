// 랭킹 화면 사용자 안내 문구 사전
// 로펙(LOPEC) 공개 랭킹 정적 스냅샷 기준

window.POGEUN_RANKING_COPY = Object.freeze({
  // 메타 정보
  'meta.title': '로펙 랭킹 스냅샷 | 포근해용',
  'meta.description': '로펙(LOPEC) 공개 순위표의 딜러 및 서포터 상위 100위 정보입니다.',

  // 공통 머리 메뉴 (내비게이션)
  'nav.ranking': '랭킹',

  // 페이지 제목 및 안내
  'page.title': '로펙 랭킹 스냅샷',
  'page.intro': '로펙(LOPEC) 공개 순위표의 딜러 및 서포터 상위 100위 캐릭터 정보입니다. 자체 전투력이나 종합 점수가 아닌 로펙의 공개 점수를 보여줍니다.',

  // 출처 정보
  'source.label': '자료 출처:',
  'source.link': 'LOPEC (lopec.kr/rank/specPoint)',

  // 상시 안내 (범위, 수집 시각, 주의 문단)
  'coverage': '역할별 상위 {limit}명 기준',
  'collected': '수집 시각: {time} (한국 시간)',
  'notice': '특정 시점에 한 번 수집한 자료로 자동 갱신되지 않습니다. 검색과 필터는 수집된 상위 {limit}명 안에서만 동작하며 원래 순위를 유지합니다.',

  // 역할 선택 (탭 / 전환 묶음)
  'role.group': '역할 선택',
  'role.dealer': '딜러',
  'role.support': '서포터',

  // 검색 및 필터
  'filter.search.label': '캐릭터명 검색',
  'filter.search.placeholder': '캐릭터명을 입력하세요',
  'filter.server.label': '서버 선택',
  'filter.server.all': '전체 서버',
  'filter.class.label': '직업 선택',
  'filter.class.all': '전체 직업',
  'filter.reset': '초기화',

  // 결과 수 및 표 접근성
  'result.count': '{shown} / {total}명',
  'table.caption': '로펙 {role} 상위 100위 순위 표',

  // 표 헤더 열
  'col.rank': '순위',
  'col.character': '캐릭터',
  'col.server': '서버',
  'col.class': '직업',
  'col.itemLevel': '아이템 레벨',
  'col.score': '환산 점수',

  // 상태 안내
  'state.loading': '랭킹 자료를 불러오고 있습니다...',
  'state.error': '랭킹 자료를 불러오지 못했습니다.',
  'state.empty': '조건에 맞는 캐릭터가 없습니다.',
});
