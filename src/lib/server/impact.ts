import { getQuotes, getMarketCaps, capsPending, type Quote } from "./finnhub";
import { marketState } from "../market-hours";

// ============================================================
//  "지금 시장을 흔드는 종목" — 판정 기준
//
//  ── 무엇을 재야 하나 ─────────────────────────────
//  등락률로 줄 세우면 틀린다. 실측 예:
//     GOOGL −6.0%  × 시총 $3,893B → **−$234B**
//     TSLA  −14.5% × 시총 $1,176B → −$170B      (등락률은 2배 이상 큰데 영향은 더 작다)
//     MMM   +9.8%  × 시총    $89B → +$9B        (등락률 상위인데 지수엔 사실상 무영향)
//  → **시가총액 × 등락률 = 지수에서 증발·증가한 달러**. 이게 "흔들었다"의 정의다.
//
//  ── 그런데 그것만으론 부족하다 ────────────────────
//  시장 전체가 −2% 인 날엔 대형주가 전부 −2% 라 impact 상위가 그냥 "시총 상위 목록"이 된다.
//  움직인 게 아니라 **끌려간** 것이다. 그래서 지수 대비 초과분을 같이 본다:
//     rel = 종목 등락률 − S&P(SPY) 등락률
//  rel 이 작으면 "시장 탓", 크면 "이 종목 탓". 후자만 방송할 값어치가 있다.
//
//  ── 거래량은 왜 안 쓰나 (쓰고 싶어도 못 쓴다) ──────
//  무료 티어에 거래량이 없다. /quote 응답에 volume 필드 자체가 없고,
//  /stock/candle 은 403 이다(실측). "거래량이 터졌다"는 이 플랜에서 측정 불가다.
//  없는 걸 추정해서 그럴듯한 숫자를 만들지 않는다 — 시총×등락률은 실측치만으로 계산된다.
//
//  ── 유니버스 ────────────────────────────────────
//  MAJORS 전체(100+)를 폴링하면 분당 60 제한을 넘는다(현재 이미 ~34 req/min 사용 중).
//  지수를 실제로 움직일 수 있는 대형주로 좁힌다. 시총 하위 종목은 아무리 튀어도
//  지수에 영향이 없으므로 애초에 후보가 아니다 — 좁히는 게 정확도를 해치지 않는다.
// ============================================================

/** 지수 가중치가 실제로 유의미한 종목 (S&P500 / NASDAQ100 상위권) */
export const HEAVYWEIGHTS = [
  // 메가캡
  "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "AVGO", "TSLA",
  // 반도체 — 이 방송이 가장 자주 다루는 섹터
  "AMD", "MU", "QCOM", "TXN", "INTC", "AMAT", "LRCX", "KLAC", "ARM", "MRVL", "TSM", "ASML", "SMCI",
  // 소프트웨어 / 플랫폼
  "NFLX", "ORCL", "CRM", "ADBE", "NOW", "PLTR", "UBER",
  // 금융
  "JPM", "BAC", "V", "MA", "GS",
  // 헬스케어
  "LLY", "UNH", "JNJ", "ABBV", "MRK",
  // 소비 / 에너지
  "WMT", "COST", "HD", "PG", "KO", "XOM", "CVX"
];

const BENCH = "SPY";

// ★ 요청 예산.
//   Finnhub 무료 = 60 req/min. 헤더 시세(/api/boards)가 이미 17티커 × 3회 = 34 req/min 을 쓴다.
//   여기 44종목을 헤더와 같은 20초 TTL 로 돌리면 +33 req/min → 합계 67 로 한도를 넘긴다.
//   이 패널이 재는 건 **당일 누적 변동**이지 초 단위 호가가 아니므로 2분대 지연이 문제되지 않는다.
//   150초 TTL → 티커당 분당 0.4회 ≈ 13 req/min. 합계 ~47 로 여유가 생긴다.
//   (캐시 키는 헤더와 공유하므로 겹치는 대형주는 헤더 주기로 계속 갱신된다 — 손해가 없다)
const QUOTE_TTL_MS = 150_000;

/** 지수 대비 초과 변동이 이보다 작으면 "시장에 끌려간 것"으로 본다 */
const MIN_REL_PP = 0.4;
/** 시총 변화액이 이보다 작으면 지수에 의미가 없다 */
const MIN_IMPACT_B = 8;

