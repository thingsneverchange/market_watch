import type { RequestHandler } from "./$types";
import { FINNHUB_API_KEY } from "$env/static/private";

// 캐싱 변수
let cache = {
  top: [], tape: [], gainers: [], losers: [],
  asOf: 0
};

async function getQuote(sym: string) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_API_KEY}`);
    const j = await r.json();
    return j.c ? { price: j.c, pct: j.dp } : null;
  } catch { return null; }
}

export const GET: RequestHandler = async () => {
  if (Date.now() - cache.asOf < 15000 && cache.top.length > 0) {
    return new Response(JSON.stringify(cache));
  }

  // 1. Top Strip (Proxies)
  const TOP_SYMS = [
    { k: "NASDAQ", s: "QQQ" }, { k: "S&P500", s: "SPY" },
    { k: "DOW", s: "DIA" }, { k: "VIX", s: "VIXY" } // VIXY as proxy
  ];
  const top = [];
  for(const t of TOP_SYMS) {
    const q = await getQuote(t.s);
    top.push({ k: t.k, v: q ? q.price.toFixed(2) : "-", pct: q ? q.pct : 0 });
  }

  // 2. Marquee Tape (Commodities & FX)
  // FX는 Finnhub 무료에서 잘 안될 수 있으니 ETF나 다른 심볼 사용 권장
  // 여기서는 ETF 대용품 사용 (FX 대신) -> UUP(달러인덱스), FXY(엔화), FXE(유로)
  const TAPE_SYMS = [
    { k: "GOLD", s: "GLD" }, { k: "OIL", s: "USO" },
    { k: "COCOA", s: "NIB" }, // NIB는 ETN, 상장폐지 여부 확인 필요하나 예시 유지
    { k: "USD", s: "UUP" },   // 달러 인덱스 ETF
    { k: "EUR", s: "FXE" },   // 유로 ETF
    { k: "JPY", s: "FXY" }    // 엔화 ETF
  ];
  const tape = [];
  for(const t of TAPE_SYMS) {
    const q = await getQuote(t.s);
    tape.push({ k: t.k, v: q ? q.price.toFixed(2) : "-", pct: q ? q.pct : 0 });
  }

  // 3. Hot Movers (Universe 확장: 변동성 큰 종목 포함)
  const UNIVERSE = [
    "AAPL","MSFT","NVDA","AMZN","TSLA","GOOGL","META", // Big Tech
    "AMD","ARM","SMCI","PLTR","COIN","MSTR","MARA",    // Volatile/Crypto
    "NFLX","DIS","BA","INTC","PYPL"
  ];
  const rows = [];
  for(const s of UNIVERSE) {
    const q = await getQuote(s);
    if(q) rows.push({ t: s, p: q.price, pct: q.pct });
  }
  rows.sort((a,b) => b.pct - a.pct); // Sort by % change

  cache = {
    top, tape,
    gainers: rows.slice(0, 5),
    losers: rows.slice(-5).reverse(),
    asOf: Date.now()
  };

  return new Response(JSON.stringify(cache));
};
