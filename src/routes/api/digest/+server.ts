import type { RequestHandler } from "./$types";
import { getMarketNews, getEarnings, newsTopic, newsThemes, shortHeadline, WATCHLIST, TAPE_TICKERS, INDEX_TICKERS, MAJORS } from "$lib/server/finnhub";
import { getFeed, fresh } from "$lib/server/marketfeed";
import { checkSuperseded } from "$lib/server/supersede";
import { earnPendingFrom } from "$lib/server/et-time";
import { dropNearDuplicates, isNearDuplicate } from "$lib/server/dedupe";
import { isFragment, contradictsLive } from "$lib/server/headline";
import { getFutures } from "$lib/server/finviz";
import { getBtc } from "$lib/server/coingecko";
import { recordStory, previousStories } from "$lib/server/storylog";

// 이 종목들의 실적은 "시장 전체가 보는 사건"이다 — 발표되면 기존 판단이 낡는다 (INTC 등 대형주 포함)
const MAJOR = new Set([...WATCHLIST, ...INDEX_TICKERS, ...TAPE_TICKERS, ...MAJORS]);

/**
 * URL 에서 **언론사 이름**을 뽑는다.
 *  화면의 "1h ago · ○○" 자리는 짧은 출처 라벨용이다.
 *  예전엔 AI 항목이 여기에 원문 **기사 제목**을 통째로 넣어서
 *  "1h ago · Megacap earnings and Fed meeting could test a market on edge
 *   next week. Here's what's ahead" 처럼 나갔다 — 걷어낸 바로 그 클릭 유도 문구가
 *  다른 자리로 새어 나온 셈이다.
 */
const PUBLISHER: Record<string, string> = {
  "cnbc.com": "CNBC", "reuters.com": "Reuters", "bloomberg.com": "Bloomberg",
  "wsj.com": "WSJ", "ft.com": "FT", "marketwatch.com": "MarketWatch",
  "barrons.com": "Barron's", "apnews.com": "AP", "investing.com": "Investing.com",
  "yahoo.com": "Yahoo Finance", "businessinsider.com": "Business Insider",
  "fortune.com": "Fortune", "axios.com": "Axios", "politico.com": "Politico",
  "news.google.com": "Google News", "seekingalpha.com": "Seeking Alpha"
};
function publisherOf(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    if (PUBLISHER[h]) return PUBLISHER[h];
    // 서브도메인이 붙은 경우 뒤 두 조각으로 한 번 더
    const base = h.split(".").slice(-2).join(".");
    if (PUBLISHER[base]) return PUBLISHER[base];
    // 그래도 모르면 도메인 본체를 그대로 (첫 글자만 대문자)
    const name = base.split(".")[0];
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
  } catch {
    return "";
  }
}

// ============================================================
//  MARKET DRIVER — "지금 이 시장을 무엇이 지배하고 있나"
//
//  왜 필요했나:
//   MARKET DRIVERS 패널은 MACRO(지난 거시 발표) + MOVERS(실적 반응) 두 그룹뿐이라,
//   주말이나 실적 비수기엔 **양쪽 다 비어서 "No macro release / No reaction data"** 만 떴다.
//   정작 시장을 움직이는 게 전쟁이어도 화면 어디에도 "WAR" 라는 말이 없었다.
//   토픽 분류(newsTopic)는 이미 헤드라인마다 붙어 있었는데 **집계를 안 했을 뿐**이다.
//
//  방식: 헤드라인 토픽을 중요도×신선도로 가중 합산해 1위 주제를 뽑는다.
//        LLM 을 쓰지 않는다 — 이미 있는 분류를 세는 것뿐이라 비용 0, 결정적이다.
// ============================================================
const THEME_LABEL: Record<string, string> = {
  GEO: "WAR", FED: "FED", CPI: "INFLATION", JOBS: "JOBS", GDP: "GROWTH",
  OIL: "OIL", GOLD: "GOLD", CRYPTO: "CRYPTO", FX: "DOLLAR", BONDS: "YIELDS",
  TRADE: "TARIFFS", CHIPS: "CHIPS", "M&A": "M&A", EARNINGS: "EARNINGS"
};

