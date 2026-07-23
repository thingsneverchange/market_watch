// ============================================================
//  Finnhub 공용 서버 유틸  (stock-gate .env 키 사용)
//  - 시세 / 기업뉴스 / 시장속보 / 실적캘린더
//  - 무료 티어 60 req/min 를 넘지 않도록 in-flight 병합 + 실패 격리 캐시
//
//  ※ 무료 티어에서 확인된 제약 (감사 실측):
//     · /stock/candle 은 403 (플랜 미포함) → 거래량·스파크라인 기능 자체를 제거했다
//     · /quote 는 확장시간(프리/애프터)에 갱신되지 않는다 → 전일 종가가 그대로 온다.
//       그래서 응답의 t(마지막 체결 시각)를 asOf 로 실어 보내 화면이 나이를 표시하게 한다.
// ============================================================
import { FINNHUB_API_KEY } from "$env/static/private";

const BASE = "https://finnhub.io/api/v1";

// ---- 워치리스트 (stock-gate 판정 종목 + 시장 대표주) --------
//   티커테이프 · 종목 속보 스캔 · 실적 캘린더 ★ 우대에 쓰인다.
export const WATCHLIST = ["ARM", "MRVL", "VICR", "TTMI", "COHR", "SNX"];
// ★ 주가지수 슬롯 = 신선도(dataAsOf) 앵커. 헤더 상단은 이 중 S&P/NASDAQ/DOW 만 쓰고,
//   IWM(러셀2000)은 하단 미니차트의 % 매칭용으로만 담는다(헤더엔 안 뜸).
//   개별 대형주(NVDA/AAPL/MSFT)는 아래 테이프, 크로스에셋(SOXX·BTC·GOLD·OIL)은 crossasset.ts.
export const INDEX_TICKERS = ["SPY", "QQQ", "DIA", "IWM"];
export const TAPE_TICKERS = [
  "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AMD",
  ...WATCHLIST
];

// ---- 캐시 ---------------------------------------------------
//  기존 구현의 두 가지 치명적 문제를 고친 것:
//   1) 실패 시 나이 제한 없이 옛 캐시를 무한 반환 → 몇 시간 전 값이 "신선한" 얼굴로 나갔다
//   2) in-flight 중복 미제거 → 같은 티커를 같은 tick 에 2~3번 발사 (쿼터 낭비)
const cache = new Map<string, { at: number; data: any }>();
const inflight = new Map<string, Promise<any>>();
const failUntil = new Map<string, number>();

const MAX_STALE_MS = 5 * 60_000; // 이보다 오래된 캐시는 반환하지 않는다 (null → 화면이 결측을 표시)

