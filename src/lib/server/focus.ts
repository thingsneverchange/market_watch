import { getQuotes, getMarketNews, getCompanyNews, getEarnings, getMarketCaps, type Quote } from "./finnhub";
import { getWireNews } from "./newswire";
import { marketState } from "../market-hours";

// ============================================================
//  "지금 시장이 보고 있는 종목" — 판정 기준
//
//  ── 처음에 잘못 잡았던 것 ─────────────────────────
//  첫 판은 **시가총액 × 등락률**(= 오늘 지수에서 증발한 달러)로 만들었다.
//  그건 "오늘 지수를 얼마나 움직였나"라는 **사후 측정**이다. 사람들이 찾는 건 그게 아니다.
//    · 실적 발표를 앞둔 GOOGL 은 **아직 안 움직였는데도** 그 주 시장의 중심이다.
//    · NVDA 는 AI 사이클 내내 시장의 주인공이었지, 특정 하루의 등락 때문이 아니었다.
//    · 메모리 사이클이 화두면 MU 가 주인공이다 — 등락률이 그날 1등이 아니어도.
//  즉 재야 하는 건 가격이 아니라 **관심의 소재**다: 지금 이야기되고 있는가,
//  곧 촉매가 있는가, 지금 주도 테마의 대표주인가.
//
//  ── 그래서 세 축으로 잰다 ─────────────────────────
//   1) ATTENTION — 최근 48시간 헤드라인에 몇 번, 얼마나 중요하게 등장했나
//      · 회사명/티커를 헤드라인에서 직접 매칭한다. 추가 API 요청이 0이다
//        (이미 받아 둔 뉴스 피드를 다시 읽을 뿐이다).
//   2) CATALYST  — 실적 발표가 임박했나 / 방금 냈나
//      · 이게 GOOGL 케이스다. 발표 전에는 가격에 아무 일도 안 일어나지만 전부 그걸 본다.
//   3) THEME     — 지금 시장을 지배하는 주제(MARKET DRIVER)의 대표주인가
//      · 주제가 CHIPS 면 NVDA·MU·AVGO 가, 유가면 XOM·CVX 가 그 주제의 얼굴이다.
//
//  가격 변동은 **네 번째**로만 쓴다 — 순위를 정하는 값이 아니라 확인용이다.
//
//  ── 못 하는 것 (정직하게) ────────────────────────
//   · 거래량: 무료 티어에 없다 (/quote 에 필드 없음, /stock/candle 403).
//   · 옵션 거래량·검색 트렌드: 소스 없음. "얼마나 회자되나"의 대용으로 뉴스만 쓴다.
//   · 한국 종목(하이닉스 등): Finnhub 커버리지 밖. 메모리 테마의 대표주는 MU 로 잡힌다.
// ============================================================

/** 지수를 실제로 움직일 수 있는 대형주 유니버스 */
export const UNIVERSE = [
  "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "AVGO", "TSLA",
  "AMD", "MU", "QCOM", "TXN", "INTC", "AMAT", "LRCX", "KLAC", "ARM", "MRVL", "TSM", "ASML", "SMCI",
  "NFLX", "ORCL", "CRM", "ADBE", "NOW", "PLTR", "UBER",
  "JPM", "BAC", "V", "MA", "GS",
  "LLY", "UNH", "JNJ", "ABBV", "MRK",
  "WMT", "COST", "HD", "PG", "KO", "XOM", "CVX",
  // 방산 — 지정학이 드라이버일 때 시장이 실제로 보는 이름이다
  "LMT", "RTX", "NOC"
];

/**
 * 헤드라인에서 회사를 찾기 위한 이름 패턴.
 *  티커만 찾으면 놓친다 — 기사는 "Nvidia" 라고 쓰지 "NVDA" 라고 쓰지 않는다.
 *  반대로 이름만 찾아도 놓친다 — 일부 기사는 티커로 쓴다. 둘 다 본다.
 */