/**
 * 주제를 특정하는 **지명** — "WAR" 가 아니라 "IRAN WAR" 여야 정보다.
 *
 * 대문자 단어를 자동으로 긁는 방식은 버렸다. "Red Sea" 가 "Red · Sea" 로 쪼개지고,
 * 기여 기사가 2~3건일 땐 반복되는 이름이 없어 거의 항상 비었다.
 * 다어절 이름을 **통째로 매치하는 목록**이 결과가 훨씬 안정적이다.
 * 인명·기관명(Powell·FOMC·OPEC)은 넣지 않는다 — "POWELL FED" 처럼 어색해지고,
 * 주제 라벨(FED/OIL)이 이미 같은 말을 하고 있다.
 */
const QUALIFIERS: [RegExp, string][] = [
  [/\biran(?:ian)?\b/i, "IRAN"],
  [/\bisrael(?:i)?\b/i, "ISRAEL"],
  [/\bruss(?:ia|ian)\b/i, "RUSSIA"],
  [/\bukrain(?:e|ian)\b/i, "UKRAINE"],
  [/\bgaza\b/i, "GAZA"],
  [/\b(?:yemen|houthi)\w*\b/i, "YEMEN"],
  [/\bred sea\b/i, "RED SEA"],
  [/\bhormuz\b/i, "HORMUZ"],
  [/\b(?:china|chinese|beijing)\b/i, "CHINA"],
  [/\btaiwan\b/i, "TAIWAN"],
  [/\bnorth korea\b/i, "N.KOREA"],
  [/\bvenezuela\b/i, "VENEZUELA"],
  [/\b(?:europe|european union|brussels)\b/i, "EUROPE"],
  [/\bjapan(?:ese)?\b/i, "JAPAN"],
  [/\bindia\b/i, "INDIA"],
  [/\bmexico\b/i, "MEXICO"],
  [/\bcanada\b/i, "CANADA"]
];

/**
 * 기여 헤드라인들에서 지명을 고른다.
 *  등장 횟수로 세되 **TOP STORY 에 나온 이름엔 가산점**을 준다 — 거기 나왔다면 그게 주인공이다.
 *  점수 2 미만이면 붙이지 않는다(한 기사에 스쳐 나온 지명을 주제로 승격시키지 않는다).
 */
function themeQualifier(titles: string[], topTitle: string): string {
  let bestName = "", bestScore = 0;
  for (const [re, name] of QUALIFIERS) {
    let score = titles.reduce((n, t) => n + (re.test(t) ? 1 : 0), 0);
    if (re.test(topTitle)) score += 1;
    if (score > bestScore) { bestScore = score; bestName = name; }
  }
  return bestScore >= 2 ? bestName : "";
}

/**
 * 주제가 **왜 시장에 중요한가** 한 줄.
 *  주제마다 고정 문장이다 — 그때그때 지어내지 않는다. 전달하는 건 사건이 아니라
 *  메커니즘이라서, 이 문장이 틀릴 일이 없고 "왜 하필 이 세 자산을 보여주나"를 설명한다.
 */
const THEME_NOTE: Record<string, string> = {
  GEO: "Risk premium shows up first in crude, gold and volatility.",
  OIL: "Energy costs feed straight into inflation and transport margins.",
  GOLD: "Gold bids when real yields fall or risk premium rises.",
  FED: "The rate path sets the discount rate under every long-duration asset.",
  CPI: "Hotter prints push rate-cut expectations further out.",
  JOBS: "A tight labour market is what keeps the Fed from easing.",
  GDP: "Growth data decides between soft landing and slowdown.",
  BONDS: "Yields are the hurdle rate megacap valuations are measured against.",
  TRADE: "Tariffs hit importer margins and China-exposed revenue first.",
  CHIPS: "Semis lead the index — they carry the AI capex cycle.",
  CRYPTO: "Crypto trades as the highest-beta read on risk appetite.",
  FX: "A stronger dollar squeezes overseas earnings and commodities.",
  EARNINGS: "Guidance moves the tape more than the quarter just reported.",
  "M&A": "Deal flow signals how cheap money and corporate confidence are."
};