// 경로별 안정적 지터 (0..1). 같은 경로는 항상 같은 값이라 만료 시점이 경로마다 어긋난다.
//  → 17개 시세가 같은 tick 에 일제히 만료돼 Finnhub 로 ~24건 버스트를 쏘던 것을 분산한다.
//    (감사: 평균은 41.5/min 로 여유지만, 초당 동시성 상한을 건드리는 건 이 동기화된 버스트다)
function pathHash(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

// ※ TTL 은 반드시 폴링 주기(12s)보다 커야 한다. 작으면 캐시 히트율이 구조적으로 0 이다.
async function fhFetch(path: string, ttlMs = 15_000): Promise<any> {
  if (!FINNHUB_API_KEY) return null;
  const now = Date.now();
  const hit = cache.get(path);
  const stale = () => (hit && now - hit.at < MAX_STALE_MS ? hit.data : null);

  const jit = pathHash(path);                 // 0..1, 경로마다 고정
  const effTtl = ttlMs * (0.85 + jit * 0.3);  // ±15% 지터 → 만료 시점 분산
  if (hit && now - hit.at < effTtl) return hit.data;
  if ((failUntil.get(path) ?? 0) > now) return stale();

  const running = inflight.get(path);
  if (running) return running; // 동일 tick 중복 발사 제거

  const p = (async () => {
    try {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(`${BASE}${path}${sep}token=${FINNHUB_API_KEY}`, { cache: "no-store" });
      if (!r.ok) {
        // 403 = 플랜 제약(장기), 429 = 스로틀(전용 백오프, 경로별 45~90s 지터로 재동기화 방지),
        // 그 외 = 30s. 실패를 캐시하지 않으면 무한 재시도가 429 를 자가증폭한다.
        const backoff = r.status === 403 ? 3_600_000
          : r.status === 429 ? 45_000 + Math.floor(jit * 45_000)
          : 30_000;
        failUntil.set(path, now + backoff);
        console.warn(`[finnhub] ${r.status} ${path.split("?")[0]}`);
        return stale();
      }
      const j = await r.json();
      cache.set(path, { at: now, data: j });
      failUntil.delete(path);
      if (cache.size > 400) cache.delete(cache.keys().next().value as string);
      return j;
    } catch (e) {
      failUntil.set(path, now + 10_000);
      console.warn(`[finnhub] network fail ${path.split("?")[0]}`);
      return stale();
    } finally {
      inflight.delete(path); // finally 필수 — 없으면 영구 무한 TTL 이 된다
    }
  })();

  inflight.set(path, p);
  return p;
}

// ---- 시세 --------------------------------------------------
export type Quote = {
  ticker: string;
  price: number;
  changePct: number;
  change: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  asOf: number; // 소스가 준 마지막 체결 시각 (epoch ms). 0 = 알 수 없음
};

export async function getQuote(ticker: string): Promise<Quote | null> {
  // TTL 20s + 클라이언트 폴링 15s → 티커당 분당 2회. 17티커 = 34 req/min.
  // (예전엔 TTL 8s < 폴링 12s 라 캐시가 폴링 사이에 **구조적으로 절대 히트하지 않았다**)
  const j = await fhFetch(`/quote?symbol=${encodeURIComponent(ticker)}`, 20_000);
  if (!j || j.c == null || j.c === 0) {
    console.warn(`[finnhub] quote missing: ${ticker}`);
    return null;
  }

  // ※ 프리마켓 추론을 하지 않는다.
  //   무료 티어는 확장시간에 quote 를 갱신하지 않으므로, 예전 코드의
  //   "정규장이 아닌데 price !== prevClose 이면 프리마켓" 은 실제로는
  //   어제 정규장 등락률을 "프리마켓"으로 라벨링하는 것이었다 (pre.pct 와 pct 가 소수점 15자리까지 동일).
  return {
    ticker,
    price: Number(j.c),
    changePct: Number(j.dp ?? 0),
    change: Number(j.d ?? 0),
    high: Number(j.h ?? 0),
    low: Number(j.l ?? 0),
    open: Number(j.o ?? 0),
    prevClose: Number(j.pc ?? 0),
    asOf: Number.isFinite(Number(j.t)) && Number(j.t) > 0 ? Number(j.t) * 1000 : 0
  };
}

export async function getQuotes(tickers: string[]): Promise<Quote[]> {
  const out = await Promise.all(tickers.map((t) => getQuote(t)));
  return out.filter((q): q is Quote => q !== null);
}

// ============================================================
//  뉴스 분류기 v2
//
//  v1(키워드 정규식)의 실측 성능: 합성 적대 코퍼스에서 대형 시장사건 40건 중 38건(95%)을 놓쳤고,
//  시장과 무관한 헤드라인 18건은 18건 전부 level 5 ALERT 로 올렸다.
//
//  설계 원칙 (각 항목은 검증에서 깨진 대안을 회피하기 위한 것):
//   1) 순수 함수 — Date.now() 를 쓰지 않는다. 신선도 판단은 breaking 라우트가 한다.
//   2) 굴절형은 "일반 접미사 규칙"이 아니라 단어별 변화형 명시 열거.
//      blanket (s|es|ed|ing)? 는 recorded/beating/missing/rallying 오탐을 만들고,
//      일반 스테머는 loss→los, miss→mis, crisis→crisi 로 지금 잡히던 것을 잃는다.
//   3) 다의어(record/beat/miss/rally/cut/probe/deal/win)는 단독 토큰 금지, 반드시 구(phrase)로만.
//   4) war/crisis 는 삭제가 아니라 L4 로 강등. 시장 명사와 동시 출현할 때만 L5 로 승격.
//   5) 하이픈 결합어 방어: \b 는 recession-proof / tariff-free / Cold War 를 오탐한다 → 경계를 [\w-] 로.
//   6) sentiment 는 first-match if/else 가 아니라 카운트 비교. 부정어는 "중립화"이지 부호 반전이 아니다.
//   7) 어떤 규칙에도 안 걸리면 matched=false → "미분류"와 "진짜 중립"을 구분할 수 있다.
// ============================================================

/** 하이픈/언더스코어까지 포함한 단어 경계 */
const W = (body: string) => new RegExp(`(?<![\\w-])(?:${body})(?![\\w-])`, "i");

/** 단어별 변화형 — 일반 접미사 규칙을 쓰지 않는다 */
const F = {
  soar: "soar|soars|soared|soaring",
  plunge: "plunge|plunges|plunged|plunging",
  surge: "surge|surges|surged|surging",
  tumble: "tumble|tumbles|tumbled|tumbling",
  slump: "slump|slumps|slumped|slumping",
  rally: "rally|rallies|rallied", // rallying 은 "rallying cry" 오탐이라 제외
  crash: "crash|crashes|crashed",
  jump: "jump|jumps|jumped",
  spike: "spike|spikes|spiked",
  slide: "slide|slides|slid",
  sink: "sink|sinks|sank|sunk",
  gain: "gain|gains|gained",
  drop: "drop|drops|dropped",
  rise: "rise|rises|rose|risen",
  fall: "fall|falls|fell|fallen",
  climb: "climb|climbs|climbed",
  warn: "warn|warns|warned|warning|warnings",
  halt: "halt|halts|halted",
  collapse: "collapse|collapses|collapsed",
  seize: "seize|seizes|seized",
  recall: "recall|recalls|recalled",
  layoff: "layoff|layoffs|job cuts|cuts jobs|cut jobs",
  upgrade: "upgrade|upgrades|upgraded",
  downgrade: "downgrade|downgrades|downgraded",
  acquire: "acquire|acquires|acquired|acquisition|acquisitions|takeover|takeovers",
  bankrupt: "bankruptcy|bankruptcies|receivership",
  probe: "probe into|probes into|under investigation|investigation into",
  lawsuit: "lawsuit|lawsuits|sues|sued|indicted|charged with",
  tariff: "tariff|tariffs",
  sanction: "sanction|sanctions|sanctioned",
  recession: "recession|recessions",
  inflation: "inflation|deflation|stagflation",
  war: "war|wars|warfare|invasion|invades|invaded",
  crisis: "crisis|crises",
  blockade: "blockade|blockades|embargo|embargoes",
  default_: "default|defaults|defaulted|defaulting",
  disrupt: "disrupt|disrupts|disrupted|disruption|disruptions",
  threaten: "threaten|threatens|threatened|escalation|escalates|escalated"
};

/** 방향성 하락어 — 주가 움직임은 서술(narrative)보다 우선한다 */
const DOWN_MOVE = W([F.plunge, F.tumble, F.crash, F.slump, F.drop, F.fall, F.sink, F.slide].join("|"));

/* ---------- 시장 관련성 ---------- */
// 시장 명사. war/crisis 같은 상시 명사를 L5 로 올릴지 판단하는 데만 쓴다.
// 전면 AND 게이트로 쓰면 "US CPI rises 3.4%" 같은 진짜 거시 프린트가 탈락한다.
const MARKET = W(
  "stocks?|shares?|equit(?:y|ies)|nasdaq|s&p|dow|nyse|bonds?|yields?|treasur(?:y|ies)|" +
  "oil|crude|brent|gold|dollar|futures?|earnings|guidance|refining|markets?|index|indexes|investors?"
);

// 명백히 시장과 무관한 도메인 → level 2 상한.
// war / crisis 같은 상시 명사가 스포츠·문화·인도적 기사에서 걸리는 것을 막는다.
const NONMARKET = W(
  "world cup|olympics?|super bowl|box office|tennis|nba|nfl|mlb|concert|album|" +
  "reunion tour|humanitarian|refugees?|scholarship|county fair|marathon|" +
  "health crisis|famine|hunger|aid workers?|hospitals?|" +
  "museums?|documentary|memorial|anniversary|history"
);

/* ---------- 하드 L5: 이벤트형 ---------- */
// ※ W() 로 감싸야 "corporate cuts" 안의 "rate cuts" 같은 오탐이 막힌다.
const L5_HARD = W([
  "circuit breakers?", "trading halted", "halts? trading", "bank run",
  "emergency (?:rate|meeting|session)", "state of emergency",
  "rate[\\s-]?(?:cut|cuts|hike|hikes|reduction|increase)",
  "(?:cut|cuts|raise|raises|hike|hikes|lower|lowers)\\s+(?:interest\\s+)?rates?",
  "shut down by regulators", "seized by regulators",
  "files? for bankruptcy", "filed for bankruptcy", "declares? default"
].join("|"));

// 매크로 약어는 반드시 경계 필요. \b 없는 ppi 는 shipping/shopping 에 매치된다.
const MACRO = W("fomc|cpi|ppi|pce|nonfarm payrolls?|payrolls?|gdp|jobless claims|federal reserve");
// fed 는 "Fed Cup" / "Fed up" / "Federated" 오탐 방지
const FED = /(?<![\w-])fed(?![\w-])(?!\s+(?:cup|up))/i;

/* ---------- L4 ---------- */
const L4_MOVE = W([F.soar, F.plunge, F.surge, F.tumble, F.slump, F.rally, F.crash, F.spike].join("|"));
const L4_CORP = W([F.downgrade, F.upgrade, F.lawsuit, F.recall, F.bankrupt, F.layoff,
                   F.acquire, F.collapse, F.seize, F.probe].join("|"));
// 애널리스트 액션 — 실제 헤드라인은 "Raises Price Target" 형태라 upgrade/downgrade 로 안 잡혔다
const L4_ANALYST = /(?:raises?|lifts?|lowers?|cuts?|initiates?|reiterates?)\s+(?:its\s+)?(?:price target|pt|rating)/i;
// 실적은 "결과 발표" 형태만. 맨토큰 earnings 는 트랜스크립트/일정공지를 전부 끌어올린다.
// ※ 필러는 \w+ 가 아니라 [\w-]+ 여야 "beats second-quarter expectations" 가 잡힌다.
const L4_EARN = new RegExp([
  "(?:q[1-4]|quarter(?:ly)?|first|second|third|fourth|full[\\s-]?year)[\\s-]+(?:quarter\\s+)?(?:results|earnings)",
  "(?<![\\w-])(?:beats?|misses?|tops?|surpass(?:es|ed)?)\\s+(?:[\\w-]+\\s+){0,2}(?:estimates|expectations|forecasts|consensus)",
  "(?<![\\w-])(?:cuts?|raises?|lifts?|slashes?|lowers?)\\s+(?:its\\s+)?(?:full[\\s-]?year\\s+)?(?:guidance|outlook|forecast)"
].join("|"), "i");

// 경제/정책 명사 — 그 자체로 시장 이벤트다. 항상 L5.
const L5_POLICY = W([F.tariff, F.sanction, F.recession, F.inflation, F.default_].join("|"));
// 상시 지정학 명사 — 뉴스 피드에 늘 떠 있다. 시장 명사와 함께 나올 때만 L5 로 승격.
const L4_GEO = W([F.war, F.crisis, F.blockade].join("|"));

/* ---------- L3 ---------- */
const L3 = W([F.rise, F.fall, F.gain, F.drop, F.jump, F.slide, F.climb, F.sink,
              F.warn, F.halt, F.disrupt,
              "report|reports|reported|forecast|forecasts|profit|profits|loss|losses"].join("|"));

/* ---------- sentiment ---------- */
// record / win / settle 은 POS 에서 제거 — "record low", "record fine" 오탐
const POS_RE = [F.soar, F.surge, F.rally, F.gain, F.jump, F.rise, F.climb, F.upgrade,
  "profits?", "beats? (?:[\\w-]+\\s+){0,2}(?:estimates|expectations)", "tops? estimates",
  "approv(?:es|ed|al)", "raises? (?:its\\s+)?(?:guidance|outlook|forecast)",
  "record high", "all[\\s-]?time high", "strong (?:demand|results|guidance)"
].map(W);

const NEG_RE = [F.plunge, F.tumble, F.crash, F.slump, F.drop, F.fall, F.sink, F.slide,
  F.downgrade, F.lawsuit, F.recall, F.bankrupt, F.layoff, F.warn, F.collapse,
  F.blockade, F.sanction, F.default_, F.disrupt, F.threaten, F.war, F.tariff, F.recession,
  "shut down by regulators", "seized by regulators", "files? for bankruptcy",
  "misses? (?:[\\w-]+\\s+){0,2}(?:estimates|expectations)",
  "cuts? (?:its\\s+)?(?:guidance|outlook|forecast|dividend)",
  "record (?:low|lows|loss|losses|fine|deficit|outflow)",
  "weak (?:demand|guidance|results)"
].map(W);

// 비용성 명사가 오르면 부정
const COST_UP = /(?:costs?|prices?|premiums?|insurance|inflation|cpi|ppi|yields?|unemployment)\s+(?:rise|rises|rose|jump|jumps|jumped|soar|soars|soared|surge|surges|surged|climb|climbs|climbed)/i;
// 금리 인하는 주식에 강세 — 일반 'cut' 과 분리한다
const RATE_CUT = /rate[\s-]?cuts?|cuts?\s+(?:interest\s+)?rates?/i;
// 부정어는 "중립화"이지 부호 반전이 아니다 (반전하면 악재가 호재가 된다)
const NEGATION = /(?<![\w-])(?:no|not|fails? to|without|rules? out|denies|denied)(?![\w-])/i;

export type NewsScore = { level: number; sentiment: string; matched: boolean };

export function scoreNews(headline: string): NewsScore {
  const t = (headline || "").toLowerCase();
  let level = 2;
  let matched = false;

  /* ---- level ---- */
  const hasMacro = MACRO.test(t) || FED.test(t);
  // 매크로 약어는 시장 맥락이나 숫자와 함께 나올 때만 유효하다.
  // ("CPI Aerostructures names new board member" 가 L4 로 올라가던 문제)
  const macroReal = hasMacro && (MARKET.test(t) || /\d/.test(t));

  if (L5_HARD.test(t) || macroReal || L5_POLICY.test(t)) {
    level = 5; matched = true;
  } else if (L4_GEO.test(t)) {
    // 상시 지정학 명사는 기본 L4. 시장 명사와 함께 나올 때만 L5 로 승격.
    level = MARKET.test(t) ? 5 : 4; matched = true;
  } else if (L4_MOVE.test(t) || L4_CORP.test(t) || L4_ANALYST.test(t) || L4_EARN.test(t)) {
    level = 4; matched = true;
  } else if (L3.test(t)) {
    level = 3; matched = true;
  }

  // 스포츠·연예·인도적 기사는 어떤 키워드가 걸렸든 L2 상한.
  // ("Spain beat Argentina to win World Cup" 이 관세 발표보다 높은 등급을 받던 문제)
  if (NONMARKET.test(t)) level = Math.min(level, 2);

  /* ---- sentiment: first-match 가 아니라 카운트 비교 ---- */
  let p = POS_RE.filter((r) => r.test(t)).length;
  let n = NEG_RE.filter((r) => r.test(t)).length;
  // 주가 방향은 서술보다 우선한다 ("Apple stock falls after strong guidance" 는 악재다)
  if (DOWN_MOVE.test(t)) n++;
  if (COST_UP.test(t)) { p = 0; n++; }
  if (RATE_CUT.test(t)) { n = Math.max(0, n - 1); p++; }
  if (NEGATION.test(t)) { p = Math.min(p, 1); n = Math.min(n, 1); } // 반전이 아니라 감쇠
  const sentiment = p > n ? "pos" : n > p ? "neg" : "neu";

  return { level, sentiment, matched };
}

// ---- 뉴스 -------------------------------------------------
/**
 * 기사 시각 표기. epoch 이 없을 때 "NOW" 를 반환하던 예전 동작은
 * "정보 없음"을 "최강 신선도 주장"으로 바꿔치기하는 것이라 제거했다.
 * 오늘이 아니면 날짜를 같이 찍는다 (15시간 된 기사가 "05:55 PM"으로 오늘처럼 보이던 문제).
 */
function toET(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec < 946684800 || epochSec > Date.now() / 1000 + 86400) return "—";
  const d = new Date(epochSec * 1000);
  const f = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...o }).format(d);
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(x);
  const t = f({ hour: "2-digit", minute: "2-digit", hour12: true });
  return day(d) === day(new Date()) ? t : `${f({ month: "short", day: "numeric" })} ${t}`;
}