const NAMES: Record<string, RegExp> = {
  NVDA: /\b(nvidia|nvda)\b/i,
  AAPL: /\b(apple|aapl)\b/i,
  MSFT: /\b(microsoft|msft)\b/i,
  AMZN: /\b(amazon|amzn)\b/i,
  GOOGL: /\b(google|alphabet|googl|goog)\b/i,
  META: /\b(meta platforms|facebook|instagram|\bmeta\b)\b/i,
  AVGO: /\b(broadcom|avgo)\b/i,
  TSLA: /\b(tesla|tsla)\b/i,
  AMD: /\b(\bamd\b|advanced micro)\b/i,
  MU: /\b(micron|\bmu\b)\b/i,
  QCOM: /\b(qualcomm|qcom)\b/i,
  TXN: /\b(texas instruments|\btxn\b)\b/i,
  INTC: /\b(intel|intc)\b/i,
  AMAT: /\b(applied materials|amat)\b/i,
  LRCX: /\b(lam research|lrcx)\b/i,
  KLAC: /\b(kla corp|klac)\b/i,
  ARM: /\b(arm holdings|\barm\b)\b/i,
  MRVL: /\b(marvell|mrvl)\b/i,
  TSM: /\b(tsmc|taiwan semi\w*|\btsm\b)\b/i,
  ASML: /\basml\b/i,
  SMCI: /\b(super ?micro|smci)\b/i,
  NFLX: /\b(netflix|nflx)\b/i,
  ORCL: /\b(oracle|orcl)\b/i,
  CRM: /\b(salesforce|\bcrm\b)\b/i,
  ADBE: /\b(adobe|adbe)\b/i,
  NOW: /\bservicenow\b/i,
  PLTR: /\b(palantir|pltr)\b/i,
  UBER: /\buber\b/i,
  JPM: /\b(jpmorgan|jp morgan|\bjpm\b)\b/i,
  BAC: /\b(bank of america|\bbac\b)\b/i,
  V: /\bvisa\b/i,
  MA: /\bmastercard\b/i,
  GS: /\b(goldman sachs|goldman)\b/i,
  LLY: /\b(eli lilly|\blilly\b|\blly\b)\b/i,
  UNH: /\b(unitedhealth|\bunh\b)\b/i,
  JNJ: /\b(johnson & johnson|\bjnj\b)\b/i,
  ABBV: /\b(abbvie|abbv)\b/i,
  MRK: /\b(merck|\bmrk\b)\b/i,
  WMT: /\b(walmart|\bwmt\b)\b/i,
  COST: /\b(costco|cost)\b/i,
  HD: /\bhome depot\b/i,
  PG: /\b(procter ?& ?gamble|\bp&g\b)\b/i,
  KO: /\b(coca[- ]?cola)\b/i,
  XOM: /\b(exxon\w*|\bxom\b)\b/i,
  CVX: /\b(chevron|\bcvx\b)\b/i,
  LMT: /\b(lockheed\w*|\blmt\b)\b/i,
  RTX: /\b(raytheon|rtx corp|\brtx\b)\b/i,
  NOC: /\b(northrop\w*|\bnoc\b)\b/i
};

/** 주제별 대표주 — 그 테마가 화두일 때 시장이 그 얼굴로 보는 종목 */
const THEME_FACES: Record<string, string[]> = {
  CHIPS: ["NVDA", "AMD", "MU", "AVGO", "TSM", "ARM", "MRVL", "INTC", "SMCI", "AMAT", "LRCX", "KLAC", "ASML"],
  OIL: ["XOM", "CVX"],
  GEO: ["LMT", "RTX", "NOC", "XOM", "CVX"],
  TRADE: ["AAPL", "NVDA", "TSLA", "TSM"],
  FED: ["JPM", "BAC", "GS"],
  BONDS: ["JPM", "BAC", "GS"],
  CPI: ["WMT", "COST", "PG", "KO"],
  JOBS: ["JPM", "BAC"],
  CRYPTO: ["PLTR"],
  FX: ["AAPL", "MSFT"],
  GDP: ["WMT", "HD", "COST"]
};

/** 화면 표기용 주제 이름 — 내부 키(GEO)를 그대로 찍으면 "GEO THEME" 이라 안 읽힌다 */
const THEME_WORD: Record<string, string> = {
  GEO: "WAR", CHIPS: "CHIPS", OIL: "OIL", FED: "FED", CPI: "INFLATION",
  JOBS: "JOBS", GDP: "GROWTH", BONDS: "YIELDS", TRADE: "TARIFFS",
  CRYPTO: "CRYPTO", FX: "DOLLAR"
};