export const GET: RequestHandler = async () => {
  // ★ 시세도 같이 받는다 — 헤드라인이 우리 화면의 값과 모순되는지 반증하기 위해서다.
  //   Finviz 는 49개 선물을 **한 번의 요청**으로 주고 /api/boards 가 이미 캐시를 데워 놨다.
  const [news, feed, earn, fut, btc] = await Promise.all([
    getMarketNews(24), getFeed(), getEarnings(3), getFutures(), getBtc()
  ]);
  // 화면에 실제로 띄우는 값과 **같은 출처**를 쓴다. 다른 값으로 반증하면 그 자체가 사고다.
  const livePx = new Map<string, number>();
  for (const k of ["OIL", "GOLD", "NQ", "ES", "YM", "VIX"]) {
    const f = fut.get(k === "OIL" ? "CL" : k === "GOLD" ? "GC" : k === "VIX" ? "VX" : k);
    if (f?.price) livePx.set(k, f.price);
  }
  if (btc?.price) livePx.set("BTC", btc.price);
  const nowSec = Date.now() / 1000;

  // 예전에는 level 내림차순으로만 정렬해서 "LIVE HEADLINES" 상단에
  // 20시간 전 level 5 기사가 영구히 박제됐다.
  // 반대로 순수 시간순으로 바꾸면 상단 두 줄이 칼럼·잡기사로 채워진다(실측).
  // → 시간 감쇠 점수: 6시간마다 레벨 1씩 깎는다.
  const decay = (n: { level: number; epoch: number }) =>
    n.level - (nowSec - n.epoch) / 3600 / 6;
  const sorted = [...news].sort((a, b) => decay(b) - decay(a));

  // ★ 같은 사건을 다룬 기사 정리.
  //   Finnhub 의 general 피드는 한 사건을 매체 수만큼 준다. 전부 유효한 기사라
  //   기존 필터(level/matched)는 하나도 못 걸렀고, 화면엔 같은 뉴스가 연달아 세 줄 떴다.
  //   정렬 **뒤에** 거르므로, 남는 건 그중 점수가 가장 높은 대표 기사다.
  const deduped = dropNearDuplicates(sorted, (n) => n.title);

  // ★ 우리 화면의 시세와 **정면으로 어긋나는** 기사를 뺀다.
  //   실측 사고 — 같은 화면에 이 둘이 동시에 떠 있었다:
  //     헤드라인   "Oil near $100 puts fed and peers in interest-rate spotlight" (27시간 전, 5★)
  //     시세 스트립  OIL  84.32  −5.63%
  //   기사가 나온 시점엔 맞는 말이었다. 지금은 아니고, 시청자는 둘을 동시에 본다.
  //   나이로 거르는 것과 다르다 — 27시간 기사도 여전히 유효할 수 있고, 3시간 기사가
  //   급변한 시세에 무효화될 수도 있다. 기준은 시간이 아니라 **반증 가능성**이다.
  const ranked = deduped.filter((n) => {
    const bad = contradictsLive(n.title, livePx);
    if (bad) {
      console.warn(`[digest] 시세와 모순돼 제외: "${n.title.slice(0, 60)}" ` +
        `(${bad.asset} 주장 ${bad.claimed} vs 현재 ${bad.live}, 괴리 ${bad.gap}%)`);
    }
    return !bad;
  });

  // ★ TOP STORY 도 헤드라인 목록과 **같은 관련성 기준**을 통과한 것 중에서 고른다.
  //   예전엔 ranked[0] 을 그대로 썼는데, decay 는 신선도를 크게 쳐서 방금 올라온
  //   무관한 기사(level 2 · matched=false)가 19시간 된 5★ 를 이겼다.
  //     실측: "How this 70-year-old honey bee farmer is keeping his family" (CNBC, level 2)
  //           decay = 2 - 0/6 = 2.00
  //           "Physical oil prices jump with some nearing $110" (level 5, 22시간)
  //           decay = 5 - 22/6 = 1.33   → 꿀벌 기사가 방송 최상단을 차지했다.
  //   헤드라인 목록은 이미 같은 기사를 걸러내고 있었다. **두 곳의 기준이 달랐던 게 문제**다.
  //   관련 기사가 하나도 없으면 억지로 채우지 않는다 (NO NEWS FEED 로 간다).
  const relevant = ranked.filter((n) => n.matched || n.level >= 3);
  const top = relevant[0] ?? null;

  // ── TOP STORY ────────────────────────────────────────
  // 1순위: Claude Code 가 만든 판단 (신선할 때만)
  // 2순위: 키워드 규칙 기반 (기존 동작)
  // 어느 쪽인지 화면이 표시할 수 있도록 source 를 반드시 실어 보낸다.
  // ★ 시간 신선도만으로는 부족하다.
  //   Claude 가 7분 전에 "실적 발표를 앞두고" 라고 썼는데 그 사이 실적이 나왔다면,
  //   그 판단은 7분밖에 안 됐어도 이미 낡았다. 생성 이후 지나간 사건을 확인한다.
  const rawAi = feed?.items?.top_story;
  const sup = rawAi
    ? checkSuperseded({
        generatedAt: rawAi.generatedAt,
        // ★ 판단의 **내용**을 같이 넘긴다. 안 넘기면 무관한 실적까지 만료 사유가 되어
        //   좋은 판단이 기사 제목으로 교체된다 (supersede.ts 주석의 실측 사고).
        text: rawAi.payload.text,
        events: earn.map((e) => ({
          ticker: e.ticker,
          ts: earnPendingFrom(e.date, e.hour),
          important: MAJOR.has(e.ticker)
        }))
      })
    : { superseded: false, by: [] as string[] };

  // ★ confidence 게이트
  //   Claude 가 "신뢰할 출처를 찾지 못했다"고 스스로 밝힌(low) 판단은 헤드라인 자격이 없다.
  //   실제로 이런 문장이 방송 최상단에 올라갔다:
  //     "…다만 발표 직후 반응을 확인해 줄 신뢰할 출처를 아직 찾지 못했다(최신 속보 없음)"
  //   정직한 자백이지만 시청자에게는 쓸모가 없고, 그 자리엔 진짜 헤드라인이 있어야 한다.
  //   대형 이벤트 직후엔 색인된 기사가 없어 low 가 자주 나온다 → 그 구간은 규칙기반이 맡는다.
  const candidate = fresh(feed, "top_story");
  const lowConfidence = candidate?.payload.confidence === "low";
  // ★ Claude 가 만든 문장도 **똑같이 완결성 검사를 통과해야** 방송에 나간다.
  //   프롬프트로 "완성된 문장을 써라"라고 지시하고 있지만 지시는 보장이 아니다.
  //   여기서 걸러야 하는 이유는 규칙 축약 때와 같다 — 파편은 없는 사실을
  //   주장하는 것처럼 읽힌다(→ headline.ts). 생성 경로라고 예외를 둘 근거가 없다.
  const aiFragment = !!candidate && isFragment(candidate.payload.text);
  const ai = sup.superseded || lowConfidence || aiFragment ? undefined : candidate;

  // ★ AI 판단의 **근거 출처를 전부** 싣는다.
  //   Claude 가 웹검색으로 3개 기사를 읽고 한 문장을 만들어도 화면엔 sources[0] 한 곳만
  //   나왔다. 시청자에게는 "CNBC 기사 하나"처럼 보이지만 실제로는 종합 판단이다.
  //   어디서 온 이야기인지가 신뢰의 대부분이므로 매체를 모두 보여준다 (최대 3곳).
  const aiSources = (ai?.payload.sources ?? [])
    .map((s) => ({ name: publisherOf(s?.url ?? ""), url: String(s?.url ?? "") }))
    .filter((s) => s.name && s.url)
    .filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i)
    .slice(0, 3);

  let driver;
  if (ai) {
    driver = {
      text: ai.payload.text,
      sentiment: ai.payload.sentiment,
      // 기사 제목이 아니라 **언론사 이름**을 넣는다 (짧은 라벨 자리다)
      source: aiSources[0]?.name ?? "",
      sources: aiSources,
      url: ai.payload.sources[0]?.url ?? "",
      why: ai.payload.why,
      confidence: ai.payload.confidence,
      epoch: Math.floor(ai.generatedAt / 1000),
      origin: "ai" as const,
      supersededBy: null,
      aiHeld: false,
      noData: false
    };
  } else if (top) {
    driver = {
      // 규칙기반 폴백은 원문 헤드라인이라 길다 → 핵심 구절로 압축 (AI 판단은 이미 짧으니 그대로)
      text: shortHeadline(top.title),
      sentiment: top.sentiment,
      source: top.source,
      sources: top.source && top.url ? [{ name: top.source, url: top.url }] : [],
      url: top.url,
      // 왜 규칙기반으로 내려왔는지를 화면이 말한다 (조용히 바꾸지 않는다)
      why: sup.superseded
        ? `${sup.by.join("·")} 실적 발표로 이전 AI 판단은 만료됨`
        : lowConfidence
          ? "AI 판단이 근거 부족(low)으로 보류됨 — 최신 헤드라인으로 대체"
          : aiFragment
            ? "AI 문장이 미완성이라 보류됨 — 최신 헤드라인으로 대체"
            : "",
      confidence: "",
      epoch: top.epoch,
      origin: "rule" as const, // 인과를 계산하지 않은 키워드 규칙 결과
      supersededBy: sup.superseded ? sup.by : null,
      aiHeld: lowConfidence,
      noData: false
    };
  } else {
    driver = {
      text: "NO NEWS FEED", sentiment: "neu", source: "", sources: [], url: "", why: "",
      confidence: "", epoch: 0, origin: "none" as const, supersededBy: null, aiHeld: false, noData: true
    };
  }

  // ── TOP STORY 이력 ────────────────────────────────────
  //  스토리가 갈리면 직전 것은 흔적 없이 사라졌다. 중간에 들어온 시청자에겐
  //  "지금까지 무슨 일이 있었나"가 통째로 없는 셈이다 → 갈릴 때마다 쌓고 3건을 보여준다.
  //  (같은 사건을 문구만 바꿔 재생성한 경우는 새 항목으로 치지 않는다)
  recordStory(driver);
  const prevStories = previousStories(driver.text, 3);

  // driver 로 쓴 기사는 리스트에서 제외 (같은 문장이 화면에 두 번 나오던 문제).
  // ★ 트레이더 관점: 양보다 신호. level≥3(시장 관련) 또는 분류된 것만 남기고, 그게 너무 적으면
  //   전체로 백필한다. 각 항목엔 대표 주체(topic) 칩을 붙여 "무엇에 관한 것"을 먼저 스캔하게 한다.
  // ★ YouTube 송출 → 다수 시청자가 1920 프레임을 폰에서 4~5배 축소해 본다.
  //   그래서 '적게·크게·짧게'. 4건만, 각 행을 크게 뽑아 축소해도 읽히게 한다.
  // ★ id 비교만으로는 부족했다.
  //   AI 판단은 원문 기사와 id 가 다르므로 **항상 통과**했고, 그 결과 최상단 큰 글씨와
  //   바로 아래 첫 줄이 같은 사건을 말했다. 규칙기반일 때도 다른 매체가 쓴 같은 기사가
  //   그대로 남았다. → 실제로 화면에 나가는 **문장**으로 비교한다.
  const pool = ranked.filter(
    (n) => (!top || n.id !== top.id) && !isNearDuplicate(n.title, driver.text)
  );
  const signal = pool.filter((n) => n.matched || n.level >= 3);

  // ── TODAY 브리핑 (오늘의 핵심 이벤트+영향, Claude 생성) ──
  // 있으면 좌측 컬럼 공간을 나눠 쓰므로 헤드라인을 3건으로 줄인다. LIVE 판정은 클라이언트가 시각으로.
  const briefItem = fresh(feed, "market_brief");
  const brief = briefItem?.payload.items ?? null;

  // 우측의 중복 EARNINGS 패널을 지우면서 헤드라인에 쓸 세로 공간이 늘었다.
  // 전쟁·지정학 국면에선 관련 기사가 쏟아지므로 더 많이 보여주는 편이 낫다.
  //
  // ★ 단, **빈자리를 잡기사로 채우지 않는다.**
  //   예전엔 `signal.length >= N ? signal : pool` 이라, 관련 기사가 N개에 못 미치면
  //   필터를 통째로 풀어 버렸다. 그래서 자리를 늘리자마자 꿀벌 농부·IMAX 상영이
  //   다시 목록에 올라왔다 — TOP STORY 에서 걸러낸 바로 그 기사들이다.
  //   관련 기사가 3건뿐이면 3건만 보여준다. 채우는 것보다 안 틀리는 게 낫다.
  //   (signal 이 아예 비었을 때만 최후로 pool 을 쓴다 — 화면이 통째로 비는 건 막는다)
  const list = (signal.length ? signal : pool)
    // ★ 좌측 컬럼은 1080p 고정이라 자리가 유한하다. TODAY 브리핑이 뜨면 패널이 하나 늘어
    //   전체가 넘치고 **아래 패널이 화면 밖으로 잘렸다**(실측 199px 초과).
    //   잘린 패널은 없는 것만 못하다 → 브리핑이 있을 땐 헤드라인을 줄여 자리를 낸다.
    .slice(0, brief && brief.length ? 4 : 7)
    .map((n) => ({ ...n, topic: newsTopic(n.title, n.ticker), short: shortHeadline(n.title) }));

  // ── 지배 주제 집계 ────────────────────────────────────
  //  TOP STORY 를 포함한 상위 관련 기사 전체를 본다 (드라이버는 목록에 남은 것만의 문제가 아니다).
  //  가중치 = 중요도(별) × 신선도. 24시간 지난 기사도 0 이 되진 않게 바닥을 둔다 —
  //  전쟁처럼 며칠 이어지는 국면에서 어제 기사라고 무게가 사라지면 안 된다.
  const themePool = (top ? [top, ...pool] : pool).filter((n) => n.matched || n.level >= 3).slice(0, 14);
  const weights = new Map<string, { w: number; n: number; level: number; titles: string[] }>();
  for (const n of themePool) {
    const ageH = Math.max(0, (nowSec - n.epoch) / 3600);
    const w = n.level * Math.max(0.35, 1 - ageH / 24);
    // 한 기사가 여러 주제에 걸리면 전부 센다 (newsThemes 주석 참고).
    // "…China pushing for end US-Iran war" 는 원유 기사이면서 전쟁 기사다.
    for (const key of newsThemes(n.title, n.ticker)) {
      if (key === "MKT") continue;           // 미분류는 주제가 아니다
      const cur = weights.get(key) ?? { w: 0, n: 0, level: 0, titles: [] };
      cur.w += w; cur.n += 1; cur.level = Math.max(cur.level, n.level);
      cur.titles.push(n.title);
      weights.set(key, cur);
    }
  }
  const totalW = [...weights.values()].reduce((s, v) => s + v.w, 0);
  const best = [...weights.entries()].sort((a, b) => b[1].w - a[1].w)[0];

  // ★ 억지로 하나 고르지 않는다.
  //   주제가 흩어져 있으면(1위가 전체의 25% 미만) "지금 시장은 한 가지에 쏠려 있지 않다"가
  //   사실이다. 기사 1건짜리 주제를 드라이버라고 부르면 그건 드라이버가 아니라 그냥 기사다.
  const theme =
    best && best[1].n >= 2 && totalW > 0 && best[1].w / totalW >= 0.25
      ? {
          key: best[0],
          // "WAR" 만으론 어느 전쟁인지 모른다 → 지명이 잡히면 "IRAN WAR"
          label: [themeQualifier(best[1].titles, top?.title ?? ""), THEME_LABEL[best[0]] ?? best[0]]
            .filter(Boolean).join(" "),
          note: THEME_NOTE[best[0]] ?? "",
          count: best[1].n,
          total: themePool.length,
          share: Math.round((best[1].w / totalW) * 100),
          /** 이 주제 기사들의 최고 중요도 — "5★ 짜리 사건인가"를 한 글자로 전한다 */
          level: best[1].level
        }
      : null;

  return new Response(JSON.stringify({ driver, news: list, brief, prevStories, theme, serverNow: Math.floor(nowSec) }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
