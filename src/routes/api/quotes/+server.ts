import type { RequestHandler } from "./$types";
import { FINNHUB_API_KEY } from "$env/static/private";

const API_KEY = FINNHUB_API_KEY;

const TICKERS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "SPY"];

type FinnQuote = { c: number; dp: number }; // current price, percent change

async function fetchQuote(ticker: string) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${API_KEY}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Finnhub error ${r.status}`);
  const j = (await r.json()) as FinnQuote;

  return {
    ticker,
    price: Number(j.c ?? 0),
    changePct: Number(j.dp ?? 0)
  };
}

export const GET: RequestHandler = async () => {
  if (!API_KEY) {
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { "content-type": "application/json" }
    });
  }

  try {
    const rows = await Promise.all(TICKERS.map(fetchQuote));
    // 0 값 제거 등 가공 원하면 여기서
    return new Response(JSON.stringify({ rows }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch {
    return new Response(JSON.stringify({ rows: [] }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
};
