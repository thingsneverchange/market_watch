import { FMP_API_KEY } from "$env/static/private";
import { getAvgVolumes } from "./finnhub";
import { marketState, sessionProgress } from "../market-hours";

// ============================================================
//  거래량 — "지금 평소보다 많이 거래되고 있나"
//
//  ── 왜 이게 어려웠나 ──────────────────────────────
//  이 저장소는 거래량을 세 번 포기했다(finnhub.ts:6, :523, focus.ts:28):
//    · Finnhub /quote 에 volume 필드가 없다
//    · Finnhub /stock/candle 은 403 (플랜 미포함)
//    · Finviz futures_all 응답에도 volume/open-interest 가 없다 (실측 확인)
//  그래서 "관심도"를 뉴스 등장 횟수로 대신해 왔다.
//
//  ── 이번에 찾은 조합 ──────────────────────────────
//  오늘 거래량   FMP  /stable/quote   → volume (실측: NVDA 125,138,253)
//  평소 거래량   Finnhub /stock/metric → 10DayAverageTradingVolume (실측: 124.09 백만)
//  둘 다 무료 티어로 나온다. FMP 무료는 **종목당 1요청**이고 콤마·batch 는 유료다
//  (실측: "Premium Query Parameter" / "Restricted Endpoint").
//
//  ── 정직성: 세션 중 비교는 그냥 하면 틀린다 ────────
//  오늘 거래량은 **누적**이라 장 초반엔 당연히 작다. 10일 **종일** 평균과 그대로 비교하면
//  아침 내내 "거래량 급감"이라고 방송하게 된다.
//  그렇다고 경과 시간으로 나누는 것도 틀리다 — 장중 거래량은 개장·마감에 몰리는 U자라
//  선형 가정은 아침을 과대평가한다. 우리는 그 U자 곡선을 갖고 있지 않다.
//
//  → 지어내지 않는다. **장이 끝난 값만 배수로 말하고**, 장중에는 누적값과 경과율을
//    나란히 보여 준다. 시청자가 스스로 읽을 수 있고, 우리는 없는 곡선을 발명하지 않는다.
//    (없는 값을 그럴듯하게 만드는 것보다 두 숫자를 정직하게 놓는 게 낫다)
// ============================================================

const TTL_MS = 15 * 60_000;   // FMP 무료는 종목당 1요청 — 아껴 쓴다
const FAIL_TTL_MS = 3 * 60_000;
/** 하루 요청 상한. 정규장 6.5시간 × 4회/시간 × 8종목 ≈ 208 → 무료 한도 안쪽 */
const DAILY_CAP = 220;

type Entry = { at: number; volume: number | null; ttl: number };
const cache = new Map<string, Entry>();
let dayKey = "";
let spentToday = 0;

function etDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

async function fetchVolume(ticker: string): Promise<number | null> {
  if (!FMP_API_KEY) return null;
  try {
    const r = await fetch(
      `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(ticker)}&apikey=${FMP_API_KEY}`,
      { signal: AbortSignal.timeout(10_000), cache: "no-store" }
    );
    if (!r.ok) { console.warn(`[volume] ${ticker} HTTP ${r.status}`); return null; }
    const j = await r.json();
    const v = Number(Array.isArray(j) ? j[0]?.volume : j?.volume);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (e) {
    console.warn(`[volume] ${ticker} 실패: ${String((e as Error)?.message ?? e).slice(0, 60)}`);
    return null;
  }
}

export type VolumeRow = {
  ticker: string;
  /** 오늘(또는 직전 세션) 누적 거래량 */
  volume: number | null;
  /** 10일 평균 일간 거래량 */
  avg10: number | null;
  /**
   * 평균 대비 배수. **세션이 끝난 뒤에만 채운다** — 장중 누적을 종일 평균과
   * 비교하면 아침 내내 "거래량 급감"이 된다. 위 주석 참고.
   */
  ratio: number | null;
  /** 정규장 경과율 0~1. 장중이면 화면이 "아직 N% 진행"을 같이 보여 준다 */
  progress: number | null;
};

/**
 * @param tickers 최대 8개까지만 본다 (FMP 무료가 종목당 1요청이라 예산이 곧 종목 수다)
 */
export async function getVolumes(tickers: string[]): Promise<VolumeRow[]> {
  const today = etDay();
  if (today !== dayKey) { dayKey = today; spentToday = 0; }

  const now = Date.now();
  const want = [...new Set(tickers)].slice(0, 8);
  const todo = want.filter((t) => {
    const hit = cache.get(t);
    return !hit || now - hit.at >= hit.ttl;
  });

  // 예산이 남은 만큼만 채운다. 넘으면 **캐시된 값으로 간다** — 요청을 쏘고 429 를 맞느니 낫다.
  const budget = Math.max(0, DAILY_CAP - spentToday);
  await Promise.all(todo.slice(0, budget).map(async (t) => {
    const v = await fetchVolume(t);
    spentToday++;
    cache.set(t, { at: now, volume: v, ttl: v == null ? FAIL_TTL_MS : TTL_MS });
  }));

  const avg = await getAvgVolumes(want);   // Finnhub, 24시간 캐시 — 사실상 공짜
  const st = marketState();
  const prog = sessionProgress();

  return want.map((t) => {
    const volume = cache.get(t)?.volume ?? null;
    const avg10 = avg.get(t) ?? null;
    // 배수는 **거래가 완전히 끝난 값일 때만** 낸다.
    //
    // ★ 처음엔 `!open && progress >= 1` 로 썼는데 틀렸다. 새벽 2시엔 sessionProgress 가
    //   **다가올 장** 기준이라 0 을 돌려준다 — 직전 세션은 이미 끝났는데도 배수가 안 나왔다.
    //   반대로 프리장·애프터장에는 FMP 의 volume 이 **오늘 부분 누적**이라 종일 평균과
    //   비교하면 안 된다.
    //   판정은 세션 이름으로 한다: CLOSED·WEEKEND·HOLIDAY 일 때만 그 값이 완결된 하루다.
    const done = st.session === "CLOSED" || st.session === "WEEKEND" || st.session === "HOLIDAY";
    const ratio = done && volume != null && avg10 ? Math.round((volume / avg10) * 100) / 100 : null;
    return { ticker: t, volume, avg10, ratio, progress: st.open ? prog : null };
  });
}