export type NewsItem = {
  id: string;
  title: string;
  source: string;
  url: string;
  timeET: string;
  epoch: number;
  level: number;
  sentiment: string;
  matched: boolean;
  ticker?: string;
};

// 헤드라인의 대표 주체를 짧은 칩으로 뽑는다. 트레이더는 문장이 아니라 "무엇에 관한 것"을 먼저 스캔한다.
// 종목 뉴스는 티커, 시장 뉴스는 매크로 토픽(FED/CPI/OIL…), 아무것도 안 걸리면 "MKT".
const TOPIC_RULES: [RegExp, string][] = [
  [/\b(fomc|federal reserve|\bfed\b|rate\s?(?:cut|hike)|interest rate)/i, "FED"],
  [/\b(cpi|ppi|pce|inflation|deflation)/i, "CPI"],
  [/\b(nonfarm|payrolls?|jobless|unemployment|jobs report)/i, "JOBS"],
  [/\b(gdp|recession|growth data)/i, "GDP"],
  [/\b(oil|crude|brent|wti|opec)\b/i, "OIL"],
  [/\bgold\b/i, "GOLD"],
  [/\b(bitcoin|ethereum|crypto|\bbtc\b|\beth\b)/i, "CRYPTO"],
  [/\b(dollar|yen|euro|forex|currency)\b/i, "FX"],
  // GEO 를 BONDS 보다 먼저 — "blood and treasure" 의 treasure 가 BONDS 로 오분류되던 문제.
  [/\b(war|invasion|missile|airstrike|airstrikes|geopolit\w*|conflict|hostilities)\b/i, "GEO"],
  [/\b(treasur(?:y|ies)|bond yields?|\bbonds?\b|10[- ]?year|30[- ]?year)\b/i, "BONDS"],
  [/\b(tariff|sanction|export ban|trade war)\b/i, "TRADE"],
  [/\b(chip|semiconductor|nvidia|tsmc|foundry)\b/i, "CHIPS"],
  [/\b(acquir\w*|merger|takeover|buyout|\bm&a\b)\b/i, "M&A"],
  [/\b(earnings|revenue|guidance|profit|results)\b/i, "EARNINGS"]
];
export function newsTopic(headline: string, ticker?: string): string {
  if (ticker) return ticker.toUpperCase();
  for (const [re, tag] of TOPIC_RULES) if (re.test(headline || "")) return tag;
  return "MKT";
}

