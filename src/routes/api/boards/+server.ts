import type { RequestHandler } from "./$types";
import { FINNHUB_API_KEY } from "$env/static/private";

// 간단 캐시 (15초)
let cache = { data: null as any, ts: 0 };

async function getQuote(sym: string) {
  if (!FINNHUB_API_KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_API_KEY}`);
    if (!r.ok) return null;
    const j = await r.json();
    // c: current price, dp: percent change
    // 가격이 0이면 null 처리 (장 오류 등)
    return (j.c && j.c > 0) ? { p: j.c, pct: j.dp } : null;
  } catch { return null; }
}

export const GET: RequestHandler = async () => {
  // 캐시 확인
  if (Date.now() - cache.ts < 15000 && cache.data) {
    return new Response(JSON.stringify(cache.data));
  }

  // 1. 상단 지수 (Top Strip)
  // SPY, QQQ 등은 확실히 무료 API에서 제공됨
  const topList = [
    { k: "NASDAQ", s: "QQQ" },
    { k: "S&P 500", s: "SPY" },
    { k: "DOW", s: "DIA" },
    { k: "VIX", s: "VIXY" }, // VIX 선물 ETF
    { k: "GOLD", s: "GLD" }, // 금 ETF
    { k: "BITCOIN", s: "BITO" } // 비트코인 선물 ETF
  ];

  const top = [];
  for (const item of topList) {
    const q = await getQuote(item.s);
    top.push({
      k: item.k,
      v: q ? q.p.toFixed(2) : "0.00",
      pct: q ? q.pct : 0
    });
  }

  // 2. 하단 Marquee (환율/원자재 대체 ETF)
  // 무료 Finnhub는 FX(KRW=X) 지원 안 함 -> ETF로 우회
  // UUP: 달러 인덱스 Bullish Fund
  // FXE: 유로 Trust
  // FXY: 엔화 Trust
  // USO: 오일 Fund
  const tapeList = [
    { k: "USD(ETF)", s: "UUP" },
    { k: "EUR(ETF)", s: "FXE" },
    { k: "JPY(ETF)", s: "FXY" },
    { k: "OIL(ETF)", s: "USO" },
    // 주요 빅테크 & 코인주 (변동성용)
    { k: "NVIDIA", s: "NVDA" },
    { k: "TESLA", s: "TSLA" },
    { k: "APPLE", s: "AAPL" },
    { k: "MICROSTRATEGY", s: "MSTR" },
    { k: "COINBASE", s: "COIN" }
  ];

  const tape = [];
  for (const item of tapeList) {
    const q = await getQuote(item.s);
    // 데이터 없으면 목록에서 제외하지 않고 '-'로 표시 (레이아웃 깨짐 방지)
    tape.push({
      k: item.k,
      v: q ? q.p.toFixed(2) : "-",
      pct: q ? q.pct : 0
    });
  }

  // 3. Hot Movers (미리 정의된 리스트 중 변동폭 큰 순서 정렬)
  const universe = [
    "NVDA","TSLA","MSTR","COIN","AMD","PLTR","SMCI","ARM", // 변동성 큰 것들
    "AAPL","MSFT","AMZN","GOOGL","META","NFLX",           // 빅테크
    "GME","AMC"                                            // 밈 주식
  ];

  const movers = [];
  for (const s of universe) {
    const q = await getQuote(s);
    if (q) movers.push({ t: s, p: q.p, pct: q.pct });
  }

  // 절대값 변동폭이 큰 순서대로 정렬 (상승/하락 무관하게 핫한 것)
  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  const payload = {
    top,
    tape,
    gainers: movers.filter(m => m.pct >= 0).slice(0, 5),
    losers: movers.filter(m => m.pct < 0).slice(0, 5) // 많이 떨어진 순서
  };

  cache = { data: payload, ts: Date.now() };

  return new Response(JSON.stringify(payload));
};
