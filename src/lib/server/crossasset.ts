// ============================================================
//  크로스에셋 시세 (반도체 ETF · 비트코인 · 금 · 원유)
//
//  왜 Finnhub 가 아니라 Yahoo 인가:
//   · Finnhub 무료 /quote 는 확장시간·주말에 갱신되지 않는다(전일 종가 고정).
//     그런데 이 화면은 장 밖·밤에도 방송된다 → BTC(24시간)·금/원유 선물(≈23시간)이
//     "고정된 숫자"로 죽어 있으면 크로스에셋을 넣는 의미가 없다.
//   · Yahoo v8 chart(includePrePost) 는 실제 체결 포인트를 주므로 이 자산들이 밤에도 살아 움직인다.
//
//  표시값 = "전일 종가 대비 오늘 등락"(net change). 지수·ETF·크립토·선물 모두 동일 규칙이라
//  자산군별 세션 분기가 필요 없다 (livequote.ts 의 '실적 후 반응 %' 와는 목적이 다르다).
//
//  Yahoo 는 비공식 엔드포인트라 실패가 흔하다 → 실패 시 해당 심볼만 null,
//  화면은 "—" 로 결측을 정직하게 드러낸다 (옛 값을 새 값인 척 내보내지 않는다).
// ============================================================

export type AssetClass = "index" | "equity" | "crypto" | "commodity";

export type CrossAsset = {
  key: string;   // 화면 라벨 (예: "BTC")
  yahoo: string; // Yahoo 심볼
  tv: string;    // TradingView 미니차트 심볼
  cls: AssetClass;
};

// ★ 하나의 단일 소스. 헤더 스트립·미니차트·테이프가 전부 이 목록을 참조한다.
export const CROSS_ASSETS: CrossAsset[] = [
  { key: "SOXX", yahoo: "SOXX",    tv: "NASDAQ:SOXX",     cls: "equity" },     // 반도체 ETF (워치리스트가 전부 반도체계열이라 대표성 높음)
  { key: "BTC",  yahoo: "BTC-USD", tv: "BITSTAMP:BTCUSD", cls: "crypto" },     // 24시간 — 밤에도 유일하게 살아있는 리스크 지표
  { key: "GOLD", yahoo: "GC=F",    tv: "TVC:GOLD",        cls: "commodity" },  // 안전자산
  { key: "OIL",  yahoo: "CL=F",    tv: "TVC:USOIL",       cls: "commodity" }   // WTI 원유 (매크로)
];

/**
 * ★ 지수 **선물** — 정규장이 닫혀 있을 때 시장을 대표하는 숫자.
 *   현물 ETF(QQQ/SPY/DIA)는 장 밖에 전일 종가로 얼어붙지만, 선물은 거의 24시간 돌아간다
 *   (일요일 18:00 ET ~ 금요일 17:00 ET). 지정학 이슈처럼 주말에 터지는 사건이
 *   월요일 개장 전에 어디로 향하는지는 오직 선물이 말해 준다.
 *   Yahoo 의 `=F` 연속물 심볼은 GC=F/CL=F 로 이미 검증된 방식이다.
 */
export const INDEX_FUTURES: CrossAsset[] = [
  { key: "S&P FUT",    yahoo: "ES=F", tv: "CME_MINI:ES1!", cls: "index" },
  { key: "NASDAQ FUT", yahoo: "NQ=F", tv: "CME_MINI:NQ1!", cls: "index" },
  { key: "DOW FUT",    yahoo: "YM=F", tv: "CBOT_MINI:YM1!", cls: "index" }
];

export type CrossQuote = {
  key: string;
  price: number;
  changePct: number;
  asOf: number; // 마지막 체결 시각(ms)
};

// TTL 은 헤더 글랜스용이라 실적 반응(20s)만큼 촘촘할 필요가 없다.
// 45s → 4심볼 기준 분당 최대 ~5회, 시간당 ~320회 (단일 서버 IP). Yahoo 스로틀 여유 안쪽.
const TTL_MS = 45_000;
const FAIL_MS = 90_000; // 실패한 심볼은 90초 쉬어 429 자가증폭을 막는다
const RATE_LIMIT_MS = 10 * 60_000; // 429 = IP 단위 스로틀 → 전 심볼 정지
const REQ_TIMEOUT_MS = 3500;

