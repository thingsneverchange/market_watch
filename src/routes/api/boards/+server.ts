import type { RequestHandler } from "./$types";
import { FINNHUB_API_KEY } from "$env/static/private";

// 간단 캐시
let cache = { data: null as any, ts: 0 };

async function getQuote(sym: string) {
  if (!FINNHUB_API_KEY) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_API_KEY}`);
    const j = await r.json();
    // 가격(c)이 있으면 리턴, 없으면 null
    return j.c ? { p: j.c, pct: j.dp } : null;
  } catch { return null; }
}

export const GET: RequestHandler = async () => {
  if (Date.now() - cache.ts < 10000 && cache.data) {
    return new Response(JSON.stringify(cache.data));
  }

  // 1. Top Strip
  const topList = [
    { k: "NASDAQ", s: "QQQ" }, { k: "S&P 500", s: "SPY" },
    { k: "DOW", s: "DIA" }, { k: "VIX", s: "VIXY" },
    { k: "GOLD", s: "GLD" }, { k: "BITCOIN", s: "BITO" }
  ];

  const top = [];
  for (const t of topList) {
    const q = await getQuote(t.s);
    top.push({
      k: t.k,
      v: q ? q.p.toFixed(2) : "0.00",
      pct: q ? q.pct : 0
    });
  }

  // 2. Marquee Tape (ETF 위주)
  const tapeList = [
    { k: "USD", s: "UUP" }, { k: "EUR", s: "FXE" }, { k: "JPY", s: "FXY" },
    { k: "OIL", s: "USO" }, { k: "NVDA", s: "NVDA" }, { k: "TSLA", s: "TSLA" },
    { k: "AAPL", s: "AAPL" }, { k: "MSTR", s: "MSTR" }
  ];

  const tape = [];
  for (const t of tapeList) {
    const q = await getQuote(t.s);
    // 데이터가 없어도 이름(k)은 꼭 보내야 Marquee에 글씨가 뜹니다.
    tape.push({
      k: t.k,
      v: q ? q.p.toFixed(2) : "...",
      pct: q ? q.pct : 0
    });
  }

  // 3. Hot Movers
  const universe = ["NVDA","TSLA","AAPL","MSFT","AMD","PLTR","COIN","AMZN","GOOGL","META","NFLX","AVGO"];
  const quotes = [];
  for (const s of universe) {
    const q = await getQuote(s);
    if(q) quotes.push({ t: s, p: q.p, pct: q.pct });
  }

  // 정렬
  quotes.sort((a,b) => b.pct - a.pct);

  const payload = {
    top, tape,
    gainers: quotes.filter(x => x.pct >= 0).slice(0,5),
    losers: quotes.filter(x => x.pct < 0).sort((a,b)=>a.pct-b.pct).slice(0,5)
  };

  cache = { data: payload, ts: Date.now() };
  return new Response(JSON.stringify(payload));
};