const BENCH = "SPY";
// 관심도만 갱신되면 되므로 2분대 지연이 문제되지 않는다.
const QUOTE_TTL_MS = 150_000;
const NEWS_WINDOW_H = 48;
/** 종목 뉴스 캐시 — 관심도는 분 단위로 안 바뀌므로 길게 잡아 예산을 아낀다 */
const NEWS_CACHE_MS = 15 * 60_000;
const newsCache = new Map<string, { at: number; items: { title: string; epoch: number; level: number }[] }>();

/**
 * 규모 가중 — **같은 사건도 회사 크기에 따라 시장 사건이 되기도, 아니기도 한다.**
 *  NVDA 실적은 지수 전체의 이벤트지만 KO 실적은 KO 의 이벤트다.
 *  이걸 빼놓았더니 첫 결과가 "KLAC · V · KO"(실적이 가장 가까울 뿐인 이름들)로 나왔다.
 *  ※ 여기서 시총은 **영향액을 계산하려는 게 아니라** 티어를 가르는 용도다.
 *    (통화 문제로 USD 표기가 아닌 종목은 캡이 null 이라 중립 가중 1 이 적용된다)
 */
function sizeWeight(capB: number | null): number {
  if (capB == null) return 0.8;       // 모르면 중립 — 모른다는 이유로 벌주지 않는다
  if (capB >= 1500) return 1;         // $1.5T+ 메가캡
  if (capB >= 500) return 0.9;
  if (capB >= 200) return 0.75;
  if (capB >= 80) return 0.6;
  return 0.45;
}

/**
 * 섹터 가중 — **이 시장을 실제로 끌고 가는 게 무엇인가**.
 *
 * 시가총액만으로는 부족했다. 실측 사고: MARKET FOCUS 에 **V(비자)** 가 올라갔다.
 *   비자는 시총이 크고 그 주에 실적이 있었지만, 비자 실적으로 나스닥이 움직이지 않는다.
 *   반면 반도체 한 종목의 가이던스가 지수 전체를 흔든다.
 *
 * 이건 취향이 아니라 **지수 집중도**다. 메가캡 테크 8종목이 S&P500 의 3분의 1이고,
 * 나스닥100 에선 더 크다. 반도체는 지금 시장 서사(AI 설비투자) 자체를 들고 있다.
 * 반대로 필수소비재는 시총이 커도 지수를 못 움직인다.
 *
 * ※ 에너지·방산이 낮게 잡혀 있는 건 평상시 기준이다. 지정학이 드라이버가 되면
 *   테마 가점(THEME_FACES)이 그때 올려 준다 — 국면에 따라 자동으로 바뀐다.
 */
const SECTOR: Record<string, number> = {
  // 반도체 — 지금 시장 서사를 들고 있는 섹터
  NVDA: 1, AMD: 1, AVGO: 1, MU: 1, TSM: 1, ARM: 1, MRVL: 1, INTC: 1,
  QCOM: 0.9, TXN: 0.85, AMAT: 0.9, LRCX: 0.9, KLAC: 0.9, ASML: 0.95, SMCI: 0.85,
  // 메가캡 테크 — 지수 그 자체
  AAPL: 1, MSFT: 1, GOOGL: 1, AMZN: 1, META: 1, TSLA: 1,
  // 소프트웨어 · 플랫폼
  NFLX: 0.85, ORCL: 0.85, CRM: 0.8, ADBE: 0.8, NOW: 0.75, PLTR: 0.8, UBER: 0.7,
  // 금융 — 거시 신호는 되지만 지수를 끌지는 않는다
  JPM: 0.65, BAC: 0.55, GS: 0.6, V: 0.5, MA: 0.5,
  // 헬스케어
  LLY: 0.6, UNH: 0.55, JNJ: 0.45, ABBV: 0.45, MRK: 0.45,
  // 필수소비재 — 시총은 커도 지수를 못 움직인다
  WMT: 0.5, COST: 0.5, HD: 0.5, PG: 0.35, KO: 0.35,
  // 에너지 · 방산 — 평상시엔 낮게. 지정학 국면이면 테마 가점이 올려 준다
  XOM: 0.6, CVX: 0.55, LMT: 0.45, RTX: 0.45, NOC: 0.4
};
const sectorWeight = (t: string) => SECTOR[t] ?? 0.6;

