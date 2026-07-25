// ============================================================
//  네이버 금융 — 아시아 지수 **원본** (ETF 대체물이 아니다)
//
//  왜 필요했나:
//   · Finviz 선물 49종에 코스피·상해·항셍이 없다. 닛케이만 NKD 선물로 있다.
//   · Finnhub 은 "^KS11" 에 "Market data subscription required" (403)
//   · TradingView 무료 임베드는 지수 **원본**을 아예 못 그린다(ETF/암호화폐/FX 만)
//   → 그래서 코스피는 EWY(ETF 대체물)로 때우고 있었다. 환율이 섞이고 미국 시간에만 움직인다.
//
//  네이버는 지수 원본을 주고 **맥과 서버 IP 양쪽에서 200 이 온다**(실측).
//  게다가 봉별 진짜 OHLC 를 준다 — Finviz 종가 배열과 달리 캔들을 지어내지 않아도 된다.
//
//  주의: 공식 API 가 아니다. 실패하면 마지막 값으로 폴백하고, 그것도 없으면 null 을
//  돌려줘서 호출부가 패널을 숨기게 한다. (Yahoo 처럼 언젠가 막힐 수 있다)
// ============================================================

export type IndexQuote = {
  code: string;
  label: string;
  price: number;
  change: number;        // 포인트
  changePct: number;
  /** 거래소 현지 마지막 체결 시각 (ISO) */
  tradedAt: string | null;
  /** OPEN | CLOSE 등 네이버가 주는 장 상태 */
  status: string;
  /** 지연 시간(분). 0 이면 실시간. 해외 지수는 보통 15분 지연이다 — 화면에 밝혀야 한다. */
  delayMin: number;
  asOf: number;
};

export type Bar = { o: number; h: number; l: number; c: number; t: string };

/** 국내는 polling, 해외는 basic 엔드포인트로 갈린다 */
const DOMESTIC = new Set(["KOSPI", "KOSDAQ", "KPI200"]);

export const NAVER_INDEXES: Record<string, string> = {
  KOSPI: "KOSPI",
  KOSDAQ: "KOSDAQ",
  KPI200: "KOSPI 200",
  ".N225": "NIKKEI 225",
  ".SSEC": "SHANGHAI",
  ".HSI": "HANG SENG",
  ".IXIC": "NASDAQ COMP",
  ".DJI": "DOW JONES"
};

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const QUOTE_TTL = 60_000;
const SERIES_TTL = 5 * 60_000;
const FAIL_MS = 3 * 60_000;
const TIMEOUT_MS = 6000;

async function req(url: string): Promise<any | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json", referer: "https://finance.naver.com/" },
      signal: ctl.signal,
      cache: "no-store"
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "6,690.62" → 6690.62 (네이버는 숫자를 콤마 문자열로 준다) */
function num(v: any): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

const qCache = new Map<string, { at: number; data: IndexQuote | null }>();
const qFail = new Map<string, number>();

export async function getIndexQuote(code: string): Promise<IndexQuote | null> {
  const now = Date.now();
  const hit = qCache.get(code);
  if (hit && now - hit.at < QUOTE_TTL) return hit.data;
  if ((qFail.get(code) ?? 0) > now) return hit?.data ?? null;

  let q: IndexQuote | null = null;

  if (DOMESTIC.has(code)) {
    const j = await req(`https://polling.finance.naver.com/api/realtime/domestic/index/${code}`);
    const d = j?.datas?.[0];
    if (d) {
      const price = num(d.closePrice);
      const chg = num(d.compareToPreviousClosePrice);
      const pct = num(d.fluctuationsRatio);
      if (Number.isFinite(price) && price > 0) {
        q = {
          code, label: NAVER_INDEXES[code] ?? code,
          price, change: Number.isFinite(chg) ? chg : 0,
          changePct: Number.isFinite(pct) ? pct : 0,
          tradedAt: d.localTradedAt ?? null,
          status: String(d.marketStatus ?? ""),
          delayMin: Number(d.stockExchangeType?.delayTime ?? 0) || 0,
          asOf: now
        };
      }
    }
  } else {
    const j = await req(`https://api.stock.naver.com/index/${encodeURIComponent(code)}/basic`);
    if (j) {
      const price = num(j.closePrice);
      const chg = num(j.compareToPreviousClosePrice);
      const pct = num(j.fluctuationsRatio);
      if (Number.isFinite(price) && price > 0) {
        q = {
          code, label: NAVER_INDEXES[code] ?? String(j.stockName ?? code),
          price, change: Number.isFinite(chg) ? chg : 0,
          changePct: Number.isFinite(pct) ? pct : 0,
          tradedAt: j.localTradedAt ?? null,
          status: String(j.marketStatus ?? ""),
          delayMin: Number(j.stockExchangeType?.delayTime ?? 0) || 0,
          asOf: now
        };
      }
    }
  }

  if (!q) { qFail.set(code, now + FAIL_MS); return hit?.data ?? null; }
  qCache.set(code, { at: now, data: q });
  return q;
}

const sCache = new Map<string, { at: number; data: Bar[] }>();

/**
 * 봉 시계열. **진짜 OHLC 다** (Finviz 처럼 종가로 봉을 지어내지 않는다).
 *  · "minute" = 분봉 (최근 거래일 장중)
 *  · "day"    = 일봉
 */
export async function getIndexSeries(code: string, kind: "minute" | "day" = "minute"): Promise<Bar[]> {
  const key = `${code}:${kind}`;
  const now = Date.now();
  const hit = sCache.get(key);
  if (hit && now - hit.at < SERIES_TTL) return hit.data;

  const scope = DOMESTIC.has(code) ? "domestic" : "foreign";
  let url: string;
  if (kind === "minute") {
    url = `https://api.stock.naver.com/chart/${scope}/index/${encodeURIComponent(code)}/minute?periodType=day`;
  } else {
    // 최근 1년 일봉
    const end = new Date(now);
    const start = new Date(now - 365 * 864e5);
    const f = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}0000`;
    url = `https://api.stock.naver.com/chart/${scope}/index/${encodeURIComponent(code)}/day?startDateTime=${f(start)}&endDateTime=${f(end)}`;
  }

  const j = await req(url);
  if (!Array.isArray(j) || !j.length) return hit?.data ?? [];

  const bars: Bar[] = [];
  for (const b of j) {
    // 분봉은 currentPrice, 일봉은 closePrice 로 필드명이 다르다
    const c = num(b.closePrice ?? b.currentPrice);
    const o = num(b.openPrice), h = num(b.highPrice), l = num(b.lowPrice);
    if (![c, o, h, l].every((n) => Number.isFinite(n) && n > 0)) continue;
    bars.push({ o, h, l, c, t: String(b.localDateTime ?? b.localDate ?? "") });
  }
  if (!bars.length) return hit?.data ?? [];
  sCache.set(key, { at: now, data: bars });
  return bars;
}
