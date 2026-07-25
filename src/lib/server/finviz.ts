// ============================================================
//  Finviz 선물/원자재 시세 — 24시간 스트림의 핵심 소스
//
//  왜 이걸 쓰게 됐나 (다른 소스가 전부 막혔다, 실측):
//   · Yahoo    → 데이터센터 IP **영구 차단** (맥·서버 모두 429). 배포본에선 사용 불가
//   · FMP 무료 → 하루 250회. NQ/YM 선물은 아예 프리미엄
//   · Alpha Vantage 인트라데이 → 프리미엄 전환
//   · Finnhub  → 넉넉하지만 US 주식/ETF 만, 확장시간 갱신 없음
//
//  Finviz 의 공개 futures 엔드포인트는 **한 번의 요청으로 49개 심볼**을 주고,
//  각 심볼마다 300포인트 스파크라인까지 포함한다. 서버 IP 에서도 200 을 받는다(실측).
//  → NQ(나스닥 선물)를 24시간 표시할 수 있는 **유일한 무료 경로**다.
//
//  예의상 TTL 을 60초로 둔다 (하루 ~1,440회, 전 심볼 합쳐서). 실패하면 마지막 값 →
//  그것도 없으면 null 로 호출부가 Finnhub 로 폴백한다.
// ============================================================

export type FutQuote = {
  key: string;        // "NQ"
  label: string;      // "Nasdaq 100"
  price: number;
  changePct: number;
  prevClose: number | null;
  spark: number[];    // 최근 추이 (자체 미니차트 렌더용)
  asOf: number;
};

const URL = "https://finviz.com/api/futures_all.ashx";
const TTL_MS = 60_000;
const FAIL_MS = 3 * 60_000;
const REQ_TIMEOUT_MS = 6000;

// 서버는 리눅스라 리눅스 UA 를 보낸다 (맥 UA 를 리눅스 서버가 보내면 부자연스럽다)
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

let cache: { at: number; data: Map<string, FutQuote> } | null = null;
let failUntil = 0;
let inflight: Promise<Map<string, FutQuote>> | null = null;

function parse(j: any): Map<string, FutQuote> {
  const out = new Map<string, FutQuote>();
  if (!j || typeof j !== "object") return out;
  const now = Date.now();
  for (const [k, v] of Object.entries<any>(j)) {
    const price = Number(v?.last);
    const chg = Number(v?.change);
    if (!Number.isFinite(price) || price <= 0) continue;
    const spark = Array.isArray(v?.sparkline)
      ? v.sparkline.map(Number).filter((n: number) => Number.isFinite(n))
      : [];
    out.set(k, {
      key: k,
      label: String(v?.label ?? k),
      price,
      // Finviz 의 change 는 이미 % 다 (실측: NQ change=-1.18 ↔ 실제 -1.18%)
      changePct: Number.isFinite(chg) ? Math.round(chg * 100) / 100 : 0,
      prevClose: Number.isFinite(Number(v?.prevClose)) ? Number(v.prevClose) : null,
      spark,
      asOf: now
    });
  }
  return out;
}

/** 전 선물/원자재 시세 (60초 캐시). 실패 시 마지막 값, 그것도 없으면 빈 Map. */
export async function getFutures(): Promise<Map<string, FutQuote>> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (failUntil > now) return cache?.data ?? new Map();
  if (inflight) return inflight;

  inflight = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
    try {
      const r = await fetch(URL, {
        headers: { "user-agent": UA, accept: "application/json,text/plain,*/*" },
        signal: ctl.signal,
        cache: "no-store",
        redirect: "follow" // 301 → charts2-node 로 리다이렉트된다
      });
      if (!r.ok) {
        failUntil = Date.now() + FAIL_MS;
        console.warn(`[finviz] ${r.status} — 마지막 값으로 폴백`);
        return cache?.data ?? new Map();
      }
      const data = parse(await r.json());
      if (data.size === 0) {
        failUntil = Date.now() + FAIL_MS;
        return cache?.data ?? new Map();
      }
      cache = { at: Date.now(), data };
      return data;
    } catch (e: any) {
      failUntil = Date.now() + FAIL_MS;
      console.warn(`[finviz] 연결 실패 (${e?.name ?? e}) — 마지막 값으로 폴백`);
      return cache?.data ?? new Map();
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  return inflight;
}