/** 429 를 만나면 이 시각까지 모든 크로스에셋 요청을 멈춘다 */
let globalRateLimitUntil = 0;

// Yahoo 비공식 엔드포인트용 헤더 (livequote.ts 와 동일 취지 — 현실적인 브라우저 헤더).
const YF_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://finance.yahoo.com/"
};

const cache = new Map<string, { at: number; data: CrossQuote | null }>();
const failUntil = new Map<string, number>();
const inflight = new Map<string, Promise<CrossQuote | null>>();

async function fetchOne(a: CrossAsset): Promise<CrossQuote | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(a.yahoo)}` +
    `?interval=1m&range=1d&includePrePost=true`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: YF_HEADERS, signal: ctl.signal, cache: "no-store" });
    if (r.status === 429) {
      globalRateLimitUntil = Date.now() + RATE_LIMIT_MS + Math.floor(Math.random() * 60_000);
      console.warn("[crossasset] Yahoo 429 — 10분간 요청 중단");
      return null;
    }
    if (!r.ok) return null;
    const j: any = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res) return null;

    const meta = res.meta ?? {};
    // 전일 종가(=오늘 등락의 기준). 크립토/선물도 chartPreviousClose 가 "직전 일 종가"라 동일하게 쓴다.
    const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPreviousClose);
    const ts: number[] = res.timestamp ?? [];
    const closes: (number | null)[] = res.indicators?.quote?.[0]?.close ?? [];

    // 마지막 유효 체결 포인트 = 현재가 (확장시간/24시간 포함).
    // meta.regularMarketPrice 는 확장시간에 갱신 안 되는 경우가 있어 포인트를 직접 읽는다.
    let last: number | null = null;
    let lastTs = 0;
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c != null && Number.isFinite(c)) { last = Number(c); lastTs = Number(ts[i]) * 1000; break; }
    }
    // 포인트가 하나도 없으면 meta 가격이라도 쓴다 (그래도 없으면 실패)
    if (last == null) {
      const rm = Number(meta.regularMarketPrice);
      if (Number.isFinite(rm) && rm > 0) { last = rm; lastTs = Number(meta.regularMarketTime) * 1000 || Date.now(); }
    }
    if (last == null || !Number.isFinite(prevClose) || prevClose <= 0) return null;

    const changePct = ((last - prevClose) / prevClose) * 100;
    return {
      key: a.key,
      price: Math.round(last * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      asOf: lastTs > 0 ? lastTs : Date.now()
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getOne(a: CrossAsset): Promise<CrossQuote | null> {
  const now = Date.now();
  const hit = cache.get(a.key);
  if (hit && now - hit.at < TTL_MS) return hit.data;
  if (globalRateLimitUntil > now) return hit?.data ?? null;        // 429 백오프: 네트워크 미접촉
  if ((failUntil.get(a.key) ?? 0) > now) return hit?.data ?? null; // 백오프 중엔 마지막 값(있으면)

  const running = inflight.get(a.key);
  if (running) return running;

  const p = (async () => {
    const data = await fetchOne(a);
    if (data) cache.set(a.key, { at: Date.now(), data });
    else failUntil.set(a.key, Date.now() + FAIL_MS);
    inflight.delete(a.key);
    return data;
  })();
  inflight.set(a.key, p);
  return p;
}

/** 주어진 자산 목록의 시세. 실패한 심볼은 Map 에서 빠진다 (호출부가 "—" 처리). */
export async function getAssets(list: CrossAsset[]): Promise<Map<string, CrossQuote>> {
  const out = new Map<string, CrossQuote>();
  await Promise.all(
    list.map(async (a) => {
      const q = await getOne(a);
      if (q) out.set(a.key, q);
    })
  );
  return out;
}

/** 크로스에셋(SOXX·BTC·GOLD·OIL) */
export async function getCrossAssets(): Promise<Map<string, CrossQuote>> {
  return getAssets(CROSS_ASSETS);
}

/** 지수 선물(ES/NQ/YM) — 장 밖에서 현물 대신 보여 준다 */
export async function getIndexFutures(): Promise<Map<string, CrossQuote>> {
  return getAssets(INDEX_FUTURES);
}
