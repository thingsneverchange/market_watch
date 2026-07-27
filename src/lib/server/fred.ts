import { env } from "$env/dynamic/private";

// ============================================================
//  FRED (세인트루이스 연준) — 거시 지표의 **1차 출처**
//
//  왜 이걸 쓰나:
//   그동안 거시 수치는 LLM 리캡이 주는 값이었고, 검증할 방법이 없었다.
//   (실제 사고: 리캡이 "INTC beat +3.4%" 라 했는데 실제는 −7.89%)
//   FRED 는 대조할 2차 출처가 아니라 **정부·연준이 발표하는 원본**이다.
//   그래서 "맞다/틀리다"를 따질 대상이 아니라 기준 그 자체가 된다.
//
//  한계 (정직하게):
//   · FRED 는 **컨센서스(예상치)를 주지 않는다.** 그건 이코노미스트 설문이라 상용 상품이다.
//     "예상 대비 상회/하회"를 하려면 유료 소스가 따로 필요하다 (Finnhub Economic-1 $50/월).
//   · 발표 **직후 몇 분**은 반영이 늦을 수 있다. 속보용이 아니라 확정치용이다.
//   · 지수 레벨을 주므로 시장이 보는 형태(전년비·전월비·증감)로 **여기서 변환**한다.
//     CPI 를 "332.568" 로 띄우면 아무 의미가 없다. "+3.73% YoY" 여야 한다.
// ============================================================

const BASE = "https://api.stlouisfed.org/fred";
const TTL_MS = 6 * 3600_000;     // 거시 지표는 월 단위 갱신이라 6시간이면 충분하다
const FAIL_MS = 10 * 60_000;
const TIMEOUT_MS = 8000;

/** 화면에 올릴 지표 정의 — 변환 방식이 지표마다 다르다 */
type Transform = "yoy" | "mom" | "level" | "delta_k";
type Spec = {
  key: string;
  label: string;
  series: string;
  transform: Transform;
  unit: string;
  /** 발표 일정을 조회할 FRED 릴리즈 id */
  releaseId: number;
  /** 중요도 1~5 (방송 표기용) */
  imp: number;
  /** 값이 오르는 게 시장에 매파적(=악재)인가 */
  upIsHawkish: boolean;
};

export const FRED_SPECS: Spec[] = [
  { key: "cpi",   label: "CPI",            series: "CPIAUCSL", transform: "yoy",     unit: "% YoY", releaseId: 10, imp: 5, upIsHawkish: true },
  { key: "core",  label: "Core PCE",       series: "PCEPILFE", transform: "yoy",     unit: "% YoY", releaseId: 54, imp: 5, upIsHawkish: true },
  { key: "nfp",   label: "Nonfarm Payrolls", series: "PAYEMS", transform: "delta_k", unit: "K",     releaseId: 50, imp: 5, upIsHawkish: true },
  { key: "unemp", label: "Unemployment",   series: "UNRATE",   transform: "level",   unit: "%",     releaseId: 50, imp: 4, upIsHawkish: false },
  { key: "gdp",   label: "Real GDP",       series: "GDPC1",    transform: "yoy",     unit: "% YoY", releaseId: 53, imp: 4, upIsHawkish: false },
  { key: "retail",label: "Retail Sales",   series: "RSAFS",    transform: "mom",     unit: "% MoM", releaseId: 9,  imp: 3, upIsHawkish: false },
  { key: "ffr",   label: "Fed Funds Rate", series: "DFF",      transform: "level",   unit: "%",     releaseId: 18, imp: 5, upIsHawkish: true }
];

export type MacroReading = {
  key: string;
  label: string;
  /** 시장이 보는 형태로 변환된 값 */
  value: number | null;
  unit: string;
  /** 직전 기간의 같은 변환값 (비교용) */
  prev: number | null;
  /** 관측 기간 (예: "2026-06") */
  period: string;
  /** FRED 가 이 시리즈를 마지막으로 갱신한 시각 */
  updated: string;
  imp: number;
  upIsHawkish: boolean;
};

