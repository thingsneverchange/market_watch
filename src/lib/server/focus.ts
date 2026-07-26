import { getQuotes, getMarketNews, getEarnings, getMarketCaps, type Quote } from "./finnhub";
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
  const [news, earn, caps] = await Promise.all([
    getMarketNews(40),
    getEarnings(10, 4),
    getMarketCaps(UNIVERSE)
  ]);

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
    let hits = 0, attnRaw = 0;
    if (re) {
      for (const n of recent) {
        if (!re.test(n.title)) continue;
        hits++;
        attnRaw += Math.max(1, n.level);
      }
    }
    const attention = Math.min(1, attnRaw / 12);

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
    const score = base * sizeWeight(caps.get(t) ?? null);

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
      reason = `${hits} HEADLINE${hits === 1 ? "" : "S"}`;
    } else if (themeFace) {
      reason = `${THEME_WORD[themeKey] ?? themeKey} THEME`;
    } else if (catalyst > 0 && e) {
      const when = new Date(Date.now() + e.days * 864e5);
      reason = `EARNINGS ${DOW[when.getUTCDay()]}`;
    } else {
      reason = `${hits} HEADLINE${hits === 1 ? "" : "S"}`;
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