export type IndexMover = {
  ticker: string;
  price: number;
  /** 당일 등락률 (장 밖이면 직전 세션) */
  pct: number;
  /** 지수(SPY) 대비 초과 변동, %p. null = 벤치마크 시세를 못 받아 계산 불가 */
  rel: number | null;
  /** 시가총액 (십억 달러). null = 아직 못 받음 */
  capB: number | null;
  /** 시총 변화액 (십억 달러). = capB × pct/100 */
  impactB: number | null;
};

export type ImpactBoard = {
  movers: IndexMover[];
  /** 벤치마크 등락률 — 화면이 "무엇 대비"인지 말할 수 있어야 한다 */
  benchPct: number | null;
  /** 이 숫자가 실시간인가, 직전 세션인가 */
  live: boolean;
  /** 시총을 아직 못 받아 순위에서 빠진 종목 수 (콜드스타트 정직성) */
  pendingCaps: number;
};

/**
 * 지수를 실제로 움직인 종목, 영향액 순.
 *
 * ★ 정규장 밖에서는 이 숫자가 **직전 세션 종가 기준**이다.
 *   무료 티어는 확장시간에 quote 를 갱신하지 않는다. 그걸 "지금 움직이는 중"처럼
 *   보여주면 거짓말이므로 live=false 를 실어 보내고 화면이 그대로 표기한다.
 */
export async function getIndexMovers(limit = 5): Promise<ImpactBoard> {
  const tickers = [...HEAVYWEIGHTS, BENCH];

  // ★ 44개를 한 번에 발사하지 않는다.
  //   캐시가 빈 상태(재시작 직후)엔 이 한 번의 호출이 44 요청을 동시에 쏘는데,
  //   같은 순간 헤더(/api/boards)도 17개를 쏜다 → 순간 61건으로 분당 한도를 넘겨 429 가 난다.
  //   실측: 배포 직후 1분 안에 429 17건.
  //   그냥 로그가 지저분해지는 문제가 아니다 — fhFetch 의 429 백오프는 **경로별**이라
  //   내가 유발한 429 가 헤더가 쓰는 티커까지 45~90초 묶어 버린다(헤더가 멈춘다).
  //   작은 배치로 나눠 순간 동시성을 낮춘다. 캐시가 차면 어차피 전부 캐시 히트다.
  const quotes: Quote[] = [];
  const CHUNK = 8;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    quotes.push(...(await getQuotes(tickers.slice(i, i + CHUNK), QUOTE_TTL_MS)));
  }
  const caps = await getMarketCaps(HEAVYWEIGHTS);

  const by = new Map(quotes.map((q) => [q.ticker, q]));
  const bench = by.get(BENCH);
  const benchPct = bench ? bench.changePct : null;

  // ★ "아직 못 받은 것"과 "받았지만 쓸 수 없는 것"은 다르다.
  //   비USD 표기 종목(TSM=TWD, ASML=EUR)은 영구 제외지 로딩 중이 아니다.
  //   둘을 섞으면 화면이 영원히 "집계 중"이라고 말한다.
  const pendingCaps = capsPending(HEAVYWEIGHTS);
  const rows: IndexMover[] = [];
  for (const t of HEAVYWEIGHTS) {
    const q: Quote | undefined = by.get(t);
    if (!q) continue;
    const capB = caps.get(t) ?? null;
    if (capB == null) continue;                      // 시총 없이는 영향액을 못 잰다 → 순위에서 뺀다
    // ★ 벤치마크가 없을 때 조용히 raw 등락률을 rel 인 것처럼 쓰면 안 된다.
    //   그러면 "지수 대비 초과분" 필터가 사실상 꺼진 채로 화면엔 "vs S&P" 라고 적힌다.
    const rel = benchPct == null ? null : Math.round((q.changePct - benchPct) * 100) / 100;
    const impactB = Math.round((capB * q.changePct) / 100);
    rows.push({ ticker: t, price: q.price, pct: q.changePct, rel, capB, impactB });
  }

  const movers = rows
    .filter((r) => {
      if (Math.abs(r.impactB ?? 0) < MIN_IMPACT_B) return false;
      // "시장에 끌려간" 종목을 뺀다 — 지수랑 같이 움직인 건 이 종목의 사건이 아니다
      if (r.rel != null) return Math.abs(r.rel) >= MIN_REL_PP;
      // 벤치마크를 못 받았으면 그 판정을 못 한다 → 절대 변동으로 더 보수적으로 거른다
      return Math.abs(r.pct) >= 1.5;
    })
    .sort((a, b) => Math.abs(b.impactB ?? 0) - Math.abs(a.impactB ?? 0))
    .slice(0, limit);

  return { movers, benchPct, live: marketState().open, pendingCaps };
}