function mapNews(n: any, ticker?: string): NewsItem {
  const s = scoreNews(n.headline);
  return {
    id: String(n.id ?? n.url ?? n.headline),
    title: n.headline ?? "",
    source: n.source ?? "",
    url: n.url ?? "",
    epoch: Number(n.datetime ?? 0),
    timeET: toET(Number(n.datetime ?? 0)),
    level: s.level,
    sentiment: s.sentiment,
    matched: s.matched,
    ...(ticker ? { ticker } : {})
  };
}

// 시장 전체 뉴스
export async function getMarketNews(limit = 20): Promise<NewsItem[]> {
  const j = await fhFetch(`/news?category=general`, 60_000);
  if (!Array.isArray(j)) return [];
  // ※ 예전 코드는 정렬 '전에' slice(0,60) 을 해서, 피드가 시간순이 아니면
  //   진짜 최신 기사가 60번째 밖에서 통째로 버려졌다. map → sort → slice 순서로 고침.
  return j.map((n) => mapNews(n)).sort((a, b) => b.epoch - a.epoch).slice(0, limit);
}

// 워치리스트 종목별 기업뉴스
export async function getCompanyNews(ticker: string, days = 2): Promise<NewsItem[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 864e5);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const j = await fhFetch(
    `/company-news?symbol=${encodeURIComponent(ticker)}&from=${fmt(from)}&to=${fmt(to)}`,
    60_000
  );
  if (!Array.isArray(j)) return [];
  return j.map((n) => mapNews(n, ticker)).sort((a, b) => b.epoch - a.epoch).slice(0, 10);
}

