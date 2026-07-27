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
  /**
   * 그 판단이 **무엇에 관한 것인가** (TOP STORY 문장).
   *
   * ★ 없으면 예전처럼 모든 실적이 모든 판단을 만료시킨다 — 그건 너무 넓다.
   *   실측 사고: "Futures surge as US and Iran pause strikes, oil plunges 5%" 가
   *   **PayPal 실적** 때문에 만료 처리돼, 그 자리에 로이터 데일리 칼럼 제목
   *   "Morning Bid: Markets dare to hope" 가 올라갔다.
   *   페이팔 실적은 미국-이란 유가 국면과 아무 상관이 없다.
   *   좋은 판단이 무관한 사건에 밀려 더 나쁜 것으로 교체된 셈이다.
   */
  text?: string;
  now?: number;
};

export type SupersedeResult = {
  superseded: boolean;
  /** 판단 생성 이후에 발생한 주요 이벤트 티커들 */
  by: string[];
};

/**
 * 그 판단이 **실적 이야기인가**.
 *  실적 발표가 판단을 낡게 만드는 건 그 판단이 실적을 다룰 때뿐이다.
 *  지정학·유가·연준 이야기는 어느 회사가 실적을 냈든 여전히 유효하다.
 */
const EARNINGS_TOPIC =
  /\b(earnings|results|guidance|profit|revenue|eps|quarter\w*|beat|miss|report(?:s|ed|ing)?)\b/i;

/**
 * 판단 생성 시각과 지금 사이에 **중요 이벤트가 발생했으면** 그 판단은 낡은 것으로 본다.
 * 몇 분 전에 만들어졌더라도 마찬가지다 — 세상이 그 사이에 바뀌었기 때문이다.
 *
 * ★ 단, **관련 있는 사건일 때만**이다.
 *   판단이 그 종목을 직접 언급했거나, 실적 자체를 다루고 있을 때만 만료시킨다.
 *   무관한 실적까지 만료 사유로 삼으면, 좋은 판단이 밀려나고 그 자리에
 *   기사 제목이 올라간다 — 실측된 실패다(위 SupersedeInput.text 주석 참고).
 */
export function checkSuperseded(
  { generatedAt, events, text = "", now = Date.now() }: SupersedeInput
): SupersedeResult {
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) return { superseded: false, by: [] };

  // text 가 없으면(호출부가 안 넘기면) 예전처럼 전부 만료 — 안전한 기본값
  const aboutEarnings = !text || EARNINGS_TOPIC.test(text);

  const by = events
    .filter((e) => {
      if (!e.important || !Number.isFinite(e.ts)) return false;
      if (!(e.ts > generatedAt && e.ts <= now)) return false;
      // 판단이 그 종목을 직접 말하고 있으면 무조건 만료 (내용이 바로 그것이다)
      const named = text
        ? new RegExp(`(?<![\\w-])${e.ticker}(?![\\w-])`, "i").test(text)
        : false;
      return named || aboutEarnings;
    })
    .map((e) => e.ticker);

  // 중복 제거하고 최대 4개까지만 (화면 표기용)
  const uniq = [...new Set(by)].slice(0, 4);
  return { superseded: uniq.length > 0, by: uniq };
}
