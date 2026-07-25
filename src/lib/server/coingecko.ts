// ============================================================
//  CoinGecko — BTC 시세 (키 불필요, 24시간)
//
//  왜 필요한가: 크립토는 주말·야간에 **유일하게 살아 움직이는** 자산인데
//   · Yahoo 는 데이터센터 IP 를 영구 차단 (실측: 맥·서버 모두 429)
//   · FMP 무료는 하루 250회라 45초 폴링에 못 버틴다
//  CoinGecko 공개 API 는 키 없이 쓰이고 한도가 넉넉해 이 용도에 맞다.
// ============================================================

export type CoinQuote = { price: number; changePct: number; asOf: number };

const TTL_MS = 60_000;   // 1분 — 헤더 글랜스엔 충분하고 공개 API 예의에도 맞다
const FAIL_MS = 5 * 60_000;

let cache: { at: number; data: CoinQuote | null } | null = null;
let failUntil = 0;
let inflight: Promise<CoinQuote | null> | null = null;

export async function getBtc(): Promise<CoinQuote | null> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (failUntil > now) return cache?.data ?? null;
  if (inflight) return inflight;

  inflight = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        { signal: ctl.signal, cache: "no-store", headers: { accept: "application/json" } }
      );
      if (!r.ok) { failUntil = Date.now() + FAIL_MS; return cache?.data ?? null; }
      const j: any = await r.json();
      const p = Number(j?.bitcoin?.usd);
      const c = Number(j?.bitcoin?.usd_24h_change);
      if (!Number.isFinite(p)) { failUntil = Date.now() + FAIL_MS; return cache?.data ?? null; }
      const data: CoinQuote = {
        price: Math.round(p * 100) / 100,
        changePct: Number.isFinite(c) ? Math.round(c * 100) / 100 : 0,
        asOf: Date.now()
      };
      cache = { at: Date.now(), data };
      return data;
    } catch {
      failUntil = Date.now() + FAIL_MS;
      return cache?.data ?? null;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  return inflight;
}
