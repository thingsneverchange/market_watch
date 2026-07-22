// ============================================================
//  "판단이 사건보다 뒤처졌는가" 판정
//
//  실제로 겪은 실패:
//    Claude 가 7분 전에 만든 TOP STORY 가 "알파벳·테슬라 실적 발표를 앞두고"
//    라는 내용이었는데, 그 사이 실적이 이미 발표됐다.
//    시간 기준으로는 7분 전이라 '신선함' 판정을 통과했다.
//
//  → 시간 신선도(ageSec)만으로는 이걸 못 잡는다.
//    "생성 이후에 예정된 큰 사건이 실제로 지나갔는가"를 따로 봐야 한다.
// ============================================================

export type SupersedeInput = {
  /** 판단이 만들어진 시각 (epoch ms) */
  generatedAt: number;
  /** 실적 등 예정 이벤트 목록 */
  events: { ticker: string; ts: number; important: boolean }[];
  now?: number;
};

export type SupersedeResult = {
  superseded: boolean;
  /** 판단 생성 이후에 발생한 주요 이벤트 티커들 */
  by: string[];
};

/**
 * 판단 생성 시각과 지금 사이에 **중요 이벤트가 발생했으면** 그 판단은 낡은 것으로 본다.
 * 몇 분 전에 만들어졌더라도 마찬가지다 — 세상이 그 사이에 바뀌었기 때문이다.
 */
export function checkSuperseded({ generatedAt, events, now = Date.now() }: SupersedeInput): SupersedeResult {
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) return { superseded: false, by: [] };

  const by = events
    .filter((e) => e.important && Number.isFinite(e.ts) && e.ts > generatedAt && e.ts <= now)
    .map((e) => e.ticker);

  // 중복 제거하고 최대 4개까지만 (화면 표기용)
  const uniq = [...new Set(by)].slice(0, 4);
  return { superseded: uniq.length > 0, by: uniq };
}