// ---- 실적 캘린더 -------------------------------------------
export type EarnItem = {
  ticker: string;
  date: string;
  hour: string;
  epsEst: number | null;
  /** 발표된 실제 EPS. null = 아직 집계 안 됨 (무료 소스는 발표 후 한동안 null) */
  epsActual: number | null;
  revEst: number | null;
  revActual: number | null;
};

/**
 * ※ Finnhub /calendar/earnings 는 1500행 하드캡 + 날짜 내림차순이라,
 *   한 번에 3주를 요청하면 "가장 가까운 2주가 통째로 잘려 나간다" (실측: minDate 가 요청 끝날짜 근처).
 *   그래서 5일 창으로 쪼개 병합한다. TTL 900s 라 순증 호출은 없다.
 */
export async function getEarnings(days = 21, lookbackDays = 0): Promise<EarnItem[]> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = Date.now();
  const windows: Promise<any>[] = [];
  // 과거 창(최근 발표 리캡용). 기본 0 = 미래만.
  for (let s = -lookbackDays; s < 0; s += 5) {
    const from = new Date(now + s * 864e5);
    const to = new Date(now + Math.min(s + 5, 0) * 864e5);
    windows.push(fhFetch(`/calendar/earnings?from=${fmt(from)}&to=${fmt(to)}`, 900_000));
  }
  for (let s = 0; s < days; s += 5) {
    const from = new Date(now + s * 864e5);
    const to = new Date(now + Math.min(s + 5, days) * 864e5);
    windows.push(fhFetch(`/calendar/earnings?from=${fmt(from)}&to=${fmt(to)}`, 900_000));
  }
  const parts = await Promise.all(windows);
  const seen = new Set<string>();
  const out: EarnItem[] = [];
  for (const j of parts) {
    const arr = j?.earningsCalendar;
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      const key = `${e.symbol}|${e.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const num = (v: any) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
      out.push({
        ticker: e.symbol,
        date: e.date,
        hour: e.hour ?? "",
        epsEst: num(e.epsEstimate),
        epsActual: num(e.epsActual),
        revEst: num(e.revenueEstimate),
        revActual: num(e.revenueActual)
      });
    }
  }
  return out;
}
