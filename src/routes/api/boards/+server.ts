import type { RequestHandler } from "./$types";
import { FINNHUB_API_KEY } from "$env/static/private";

type FinnQuote = { c: number; dp: number };

let lastGood: any = {
  top: [],
  tape1: [],
  tape2: [],
  gainers: [],
  losers: [],
  meta: { asOf: new Date().toISOString(), ok: false }
};
let lastGoodAt = 0;

const TTL_MS = 15_000; // 15초 캐시(안정화)

async function safeJson(url: string) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return { ok: false, status: r.status, json: null };
    const json = await r.json().catch(() => null);
    return { ok: true, status: r.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

async function quote(symbol: string): Promise<{ ok: boolean; price?: number; pct?: number }> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;
  const res = await safeJson(url);
  if (!res.ok || !res.json) return { ok: false };

  const j = res.json as FinnQuote;
  const price = Number(j.c ?? 0);
  const pct = Number(j.dp ?? 0);

  // ⚠️ price가 0이면 "실패 취급" (0으로 덮지 않게)
  if (!price) return { ok: false };

  return { ok: true, price, pct };
}

// FX는 안정성 위해 rate만. pct는 null(표시 안 함)
async function fxRate(pair: string): Promise<{ ok: boolean; rate?: number }> {
  const [base, quoteCcy] = pair.split("/");
  const url = `https://finnhub.io/api/v1/forex/rates?base=${encodeURIComponent(base)}&token=${FINNHUB_API_KEY}`;
  const res = await safeJson(url);
  if (!res.ok || !res.json) return { ok: false };

  const rate = Number(res.json?.quote?.[quoteCcy] ?? 0);
  if (!rate) return { ok: false };

  return { ok: true, rate };
}

export const GET: RequestHandler = async () => {
  if (!FINNHUB_API_KEY) {
    return new Response(JSON.stringify(lastGood), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  const now = Date.now();
  if (now - lastGoodAt < TTL_MS && lastGood?.meta?.ok) {
    return new Response(JSON.stringify(lastGood), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  try {
    // ===== Top strip (프록시 안정) =====
    const TOP = [
      { k: "NQ (proxy)", sym: "QQQ" },
      { k: "SPY", sym: "SPY" },
      { k: "NY (proxy)", sym: "DIA" },
      { k: "BTC (proxy)", sym: "IBIT" },
      { k: "GLD", sym: "GLD" }
    ];

    const top = [];
    for (const x of TOP) {
      const q = await quote(x.sym);
      if (!q.ok) {
        // ✅ 실패하면 lastGood에서 해당 항목 찾아서 유지
        const prev = (lastGood.top ?? []).find((p: any) => p.k === x.k);
        top.push(prev ?? { k: x.k, v: "--", pct: 0 });
      } else {
        top.push({ k: x.k, v: q.price!.toFixed(2), pct: q.pct ?? 0 });
      }
    }

    // ===== Tape1: commodities proxy + FX rate =====
    const commodities = [
      { k: "GOLD", sym: "GLD" },
      { k: "OIL", sym: "USO" },
      { k: "COCOA", sym: "NIB" }
    ];
    const fxPairs = ["USD/KRW", "EUR/USD", "USD/JPY"];

    const tape1: any[] = [];
    for (const x of commodities) {
      const q = await quote(x.sym);
      if (!q.ok) {
        const prev = (lastGood.tape1 ?? []).find((p: any) => p.k === x.k);
        tape1.push(prev ?? { k: x.k, v: "--", pct: null });
      } else {
        tape1.push({ k: x.k, v: q.price!.toFixed(2), pct: q.pct ?? 0 });
      }
    }
    for (const p of fxPairs) {
      const f = await fxRate(p);
      if (!f.ok) {
        const prev = (lastGood.tape1 ?? []).find((x: any) => x.k === p);
        tape1.push(prev ?? { k: p, v: "--", pct: null });
      } else {
        tape1.push({ k: p, v: f.rate!.toFixed(4), pct: null });
      }
    }

    // ===== Tape2: indices/coins proxy =====
    const tape2syms = [
      { k: "SPY", sym: "SPY" },
      { k: "QQQ", sym: "QQQ" },
      { k: "DIA", sym: "DIA" },
      { k: "BTC", sym: "IBIT" },
      { k: "ETH", sym: "ETHE" },
      { k: "SOL", sym: "SOLZ" }
    ];

    const tape2: any[] = [];
    for (const x of tape2syms) {
      const q = await quote(x.sym);
      if (!q.ok) {
        const prev = (lastGood.tape2 ?? []).find((p: any) => p.k === x.k);
        tape2.push(prev ?? { k: x.k, v: "--", pct: null });
      } else {
        tape2.push({ k: x.k, v: q.price!.toFixed(2), pct: q.pct ?? 0 });
      }
    }

    // ===== Movers: gainers/losers =====
    const UNIVERSE = [
      "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AMD","AVGO","NFLX",
      "COST","PEP","KO","JPM","V","MA","XOM","CVX","BA","DIS",
      "PLTR","CRWD","NOW","ADBE","ORCL","INTC","QCOM","SHOP","UBER","PYPL"
    ];

    const rows: any[] = [];
    for (const t of UNIVERSE) {
      const q = await quote(t);
      if (q.ok) rows.push({ ticker: t, price: q.price!, changePct: q.pct ?? 0 });
    }

    rows.sort((a, b) => b.changePct - a.changePct);
    const gainers = rows.slice(0, 6);
    const losers = [...rows].reverse().slice(0, 6);

    // ✅ movers가 비면 lastGood 유지
    const payload = {
      top,
      tape1,
      tape2,
      gainers: gainers.length ? gainers : lastGood.gainers,
      losers: losers.length ? losers : lastGood.losers,
      meta: { asOf: new Date().toISOString(), ok: true }
    };

    lastGood = payload;
    lastGoodAt = now;

    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch {
    // ✅ 어떤 예외든 lastGood 반환
    return new Response(JSON.stringify(lastGood), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
};
