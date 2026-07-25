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
  /** 포인트 등락 (−338.5). %만으로는 "몇 포인트 빠졌나"가 안 보인다. */
  changeAbs: number | null;
  /** 기준선 = 전일 정산가. changePct 가 실제로 쓰는 기준이다(아래 주석 참고). */
  prevClose: number | null;
  spark: number[];    // 최근 25시간 5분봉 (자체 미니차트 렌더용)
  /** 시간축 눈금: 배열 인덱스 → 라벨 ("4PM", "10AM" …). 메인 차트에서 세로 격자로 쓴다. */
  marks: Record<number, string>;
  asOf: number;
};

/** m5=5분봉(≈25시간) · h1=1시간봉(≈12일) · d1=일봉(≈14개월) */
export type Timeframe = "m5" | "h1" | "d1";

// ★ timeframe=m5 가 **핵심**이다.
//   파라미터를 빼면 기본값이 d1(일봉 300개 ≈ 14개월)이라 미니차트가 "1년 추세"가 되어 버린다.
//   옆에 오늘의 등락률(-1.18%)을 붙여 놓고 1년 차트를 그리면 시청자에게 거짓말이 된다.
//   m5 = 5분봉 300개 = 약 25시간 → 야간 세션 전체가 들어와 24시간 스트림에 딱 맞는다. (실측)
const URL = (tf: Timeframe) => `https://finviz.com/api/futures_all.ashx?timeframe=${tf}`;
const TTL_MS = 60_000;
const FAIL_MS = 3 * 60_000;
const REQ_TIMEOUT_MS = 6000;

// 서버는 리눅스라 리눅스 UA 를 보낸다 (맥 UA 를 리눅스 서버가 보내면 부자연스럽다)
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// 타임프레임마다 따로 캐시한다 (m5 는 상시, h1/d1 은 컨트롤에서 고를 때만 채워진다)
type Slot = { cache: { at: number; data: Map<string, FutQuote> } | null; failUntil: number;
  inflight: Promise<Map<string, FutQuote>> | null };
const slots: Record<Timeframe, Slot> = {
  m5: { cache: null, failUntil: 0, inflight: null },
  h1: { cache: null, failUntil: 0, inflight: null },
  d1: { cache: null, failUntil: 0, inflight: null }
};

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

    // ★ 기준가는 응답의 prevClose 를 **쓰면 안 된다**.
    //   실측: NQ last=28306.5 changeUsd=-338.5 change=-1.18%  → 기준 28645.0
    //         그런데 prevClose 필드는 28620.75 로 **다른 값**이다.
    //   선물의 등락은 관례상 전일 *정산가(settlement)* 기준인데 prevClose 는 전일 마지막
    //   체결가라 둘이 다르다. change/changeUsd/last 세 값은 서로 정확히 일치하므로
    //   (change = changeUsd / (last - changeUsd)) 기준가를 여기서 역산한다.
    //   prevClose 를 그대로 믿으면 ES 처럼 **부호가 뒤집히는** 경우까지 나온다
    //   (change=+0.03% 인데 prevClose 로 계산하면 -0.01%).
    const usd = Number(v?.changeUsd);
    const base = Number.isFinite(usd) ? price - usd : Number(v?.prevClose);

    const marks: Record<number, string> = {};
    const raw = v?.sparklineDateChanges;
    if (raw && typeof raw === "object") {
      for (const [idx, lab] of Object.entries<any>(raw)) {
        const i = Number(idx);
        if (Number.isInteger(i) && i >= 0 && i < spark.length) marks[i] = String(lab);
      }
    }

    out.set(k, {
      key: k,
      label: String(v?.label ?? k),
      price,
      // Finviz 의 change 는 이미 % 다 (실측: NQ change=-1.18 ↔ 실제 -1.18%)
      changePct: Number.isFinite(chg) ? Math.round(chg * 100) / 100 : 0,
      changeAbs: Number.isFinite(usd) ? usd : null,
      prevClose: Number.isFinite(base) && base > 0 ? base : null,
      spark,
      marks,
      asOf: now
    });
  }
  return out;
}

/** 전 선물/원자재 시세 (60초 캐시). 실패 시 마지막 값, 그것도 없으면 빈 Map. */
export async function getFutures(tf: Timeframe = "m5"): Promise<Map<string, FutQuote>> {
  const s = slots[tf] ?? slots.m5;
  const now = Date.now();
  if (s.cache && now - s.cache.at < TTL_MS) return s.cache.data;
  if (s.failUntil > now) return s.cache?.data ?? new Map();
  if (s.inflight) return s.inflight;

  s.inflight = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
    try {
      const r = await fetch(URL(tf), {
        headers: { "user-agent": UA, accept: "application/json,text/plain,*/*" },
        signal: ctl.signal,
        cache: "no-store",
        redirect: "follow" // 301 → charts2-node 로 리다이렉트된다
      });
      if (!r.ok) {
        s.failUntil = Date.now() + FAIL_MS;
        console.warn(`[finviz:${tf}] ${r.status} — 마지막 값으로 폴백`);
        return s.cache?.data ?? new Map();
      }
      const data = parse(await r.json());
      if (data.size === 0) {
        s.failUntil = Date.now() + FAIL_MS;
        return s.cache?.data ?? new Map();
      }
      s.cache = { at: Date.now(), data };
      return data;
    } catch (e: any) {
      s.failUntil = Date.now() + FAIL_MS;
      console.warn(`[finviz:${tf}] 연결 실패 (${e?.name ?? e}) — 마지막 값으로 폴백`);
      return s.cache?.data ?? new Map();
    } finally {
      clearTimeout(timer);
      s.inflight = null;
    }
  })();

  return s.inflight;
}