type Obs = { date: string; value: string };

let cache: { at: number; data: MacroReading[] } | null = null;
let failUntil = 0;
let inflight: Promise<MacroReading[]> | null = null;

async function fred(path: string): Promise<any | null> {
  const key = String(env.FRED_API_KEY || "").trim();
  if (!key) return null;  // 미설정 = 기능 꺼짐 (에러 아님)
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${BASE}${path}${sep}file_type=json&api_key=${key}`, {
      signal: ctl.signal, cache: "no-store"
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 관측치를 시장이 보는 수치로 변환한다 (지수 레벨 그대로는 방송에 못 쓴다) */
function convert(obs: Obs[], t: Transform, freq: string): { value: number | null; prev: number | null } {
  const v = obs.map((o) => Number(o.value)).filter((n) => Number.isFinite(n));
  const at = (i: number) => (i < v.length ? v[i] : null);
  const r = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

  if (t === "level") return { value: r(at(0)), prev: r(at(1)) };
  if (t === "delta_k") {
    const a = at(0), b = at(1), c = at(2);
    return { value: a !== null && b !== null ? Math.round(a - b) : null,
             prev:  b !== null && c !== null ? Math.round(b - c) : null };
  }
  if (t === "mom") {
    const a = at(0), b = at(1), c = at(2);
    return { value: a !== null && b ? r((a / b - 1) * 100) : null,
             prev:  b !== null && c ? r((b / c - 1) * 100) : null };
  }
  // yoy — **시리즈 주기로** 기간 수를 정한다.
  //  예전엔 배열 길이로 추측해서(>20 이면 12) 분기 시리즈인 GDP 를 12분기(=3년) 전과
  //  비교했다. 그래서 실질GDP 가 "+7.76% YoY" 로 찍혔다 — 명백히 말이 안 되는 수치다.
  const step = freq === "Q" ? 4 : freq === "A" ? 1 : freq === "D" || freq === "W" ? 52 : 12;
  const a = at(0), b = at(step), c = at(1), d = at(step + 1);
  return { value: a !== null && b ? r((a / b - 1) * 100) : null,
           prev:  c !== null && d ? r((c / d - 1) * 100) : null };
}

/**
 * 관측 기간을 **그 시리즈의 주기에 맞게** 표기한다.
 *  FRED 는 분기 시리즈를 그 분기의 **첫 달**로 날짜를 찍는다. 그대로 잘라 쓰면
 *  실질GDP 1분기가 "2026-01"(=1월)로 보인다 — 값은 맞는데 표기가 거짓말을 한다.
 *  일간 시리즈(Fed Funds)는 반대로 월까지만 찍으면 어느 날 값인지 사라진다.
 */
function periodLabel(date: string, freq: string): string {
  const [y, m] = date.split("-");
  if (freq === "Q") return `Q${Math.floor((Number(m) - 1) / 3) + 1} ${y}`;
  if (freq === "A") return y;
  if (freq === "D" || freq === "W") return date;   // 날짜 그대로 (일간·주간)
  return `${y}-${m}`;                              // 월간
}

/** 주요 거시 지표의 **실제 발표치** (연준 원본). 실패하면 마지막 값. */
export async function getMacroReadings(): Promise<MacroReading[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (failUntil > now) return cache?.data ?? [];
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const out: MacroReading[] = [];
      for (const s of FRED_SPECS) {
        // 분기 시리즈도 YoY 를 내려면 넉넉히 받는다
        const j = await fred(`/series/observations?series_id=${s.series}&sort_order=desc&limit=60`);
        const obs: Obs[] = (j?.observations ?? []).filter((o: Obs) => o.value !== ".");
        if (!obs.length) continue;
        const meta = await fred(`/series?series_id=${s.series}`);
        const freq = String(meta?.seriess?.[0]?.frequency_short ?? "M");
        const { value, prev } = convert(obs, s.transform, freq);
        out.push({
          key: s.key, label: s.label, value, prev, unit: s.unit,
          period: periodLabel(obs[0].date, freq),
          updated: String(meta?.seriess?.[0]?.last_updated ?? "").slice(0, 19),
          imp: s.imp, upIsHawkish: s.upIsHawkish
        });
      }
      if (!out.length) { failUntil = Date.now() + FAIL_MS; return cache?.data ?? []; }
      cache = { at: Date.now(), data: out };
      return out;
    } catch {
      failUntil = Date.now() + FAIL_MS;
      return cache?.data ?? [];
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

// ── 발표 일정 ──────────────────────────────────
export type MacroRelease = { name: string; date: string; imp: number };

let relCache: { at: number; data: MacroRelease[] } | null = null;

/**
 * 주요 지표의 **다음 발표일**.
 * FRED 의 releases/dates 는 노이즈가 많아서(Coinbase·Dow Jones 등 일일 갱신물)
 * 우리가 쓰는 릴리즈 id 로만 좁힌다.
 *
 * ★ 일간·주간 시리즈는 **여기 넣지 않는다.**
 *   실측 사고: "Fed Funds Rate 07-27" 이 UPCOMING 에 5★로 떴다. 시청자는 당연히
 *   "오늘 연준 결정"으로 읽지만, releaseId 18 은 "H.15 Selected Interest Rates" —
 *   매일 나오는 금리 통계다(DFF 주기 = Daily). 실제 FOMC 결정은 7/29 였다.
 *   매일 발표되는 통계에 '다음 발표일'은 이벤트가 아니다. 스펙에 하드코딩하지 않고
 *   **시리즈 주기로 판정**한다 — 나중에 지표를 추가해도 같은 실수가 반복되지 않는다.
 *   (FOMC 일정을 주는 무료 소스가 없으므로 없는 걸 지어내지 않고 그냥 뺀다)
 */
export async function getMacroReleases(days = 14): Promise<MacroRelease[]> {
  const now = Date.now();
  if (relCache && now - relCache.at < TTL_MS) return relCache.data;

  const start = new Date(now).toISOString().slice(0, 10);
  const end = new Date(now + days * 864e5).toISOString().slice(0, 10);
  const seen = new Set<number>();
  const out: MacroRelease[] = [];

  for (const s of FRED_SPECS) {
    if (seen.has(s.releaseId)) continue;   // 고용/실업률처럼 같은 릴리즈를 공유한다
    seen.add(s.releaseId);

    // 주기가 일간·주간이면 '예정 발표'라는 개념이 성립하지 않는다 → 일정에서 제외
    const meta = await fred(`/series?series_id=${s.series}`);
    const freq = String(meta?.seriess?.[0]?.frequency_short ?? "M").toUpperCase();
    if (freq === "D" || freq === "W") {
      console.warn(`[fred] ${s.label}(${s.series}) 은 ${freq} 주기 — 일정 목록에서 제외`);
      continue;
    }
    // ★ include_release_dates_with_no_data + realtime 범위를 **미래로** 열어야
    //   '예정' 발표일이 나온다. 이걸 빼면 과거 발표일만 돌아와 목록이 빈다(실측).
    const j = await fred(
      `/release/dates?release_id=${s.releaseId}&include_release_dates_with_no_data=true` +
      `&realtime_start=${start}&realtime_end=${end}&limit=4&sort_order=asc`
    );
    for (const d of j?.release_dates ?? []) {
      if (d?.date >= start && d?.date <= end) {
        out.push({ name: s.label, date: d.date, imp: s.imp });
        break;   // 릴리즈당 가장 가까운 1건만
      }
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.imp - a.imp));
  relCache = { at: now, data: out };
  return out;
}