export type FocusName = {
  ticker: string;
  score: number;
  /** 왜 지금 이 종목이 화면에 있나 — 가장 큰 기여 요인 */
  reason: string;
  /** 최근 48시간 헤드라인 등장 횟수 */
  hits: number;
  /** 실적까지 남은 일수 (음수 = 이미 발표). null = 창 안에 없음 */
  earnDays: number | null;
  /** 실적 발표 시각대 (bmo/amc) */
  earnHour: string;
  /** 지금 주도 테마의 대표주인가 */
  themeFace: boolean;
  pct: number | null;
  /** 지수(SPY) 대비 초과 변동, %p. null = 벤치마크 없음 */
  rel: number | null;
};

export type FocusBoard = {
  names: FocusName[];
  benchPct: number | null;
  /** 이 등락률이 실시간인가, 직전 세션인가 */
  live: boolean;
};

function dayDiff(dateStr: string): number {
  const t = Date.parse(`${dateStr}T12:00:00Z`);
  if (!Number.isFinite(t)) return NaN;
  return Math.round((t - Date.now()) / 864e5);
}

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * 지금 시장의 관심이 몰려 있는 종목.
 *
 * @param themeKey 현재 MARKET DRIVER 의 주제 키 (없으면 테마 가점 없음)
 */
