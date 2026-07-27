import { env } from "$env/dynamic/private";
// 변환 로직은 별도 모듈이다 — $env 를 물지 않아야 회귀 테스트가 붙는다 (fredmath.ts 주석 참고)
import { convert, type Transform, type Obs } from "./fredmath";

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

/**
 * 시리즈 주기 캐시.
 *  ★ 주기는 **정적 메타데이터**다 (CPI 가 어느 날 갑자기 일간이 되지 않는다).
 *   그런데 매번 다시 물었고, 그 호출이 실패하면 `?? "M"` 으로 **추측**했다.
 *   실측: 프로덕션 콜드스타트에서 DFF(일간)의 메타 호출이 실패해
 *     기간 표기  "2026-07-23" → "2026-07"
 *     직전 값    전일(3.63)  → 한 달 전(3.62)
 *   둘 다 에러 없이 조용히 틀렸다. 추측한 주기로 계산하면 그런 일이 난다.
 *   → 한 번 성공하면 기억하고, 모르면 **추측하지 않고 건너뛴다.**
 */
const freqCache = new Map<string, string>();

async function seriesMeta(series: string): Promise<{ freq: string; updated: string } | null> {
  const meta = await fred(`/series?series_id=${series}`);
  const f = String(meta?.seriess?.[0]?.frequency_short ?? "").toUpperCase();
  const updated = String(meta?.seriess?.[0]?.last_updated ?? "").slice(0, 19);
  if (f) { freqCache.set(series, f); return { freq: f, updated }; }
  const known = freqCache.get(series);
  return known ? { freq: known, updated } : null;   // 모르면 null — 추측하지 않는다
}

/** 주요 거시 지표의 **실제 발표치** (연준 원본). 실패하면 마지막 값. */
export async function getMacroReadings(): Promise<MacroReading[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (failUntil > now) return cache?.data ?? [];
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      // ★ 지표 하나가 실패했다고 그 행이 화면에서 **사라지면 안 된다.**
      //   실측: NFP 의 관측치 호출이 한 번 실패하자 US ECONOMY 에서 통째로 증발했다.
      //   시청자에겐 "고용 지표가 없는 화면"이 되고, 왜 없는지도 알 수 없다.
      //   → 실패한 지표는 **직전 성공값을 유지**한다. 나이는 updated 필드가 이미 말한다.
      const prevByKey = new Map((cache?.data ?? []).map((r) => [r.key, r]));
      const out: MacroReading[] = [];
      let fresh = 0;

      for (const s of FRED_SPECS) {
        const keep = () => { const old = prevByKey.get(s.key); if (old) out.push(old); };

        // 분기 시리즈도 YoY 를 내려면 넉넉히 받는다
        const j = await fred(`/series/observations?series_id=${s.series}&sort_order=desc&limit=60`);
        const obs: Obs[] = (j?.observations ?? []).filter((o: Obs) => o.value !== ".");
        if (!obs.length) { console.warn(`[fred] ${s.label} 관측치 실패 — 직전 값 유지`); keep(); continue; }

        const meta = await seriesMeta(s.series);
        if (!meta) { console.warn(`[fred] ${s.label} 주기 미확인 — 추측하지 않고 직전 값 유지`); keep(); continue; }

        const { value, prev } = convert(obs, s.transform, meta.freq);
        out.push({
          key: s.key, label: s.label, value, prev, unit: s.unit,
          period: periodLabel(obs[0].date, meta.freq),
          updated: meta.updated,
          imp: s.imp, upIsHawkish: s.upIsHawkish
        });
        fresh++;
      }

      // 하나도 새로 못 받았으면 실패로 보고 백오프 (옛 값은 그대로 쓴다)
      if (!fresh) { failUntil = Date.now() + FAIL_MS; return cache?.data ?? []; }
      // 부분 성공이어도 캐시를 갱신한다 — 유지된 행이 다음 호출에서도 살아남아야 한다
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

    // 주기가 일간·주간이면 '예정 발표'라는 개념이 성립하지 않는다 → 일정에서 제외.
    // ★ 여기서도 추측하면 안 된다. `?? "M"` 이면 메타 호출이 한 번 실패했을 때
    //   DFF(일간)가 월간으로 오인돼 "Fed Funds Rate 07-27" 이 5★로 되살아난다 —
    //   시청자는 "오늘 연준 결정"으로 읽지만 실제 FOMC 는 7/29 였다.
    //   모르면 이번 회차에서 빼는 게 맞다. 일정 한 줄이 비는 것보다 오보가 나쁘다.
    const meta = await seriesMeta(s.series);
    if (!meta) { console.warn(`[fred] ${s.label} 주기 미확인 — 이번 일정에서 제외`); continue; }
    if (meta.freq === "D" || meta.freq === "W") {
      console.warn(`[fred] ${s.label}(${s.series}) 은 ${meta.freq} 주기 — 일정 목록에서 제외`);
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
