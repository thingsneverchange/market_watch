// ============================================================
//  FMP (Financial Modeling Prep) 시세 — 헤더 스트립의 **주 소스**
//
//  왜 Yahoo 가 아니라 여기가 주력이 됐나:
//   · Yahoo v8 은 비공식이라 IP 단위 429 를 실제로 맞았다(실측). 한 번 걸리면 몇 시간 간다.
//   · FMP 는 키 기반이라 스로틀이 예측 가능하고, 무료 티어에서 **진짜 지수**를 준다.
//
//  ★ 무료 티어 실측 (2026-07 확인) — 되는 것만 쓴다:
//     ✓ ^GSPC(S&P 500) ^IXIC(나스닥 종합) ^DJI(다우) ^VIX
//     ✓ ESUSD(E-mini S&P 선물) GCUSD(금) SIUSD(은) BZUSD(브렌트유) BTCUSD ETHUSD
//     ✗ ^SPX ^NDX NQUSD YMUSD CLUSD SOXX (프리미엄) → 이건 Yahoo/Finnhub 로 폴백
//
//  이 덕분에 ETF 프록시(QQQ/SPY/DIA)가 아니라 **지수 원본**을 표시할 수 있게 됐다.
// ============================================================
import { env } from "$env/dynamic/private";

export type FmpQuote = {
  symbol: string;
  price: number;
  changePct: number;
  asOf: number; // 소스가 준 시각(ms)
};

// ★ FMP 무료는 **하루 250회**다 (실측: "Limit Reach"). 45초 TTL × 8심볼 = 하루 15,360회로
//   61배 초과해 쿼터가 즉시 말랐다. 이 소스는 이제 "장 밖 보조"로만 쓴다:
//   · TTL 10분 (장 밖 지표는 천천히 움직인다)
//   · 하루 호출 예산 하드캡 — 넘으면 아예 네트워크를 안 친다(호출부가 Finnhub 로 폴백)
const TTL_MS = 10 * 60_000;
const FAIL_MS = 5 * 60_000;
const REQ_TIMEOUT_MS = 4000;
const DAILY_BUDGET = Number(process.env.FMP_DAILY_BUDGET || 200); // 250 한도에 여유를 둔다

let spentDay = "";
let spent = 0;
function budgetLeft(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== spentDay) { spentDay = today; spent = 0; } // 날짜 바뀌면 리셋
  return Math.max(0, DAILY_BUDGET - spent);
}

const cache = new Map<string, { at: number; data: FmpQuote | null }>();
let failUntil = 0;
let inflight: Promise<Map<string, FmpQuote>> | null = null;

function key(): string {
  return String(env.FMP_API_KEY || "").trim();
}

/**
 * 여러 심볼을 **한 번의 요청**으로 가져온다 (쉼표 구분).
 * 심볼당 1회씩 때리면 무료 쿼터가 금방 마르므로 반드시 묶어서 부른다.
 */
async function fetchBatch(symbols: string[]): Promise<Map<string, FmpQuote>> {
  const out = new Map<string, FmpQuote>();
  const k = key();
  if (!k || symbols.length === 0) return out;

  // 예산을 넘는 심볼은 아예 요청하지 않는다
  const allowed = symbols.slice(0, budgetLeft());
  if (allowed.length === 0) {
    console.warn("[fmp] 일일 호출 예산 소진 — 이번 주기는 건너뜁니다");
    return out;
  }
  spent += allowed.length;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    // stable/quote 는 symbol 을 하나만 받는다 → 병렬로 부르되 동시 개수를 제한한다.
    const results = await Promise.all(
      allowed.map(async (s) => {
        try {
          const r = await fetch(
            `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(s)}&apikey=${k}`,
            { signal: ctl.signal, cache: "no-store" }
          );
          if (!r.ok) return null;
          const j: any = await r.json();
          // 한도 초과·프리미엄 제한은 배열이 아니라 {Error Message:...} 로 온다
          const q = Array.isArray(j) ? j[0] : null;
          if (!q || !Number.isFinite(Number(q.price))) return null;
          return {
            symbol: s,
            price: Number(q.price),
            changePct: Math.round(Number(q.changePercentage ?? 0) * 100) / 100,
            asOf: Number(q.timestamp) > 0 ? Number(q.timestamp) * 1000 : Date.now()
          } as FmpQuote;
        } catch {
          return null;
        }
      })
    );
    for (const q of results) if (q) out.set(q.symbol, q);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 시세 조회 (45초 캐시). 실패하면 빈 Map — 호출부가 다른 소스로 폴백한다.
 * 캐시가 있으면 백오프 중에도 마지막 값을 돌려준다 (옛 값임을 asOf 로 알 수 있다).
 */
export async function getFmpQuotes(symbols: string[]): Promise<Map<string, FmpQuote>> {
  const now = Date.now();
  const out = new Map<string, FmpQuote>();
  const miss: string[] = [];

  for (const s of symbols) {
    const hit = cache.get(s);
    if (hit && now - hit.at < TTL_MS) {
      if (hit.data) out.set(s, hit.data);
    } else {
      miss.push(s);
    }
  }
  if (miss.length === 0) return out;
  if (failUntil > now) {
    // 백오프 중 — 만료된 캐시라도 있으면 준다 (없는 것보다 낫다)
    for (const s of miss) {
      const hit = cache.get(s);
      if (hit?.data) out.set(s, hit.data);
    }
    return out;
  }
  if (inflight) {
    const running = await inflight;
    for (const [s, q] of running) if (symbols.includes(s)) out.set(s, q);
    return out;
  }

  inflight = (async () => {
    const fetched = await fetchBatch(miss);
    const t = Date.now();
    for (const s of miss) cache.set(s, { at: t, data: fetched.get(s) ?? null });
    if (fetched.size === 0 && miss.length > 0) failUntil = t + FAIL_MS;
    inflight = null;
    return fetched;
  })();

  const fetched = await inflight;
  for (const [s, q] of fetched) out.set(s, q);
  return out;
}