export async function getMarketFocus(themeKey = "", limit = 5): Promise<FocusBoard> {
  // ★ 순위는 **시세 없이** 정해진다.
  //   가격은 이 패널의 기준이 아니다(재는 건 관심의 소재다) → 점수 계산에 안 쓴다.
  //   그러면 46종목 시세를 받을 이유가 없다. 점수를 먼저 매기고 **상위 5개만** 받는다.
  //   요청이 46 → 6 으로 줄어 헤더 시세의 예산을 사실상 건드리지 않는다.
  //   (앞선 판은 46개를 저우선으로 훑었는데, 헤더가 34 req/min 을 쓰는 탓에 남는 예산이
  //    분당 4건뿐이라 목록이 다 차는 데 11분이 걸렸다 — 실측 pendingCaps 45.)
  //
  //   뉴스·실적은 다른 패널이 이미 쓰는 캐시를 그대로 재사용한다 (추가 요청 사실상 0).
  //   실적은 앞으로 10일 + 지난 4일 — "곧 낸다"와 "방금 냈다" 둘 다 관심의 근거다.
  //   시총은 24시간 캐시 + 저우선이라 사실상 공짜다(호출당 6개씩 채워 8분이면 다 찬다).
  const [fhNews, wire, earn, caps] = await Promise.all([
    getMarketNews(40),
    getWireNews(40),
    getEarnings(10, 4),
    getMarketCaps(UNIVERSE)
  ]);
  // ★ 실시간 와이어를 ATTENTION 재료에 합친다.
  //   아래 주석의 "general 피드엔 회사 이름이 거의 안 나온다"가 여기서도 문제였는데,
  //   와이어는 CNBC Tech·구글뉴스(반도체) 를 포함해 **회사 이름이 실제로 등장하는**
  //   기사가 많다. 실측: 반도체 질의 100건 중 상위가 ASML·CXMT·Intel·Micron.
  //   요청 순증은 0 이다 — digest·breaking 이 이미 데워 둔 같은 캐시를 읽는다.
  const news = [...wire, ...fhNews];

  // ★★ ATTENTION 축이 **계속 0 이었다.**
  //   general 피드는 매크로·지정학 위주라 회사 이름이 거의 안 나온다.
  //   실측: 이란 국면 내내 헤드라인 4~6건에 회사명 0건 → 순위가 사실상 실적 일정표였다.
  //   그런데 Finnhub 는 **종목별 뉴스를 따로 준다**. 그게 더 신선하기까지 하다:
  //     general 최신 256분 전  vs  NVDA 117분 · MSFT 72분 · GOOGL 136분 (실측)
  //   안 쓰고 있었을 뿐이다.
  //
  //   요청 비용: 후보 종목만, 캐시 15분, 저우선. 분당 1건 미만이라 헤더 예산에 영향이 없다.
  //   전 종목(46개)을 훑지 않는다 — 그건 예산을 먹고, 어차피 순위에 못 드는 종목이다.
  const NEWS_PROBE = [
    // 지수를 끄는 이름들 — 여기 뉴스가 붙으면 그게 곧 시장 이야기다
    "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "AMD", "MU",
    // 지금 테마의 얼굴들도 같이 본다 (국면에 따라 달라진다)
    ...(THEME_FACES[themeKey] ?? []).slice(0, 4)
  ];
  const probe = [...new Set(NEWS_PROBE)].filter((t) => UNIVERSE.includes(t)).slice(0, 12);

  // ★ 12건을 한 번에 쏘면 저우선 쿼터(분당 16)를 시총 캐시·시세와 나눠 쓰다가 전부 건너뛰어진다.
  //   실측: 저우선으로 바꾸자마자 hits 가 10 → 0 이 됐다.
  //   getMarketCaps 와 같은 방식으로 **호출마다 조금씩** 채운다. 15분 캐시라 한 번 차면
  //   그 뒤로는 요청이 거의 없다 (종목당 분당 0.07건).
  const now = Date.now();
  const cutoffAt = now - NEWS_CACHE_MS;
  const todo = probe.filter((t) => (newsCache.get(t)?.at ?? 0) < cutoffAt).slice(0, 4);
  await Promise.all(todo.map(async (t) => {
    try {
      // ★ 저우선으로 두지 않는다. 실측: lowPriority 로 바꾼 순간 hits 가 10 → 0 이 됐다.
      //   저우선 쿼터(분당 16)를 시총 캐시(호출당 6)가 먼저 먹어 매번 건너뛰어졌다.
      //   종목 뉴스는 15분 캐시라 정상 주기에서 **종목당 분당 0.07건**이다 —
      //   헤더 예산을 위협할 규모가 아닌데 우선순위 때문에 기능이 통째로 죽고 있었다.
      //   버스트는 우선순위가 아니라 위의 drip(호출당 4건)으로 막는다.
      const items = await getCompanyNews(t, 2, 60, NEWS_CACHE_MS);
      // ★ 빈 결과를 15분 캐시하면 안 된다. 예산으로 **건너뛴** 것과 "뉴스가 없다"는
      //   전혀 다른 사실인데 구분이 안 된다. 실측: META·TSLA·AVGO·AMD·MU 가 전부
      //   `0` 으로 굳어 관심도가 영원히 0 이었다 (FRED 시총 캐시에서 겪은 것과 같은 실수).
      //   → 빈 결과는 짧게만 기억해서 곧 다시 시도한다.
      newsCache.set(t, { at: items.length ? Date.now() : Date.now() - NEWS_CACHE_MS + 60_000, items });
    } catch { /* 실패해도 나머지로 간다 */ }
  }));
  const companyNews = new Map(
    probe.map((t) => [t, newsCache.get(t)?.items ?? []] as const)
  );

  const cutoff = Date.now() / 1000 - NEWS_WINDOW_H * 3600;
  const recent = news.filter((n) => n.epoch >= cutoff);

  // 실적 일정 색인 (가장 가까운 것 하나)
  const earnBy = new Map<string, { days: number; hour: string }>();
  for (const e of earn) {
    const d = dayDiff(e.date);
    if (!Number.isFinite(d)) continue;
    const cur = earnBy.get(e.ticker);
    if (!cur || Math.abs(d) < Math.abs(cur.days)) earnBy.set(e.ticker, { days: d, hour: e.hour });
  }

  const faces = new Set(THEME_FACES[themeKey] ?? []);

  const rows: FocusName[] = [];
  for (const t of UNIVERSE) {
    const re = NAMES[t];

    // ── 1) 관심도: 헤드라인 등장. 중요도(별)로 가중한다.
    //   (a) 시장 전체 뉴스에 이름이 나왔나 — 나왔다면 그건 곧 시장 이야기다(가중 2배)
    //   (b) 그 종목 자체의 뉴스가 얼마나 쏟아지나 — "지금 회자되는 정도"
    //   두 축을 **따로 센다.** 성격이 다르다:
    //    marketHits — 시장 전체 뉴스가 이 회사를 말했다 → 그건 곧 시장 이야기다
    //    flow       — 그 종목에 기사가 얼마나 쏟아지나 → "지금 회자되는 정도"
    let marketHits = 0, flow = 0, attnRaw = 0;
    if (re) {
      for (const n of recent) {
        if (!re.test(n.title)) continue;
        marketHits++;
        attnRaw += Math.max(1, n.level) * 3;   // 시장면에 오른 건 무게가 다르다
      }
    }
    for (const n of companyNews.get(t) ?? []) {
      if (n.epoch < cutoff) continue;
      flow++;
      attnRaw += Math.max(1, n.level) * 0.15;  // 물량은 참고치 — 한 건이 사건은 아니다
    }
    const hits = marketHits + flow;
    const attention = Math.min(1, attnRaw / 24);

    // ── 2) 촉매: 실적. 발표 전이 핵심이다 (GOOGL 케이스).
    const e = earnBy.get(t) ?? null;
    let catalyst = 0;
    if (e) {
      const d = e.days;
      if (d >= 0 && d <= 2) catalyst = 1;           // 임박 — 시장이 여기에 쏠린다
      else if (d > 2 && d <= 7) catalyst = 0.6;     // 이번 주
      else if (d < 0 && d >= -3) catalyst = 0.75;   // 방금 냈다 — 반응이 진행 중
    }

    // ── 3) 테마: 지금 주도 주제의 대표주인가
    const themeFace = faces.has(t);

    // ★ 가격은 점수에 들어가지 않는다.
    //   "그냥 오늘 많이 빠진 종목"은 이 패널이 답하려는 질문이 아니다.
    //   관심(뉴스)·촉매(실적)·테마 중 하나는 반드시 있어야 목록에 든다.
    if (attention === 0 && catalyst === 0 && !themeFace) continue;
    const base = 0.40 * attention + 0.35 * catalyst + 0.25 * (themeFace ? 1 : 0);
    // 규모(시총) × 섹터(지수를 끄는 힘). 둘 다 곱해야 "V 가 왜 여기 있나"가 안 생긴다.
    const score = base * sizeWeight(caps.get(t) ?? null) * sectorWeight(t);

    // 왜 화면에 있는지 한 마디 — 기여가 가장 큰 축을 그대로 말한다
    let reason: string;
    if (catalyst >= 0.75 && e) {
      if (e.days < 0) reason = `REPORTED ${e.days === -1 ? "1D" : `${-e.days}D`} AGO`;
      else if (e.days === 0) reason = e.hour === "amc" ? "EARNINGS TODAY · AMC" : "EARNINGS TODAY";
      else {
        const when = new Date(Date.now() + e.days * 864e5);
        reason = `EARNINGS ${DOW[when.getUTCDay()]}`;
      }
    } else if (attention >= 0.35) {
      // ★ "60 HEADLINES" 는 방송에서 뜻이 안 통한다(종목 뉴스 물량의 상한값일 뿐).
      //   시장면에 오른 건 그 자체가 사건이므로 그걸 우선 말한다.
      reason = marketHits > 0
        ? `IN MARKET NEWS ×${marketHits}`
        : "HEAVY NEWS FLOW";
    } else if (themeFace) {
      reason = `${THEME_WORD[themeKey] ?? themeKey} THEME`;
    } else if (catalyst > 0 && e) {
      const when = new Date(Date.now() + e.days * 864e5);
      reason = `EARNINGS ${DOW[when.getUTCDay()]}`;
    } else {
      reason = marketHits > 0 ? `IN MARKET NEWS ×${marketHits}` : "HEAVY NEWS FLOW";
    }

    rows.push({
      ticker: t, score: Math.round(score * 1000) / 1000, reason, hits,
      earnDays: e ? e.days : null, earnHour: e?.hour ?? "",
      themeFace, pct: null, rel: null
    });
  }

  const names = rows.sort((a, b) => b.score - a.score).slice(0, limit);

  // ── 여기서야 시세를 받는다: 뽑힌 5개 + 벤치마크뿐 ──
  //  가격은 순위가 아니라 **확인용**이다. 순위가 정해진 뒤에 붙인다.
  //  저우선으로 요청해 예산이 빠듯하면 헤더 시세가 먼저 살아남게 한다
  //  (없으면 pct=null → 화면은 "—" 를 찍는다. 없는 값을 지어내지 않는다).
  const quotes: Quote[] = names.length
    ? await getQuotes([...names.map((n) => n.ticker), BENCH], QUOTE_TTL_MS, true)
    : [];
  const by = new Map(quotes.map((q) => [q.ticker, q]));
  const benchPct = by.get(BENCH)?.changePct ?? null;
  for (const n of names) {
    const q = by.get(n.ticker);
    n.pct = q ? q.changePct : null;
    n.rel = n.pct == null || benchPct == null ? null : Math.round((n.pct - benchPct) * 100) / 100;
  }

  return { names, benchPct, live: marketState().open };
}
