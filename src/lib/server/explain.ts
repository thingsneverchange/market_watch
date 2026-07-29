import type { NewsItem } from "./finnhub";

// ============================================================
//  급변 설명 — "방금 튄 건 알겠는데, 무슨 일이 있었나"
//
//  ── 왜 지금 가능해졌나 ────────────────────────────
//  breaking/+server.ts 는 z-score 급변만 방송하고 **원인은 말하지 않는다.**
//  그건 옳은 판단이었다 — 그때는 뉴스 소스가 Finnhub 하나였고, 실측 최신 기사가
//  598분(10시간) 전이라 "방금 무슨 일"에 답할 재료 자체가 없었다.
//  지금은 와이어가 최신 2~11분이다. 처음으로 대조가 성립한다.
//
//  ── 인과를 주장하지 않는다 ────────────────────────
//  같은 시간대에 그 자산 이름이 들어간 기사가 있었다는 **사실**만 말한다.
//  화면 문구도 "…이 원인" 이 아니라 나란히 놓는 형태여야 한다.
//  기사가 없으면 아무 말도 하지 않는다 — 억지로 갖다 붙이면 그게 오보다.
//
//  ── LLM 을 쓰지 않는다 ────────────────────────────
//  하루 20회 예산은 이미 다 배정돼 있고, 애초에 이건 문자열 매칭으로 충분하다.
//  급변은 5분 안에 판정돼야 하는데 크론 주기는 2~4시간이라 구조적으로도 안 맞는다.
// ============================================================

/** Finviz 선물 키 → 그 자산을 가리키는 헤드라인 표현 */
const ASSET_WORDS: Record<string, RegExp> = {
  NQ:  /\b(?:nasdaq|ndx|tech stocks?)\b/i,
  ES:  /\b(?:s&p ?500|spx|wall street|us stocks?)\b/i,
  YM:  /\b(?:dow|djia)\b/i,
  ER2: /\b(?:russell|small[- ]caps?)\b/i,
  CL:  /\b(?:oil|crude|wti|opec)\b/i,
  QA:  /\b(?:brent|oil|crude|opec)\b/i,
  NG:  /\b(?:natural gas|nat gas)\b/i,
  RB:  /\b(?:gasoline|rbob)\b/i,
  HO:  /\b(?:heating oil|diesel)\b/i,
  GC:  /\bgold\b/i,
  SI:  /\bsilver\b/i,
  HG:  /\bcopper\b/i,
  PL:  /\bplatinum\b/i,
  ZN:  /\b(?:treasur\w+|10[- ]year|bond yields?|yields?)\b/i,
  ZB:  /\b(?:treasur\w+|30[- ]year|long bond)\b/i,
  ZF:  /\b(?:treasur\w+|5[- ]year)\b/i,
  DX:  /\b(?:dollar|dxy|greenback)\b/i,
  VX:  /\b(?:vix|volatility|fear gauge)\b/i,
  BTC: /\b(?:bitcoin|btc|crypto)\b/i,
  NKD: /\b(?:nikkei|japan\w*)\b/i,
  EX:  /\b(?:euro stoxx|european stocks?|dax)\b/i
};

/**
 * 거시 사건은 자산 이름이 안 들어가도 그 자산을 움직인다.
 * "Fed holds rates" 에는 'treasury' 도 'dollar' 도 없지만 둘 다 움직인다.
 */
const MACRO_WORDS =
  /\b(?:fed|fomc|powell|rate (?:cut|hike|decision)|cpi|inflation|payrolls?|jobs report|jobless|gdp|tariff\w*|sanction\w*|opec|war|strike[sd]?|ceasefire)\b/i;
const MACRO_SENSITIVE = new Set(["NQ", "ES", "YM", "ER2", "ZN", "ZB", "ZF", "DX", "VX", "GC"]);

export type SpikeNote = {
  /** 화면에 나란히 놓을 헤드라인 */
  headline: string;
  source: string;
  /** 그 기사가 급변보다 몇 분 **앞서** 나왔나. 음수면 급변 뒤에 나온 기사다 */
  leadMin: number;
};

/**
 * 급변과 같은 시간대의 기사 중 그 자산을 언급한 것을 고른다.
 *
 * @param key      Finviz 심볼 (NQ, CL …)
 * @param windowMin 급변이 덮는 구간(분). 종목마다 다르므로 호출부가 실측값을 넘긴다
 * @param news     와이어 기사 (최신순)
 * @returns 없으면 null — **없는 원인을 지어내지 않는다**
 */
export function explainSpike(
  key: string, windowMin: number, news: NewsItem[], now = Date.now()
): SpikeNote | null {
  const re = ASSET_WORDS[key];
  if (!re) return null;

  // 급변 구간 + 앞뒤 여유. 기사가 먼저 나오고 가격이 따라가는 게 보통이라 앞쪽을 넉넉히 본다.
  const oldestMs = now - (windowMin + 20) * 60_000;
  const newestMs = now + 60_000;

  let best: SpikeNote | null = null;
  for (const n of news) {
    const t = n.epoch * 1000;
    if (t < oldestMs || t > newestMs) continue;
    const named = re.test(n.title);
    const macro = MACRO_SENSITIVE.has(key) && MACRO_WORDS.test(n.title);
    if (!named && !macro) continue;
    // 자산 이름이 직접 들어간 기사를 거시 기사보다 우선하고, 그다음은 이른 것을 고른다
    const score = (named ? 2 : 0) + (n.level >= 4 ? 1 : 0);
    const cand: SpikeNote = {
      headline: n.title,
      source: n.source,
      leadMin: Math.round((now - t) / 60_000)
    };
    if (!best) { best = cand; (best as any)._s = score; continue; }
    if (score > ((best as any)._s ?? 0)) { best = cand; (best as any)._s = score; }
  }
  if (best) delete (best as any)._s;
  return best;
}
