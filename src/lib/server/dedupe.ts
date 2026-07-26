// ============================================================
//  헤드라인 근사 중복 판정
//
//  왜 필요한가:
//   Finnhub 의 general 뉴스 피드는 **같은 사건을 여러 매체가 각자 쓴 기사**를 그대로 준다.
//   그래서 화면에 이런 목록이 나왔다:
//     · "Oil surges as Middle East supply fears mount"
//     · "Crude oil jumps on Middle East supply fears"
//     · "Oil prices climb amid supply fears in the Middle East"
//   셋 다 별 5개짜리 유효한 기사라 기존 필터(level/matched)는 전부 통과시켰다.
//   시청자 입장에선 "같은 뉴스가 세 번" 이고, 그만큼 다른 뉴스가 밀려났다.
//
//   더 나쁜 경우: Claude 가 만든 TOP STORY 와 그 아래 헤드라인이 같은 사건이었다.
//   digest 는 `n.id !== top.id` 로만 걸렀는데, AI 판단은 원문 기사와 id 가 다르므로
//   **항상 통과했다.** 최상단 큰 글씨와 바로 아래 첫 줄이 같은 이야기를 했다.
//
//  방식: 제목을 토큰으로 쪼개 겹침을 본다. 임베딩·LLM 을 쓰지 않는다 —
//        비용이 0이고, 결정적이라 같은 입력에 항상 같은 결과가 나온다.
// ============================================================

/** 어느 기사에나 나오는 단어들 — 겹쳐도 "같은 사건"의 근거가 못 된다 */
const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "than", "then", "into", "onto",
  "after", "amid", "over", "under", "about", "says", "said", "will", "would", "could",
  "may", "might", "has", "have", "had", "was", "were", "are", "its", "his", "her",
  "their", "they", "you", "your", "our", "but", "not", "all", "new", "more", "most",
  "how", "why", "what", "when", "who", "here", "his", "out", "off", "per", "via",
  "amid", "ahead", "near", "next", "last", "week", "day", "days", "year", "years",
  "report", "reports", "update", "updates", "live", "news", "story", "stories",
  "market", "markets", "stock", "stocks", "share", "shares", "investors", "analysts"
]);

/**
 * 제목 → 의미 토큰 집합.
 *  · 3글자 미만 제거 (관사·전치사 잔여물)
 *  · STOP 제거
 *  · 숫자·%·$ 는 남긴다 ("110", "3.4%" 는 같은 사건을 가리키는 강한 신호다)
 */
export function titleTokens(s: string): Set<string> {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/['’]s\b/g, "")
      .replace(/[^a-z0-9$%.\s-]/g, " ")
      .split(/[\s\-–—]+/)
      .map((w) => w.replace(/^[.$]+|[.,]+$/g, ""))
      .filter((w) => w.length >= 3 && !STOP.has(w))
  );
}

/**
 * 0~1 유사도.
 *  Jaccard 만 쓰면 **길이 차가 큰 쌍을 놓친다.**
 *   "Fed holds rates steady"(3토큰) vs
 *   "Fed holds rates steady as Powell signals patience on cuts amid sticky inflation"(9토큰)
 *   → 교집합 3, 합집합 9 = 0.33 으로 "다른 기사" 판정. 실제론 같은 사건이다.
 *  그래서 **짧은 쪽 기준 포함율**도 같이 본다.
 */
export function titleSimilarity(a: string, b: string): number {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size < 2 || B.size < 2) return 0; // 토큰이 너무 적으면 판단하지 않는다
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter < 2) return 0; // 한 단어 겹침(주로 티커명)만으로 같은 기사라고 하지 않는다
  const jaccard = inter / (A.size + B.size - inter);
  const coverage = inter / Math.min(A.size, B.size);
  return Math.max(jaccard, coverage >= 0.8 ? coverage : 0);
}

/**
 * 같은 사건을 다룬 기사인가.
 *  임계값은 보수적으로 잡는다 — **중복을 하나 놓치는 것보다 진짜 뉴스를 지우는 게 더 나쁘다.**
 */
export function isNearDuplicate(a: string, b: string, threshold = 0.55): boolean {
  return titleSimilarity(a, b) >= threshold;
}

/**
 * 목록에서 근사 중복을 제거한다. **앞선 항목이 이긴다** —
 * 호출부가 이미 중요도·신선도로 정렬해 두므로, 남는 건 그중 대표 기사다.
 */
export function dropNearDuplicates<T>(
  rows: T[],
  textOf: (row: T) => string,
  threshold = 0.55
): T[] {
  const kept: T[] = [];
  for (const r of rows) {
    const t = textOf(r);
    if (kept.some((k) => isNearDuplicate(textOf(k), t, threshold))) continue;
    kept.push(r);
  }
  return kept;
}
