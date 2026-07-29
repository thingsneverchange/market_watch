import type { FutQuote } from "./finviz";
import { futuresSession } from "../market-hours";

// ============================================================
//  TAPE READ — "지금 이 테이프가 무엇을 하고 있나"
//
//  ── 왜 필요했나 ───────────────────────────────────
//  사용자 지적: "나스닥이 지금 떨어지고 있는데 그거에 대한 얘기는 없음."
//  맞았다. 실측(2026-07-27 10:00 ET):
//     헤더    NASDAQ 100 +0.23%  (초록)
//     실제    NQ 최근 30분 −0.56%,  z 2.1,  방향 아래
//  화면의 모든 숫자가 **당일 누적**이라 "지금 밀리고 있다"를 말할 자리가 아예 없었다.
//  서사 계층(TOP STORY·MARKET FOCUS)은 2~4시간 주기라 장중 반응이 구조적으로 불가능하다.
//
//  ★ 핵심: 이건 임계값 문제가 아니었다. **화면에 그 자리가 없었던 것**이다.
//    그래서 이 밴드는 조용할 때도 사라지지 않는다. 조용하면 조용하다고 쓰되
//    최근 30분 숫자는 언제나 보여 준다. "화면이 지난 30분에 대해 침묵하는 상태"를 없앤다.
//
//  ── 추가 요청 0 ───────────────────────────────────
//  이미 /api/boards 가 매 틱 부르는 getFutures("m5") 결과를 인자로 받는다.
//  LLM 호출도 없다. 전부 산술이라 장중에 즉시 반응한다.
//
//  ── 격자 정렬을 반드시 먼저 본다 ──────────────────
//  Finviz 의 "5분봉"은 종목마다 간격이 다르다. 실측:
//    NQ ES YM ER2 CL GC ZN DX QA … 5.00분/봉   BTC 5.22 · RB 5.54 · HO 5.71 · VX/NKD 5.90
//  정렬을 확인하지 않고 "같은 30분"이라고 비교하면 절반 이상이 거짓이 된다.
//  → NQ 와 봉 간격·지연이 같은 종목만 한 코호트로 묶는다.
//
//  ── 인과는 말하지 않는다 ─────────────────────────
//  가진 데이터로는 "왜 떨어지는지" 알 수 없다. 같은 창에서 함께 움직였다는 사실뿐이다.
//  breaking/+server.ts 가 z-score 사이렌에 대해 이미 세운 원칙과 같다.
//  표현은 BEYOND / -LED / BROAD 까지만 쓴다. BECAUSE·DRIVEN BY·AS 는 쓰지 않는다.
//
//  ── 반도체를 장중 원인으로 지목하지 않는 이유 ─────
//  SOXX 는 Finnhub /quote 라 **당일 등락 한 숫자뿐**이고 시계열이 없다(/stock/candle 은 403).
//  Finviz 선물 49종에 반도체 상품이 없다. 즉 "지금 반도체가 끌어내리고 있다"는
//  측정할 방법이 아예 없다. 당일 기준 SOXX−QQQ 격차만이 정직하고, 그건 30분 움직임을
//  설명하지 못한다. 그래서 이 모듈은 지수 간 관계(NQ vs ES)만 말한다.
// ============================================================

const K = 6;                    // 최근 6봉
const MIN_SIGMA = 1e-5;
/** 이보다 작으면 "움직였다"고 강조하지 않는다 (숫자는 그래도 보여 준다) */
const MOVE_MIN_PCT = 0.25;
const MOVE_MIN_Z = 1.8;
/** 잔차로 "나스닥만 따로 간다"를 주장하려면 이 정도는 돼야 한다 */
const EXCESS_MIN_Z = 2.0;
const EXCESS_MIN_PCT = 0.1;
/** 베타 추정이 의미 있으려면 두 지수가 실제로 같이 움직여야 한다 */
const MIN_CORR = 0.7;

const CLOCK: Record<string, number> = {
  "12AM": 0, "2AM": 120, "4AM": 240, "6AM": 360, "8AM": 480, "10AM": 600,
  "12PM": 720, "2PM": 840, "4PM": 960, "6PM": 1080, "8PM": 1200, "10PM": 1320
};

export type TapeRow = { name: string; pct: number };

export type TapeRead = {
  tier: "moving" | "quiet" | "closed" | "warming" | "nodata";
  /** closed·warming·nodata 일 때 화면에 찍을 사유 */
  reason: string;
  /** 최근 K봉이 실제로 덮는 분. 30 이라고 가정하지 않는다 */
  windowMin: number | null;
  /** 언제나 채운다 — 조용해도 지난 구간 숫자는 보여 준다 */
  rows: TapeRow[];
  /** moving 일 때 주인공 */
  subject: string | null;
  subjectPct: number | null;
  /** "NASDAQ-LED · S&P −0.26%" 또는 "BROAD · 4/4 DOWN". 인과 표현은 쓰지 않는다 */
  shape: string | null;
  /**
   * "GAVE BACK 47% OF TODAY'S GAIN" — 헤더가 왜 멀쩡해 보이는지 설명하는 한 줄.
   * 당일 누적은 여전히 플러스인데 30분 전보다 나빠진 상황이 정확히 이 경우다.
   */
  giveback: string | null;
};

const INDEXES: [string, string][] = [["NQ", "NASDAQ"], ["ES", "S&P"], ["YM", "DOW"], ["ER2", "RUSSELL"]];

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * 봉 간격(분)·마지막 시각마크로부터의 지연(봉)·**최근 창의 연속성**.
 *
 * ★ 연속성을 따로 보는 이유:
 *   스파크라인은 그냥 배열이라 **거래가 멈춘 구간이 그대로 이어 붙는다.**
 *   일요일 18:05 ET 기준 마지막 6봉은
 *     [금 16:35, 16:40, 16:45, 16:50, 일 18:00, 18:05]
 *   이고 그 사이엔 49시간이 들어 있다. 마지막 두 마크만 보고 "5분/봉" 이라 믿으면
 *   **주말 갭을 30분 움직임으로 방송**하게 된다. 매일 17–18시 ET 정비시간도 같다.
 *   그래서 마크 구간을 전부 계산해 **최빈 간격**을 구하고, 최근 창 안에 그보다
 *   크게 벌어진 구간이 있으면 판정을 포기한다.
 */
function grid(q: FutQuote): { mpb: number; lag: number; anchor: string; contiguous: boolean } | null {
  const pts = Object.entries(q.marks ?? {})
    .map(([i, l]) => ({ i: Number(i), l: String(l) }))
    .filter((p) => Number.isInteger(p.i) && p.l in CLOCK)
    .sort((a, b) => a.i - b.i);
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const bars = b.i - a.i;
  if (bars <= 0) return null;
  const mpb = (((CLOCK[b.l] - CLOCK[a.l]) + 1440) % 1440) / bars;
  if (!Number.isFinite(mpb) || mpb <= 0) return null;

  // 구간별 간격을 전부 계산해 최솟값을 "정상 간격"으로 본다.
  // (갭이 낀 구간만 크게 나오므로 최솟값이 곧 실제 봉 간격이다)
  let normal = mpb;
  for (let i = 1; i < pts.length; i++) {
    const nb = pts[i].i - pts[i - 1].i;
    if (nb <= 0) continue;
    const m = (((CLOCK[pts[i].l] - CLOCK[pts[i - 1].l]) + 1440) % 1440) / nb;
    if (Number.isFinite(m) && m > 0 && m < normal) normal = m;
  }
  // 최근 창(마지막 K봉)이 걸쳐 있는 마크 구간 중 정상 간격의 1.5배를 넘는 게 있으면 갭이다
  const n = q.spark.length;
  const winStart = n - 1 - K;
  let contiguous = true;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].i < winStart) continue;               // 창 밖 구간은 볼 필요 없다
    const nb = pts[i].i - pts[i - 1].i;
    if (nb <= 0) continue;
    const m = (((CLOCK[pts[i].l] - CLOCK[pts[i - 1].l]) + 1440) % 1440) / nb;
    if (Number.isFinite(m) && m > normal * 1.5) { contiguous = false; break; }
  }
  return { mpb, lag: n - 1 - b.i, anchor: b.l, contiguous };
}

type Leg = { key: string; name: string; pct: number; z: number; rets: number[] };

function leg(q: FutQuote, name: string): Leg | null {
  const s = q.spark.filter((n) => Number.isFinite(n) && n > 0);
  if (s.length < K + 30) return null;
  const rets: number[] = [];
  for (let i = 1; i < s.length; i++) rets.push(Math.log(s[i] / s[i - 1]));
  const base = rets.slice(0, Math.max(10, rets.length - K));  // 최근 구간 제외 (자기 오염 방지)
  const sigma = Math.max(stdev(base), MIN_SIGMA);
  const last = s[s.length - 1], prev = s[s.length - 1 - K];
  if (!prev) return null;
  const r = Math.log(last / prev);
  const z = r / (sigma * Math.sqrt(K));
  if (!Number.isFinite(z)) return null;
  return { key: q.key, name, pct: (last / prev - 1) * 100, z, rets };
}

const blank = (tier: TapeRead["tier"], reason: string): TapeRead => ({
  tier, reason, windowMin: null, rows: [], subject: null, subjectPct: null, shape: null, giveback: null
});

const fmt = (p: number) => `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`;

/**
 * @param fut  이미 받아 둔 getFutures("m5") 결과 (추가 요청 없음)
 */
export function getTapeRead(fut: Map<string, FutQuote>): TapeRead {
  const sess = futuresSession();
  // 휴장 중엔 "최근 30분"이 최근이 아니다 — 금요일 마감 직전 30분이다.
  // movers.ts 가 Auto-Sniper 에 대해 이미 하는 것과 같은 거부.
  if (!sess.open) return blank("closed", sess.label || "TAPE CLOSED");

  const nq = fut.get("NQ");
  if (!nq) return blank("nodata", "NO TAPE DATA");
  const g0 = grid(nq);
  if (!g0) return blank("nodata", "NO TAPE DATA");
  // 재개장 직후엔 최근 창이 휴장 구간을 물고 있다 → 봉이 충분히 쌓일 때까지 아무 말도 안 한다.
  // tape.ts 는 원래 warming 티어를 설계해 뒀는데 판정이 연결돼 있지 않았다.
  if (!g0.contiguous) return blank("warming", "TAPE REOPENED — WARMING UP");
  const windowMin = Math.round(g0.mpb * K);

  // 격자 정렬 — NQ 와 같은 간격·지연인 것만 같은 창으로 인정한다
  const aligned = new Map<string, FutQuote>();
  for (const [k, q] of fut) {
    const g = grid(q);
    if (g && g.contiguous && g.mpb === g0.mpb && g.lag === g0.lag && g.anchor === g0.anchor) aligned.set(k, q);
  }

  const legs: Leg[] = [];
  for (const [key, name] of INDEXES) {
    const q = aligned.get(key);
    const l = q ? leg(q, name) : null;
    if (l) legs.push(l);
  }
  const nqLeg = legs.find((l) => l.key === "NQ");
  if (!nqLeg) return blank("nodata", "NO TAPE DATA");

  const rows: TapeRow[] = legs
    .filter((l) => l.key !== "ER2")   // 화면엔 주요 3지수만. 러셀은 폭 판정에만 쓴다
    .map((l) => ({ name: l.name, pct: Math.round(l.pct * 100) / 100 }));

  // ── 당일 되돌림 — 헤더가 왜 멀쩡해 보이는지 설명하는 값 ──
  let giveback: string | null = null;
  const s = nq.spark.filter((n) => Number.isFinite(n) && n > 0);
  if (nq.prevClose && s.length > K) {
    const dayNow = (s[s.length - 1] / nq.prevClose - 1) * 100;
    const dayThen = (s[s.length - 1 - K] / nq.prevClose - 1) * 100;
    // 같은 방향으로 여전히 플러스(또는 마이너스)인데 폭이 줄어든 경우만 "되돌렸다"고 말한다
    if (Math.sign(dayNow) === Math.sign(dayThen) && Math.abs(dayThen) > 0.1 && Math.abs(dayNow) < Math.abs(dayThen)) {
      const back = Math.round((1 - Math.abs(dayNow) / Math.abs(dayThen)) * 100);
      // ★ 방향에 따라 말이 완전히 다르다.
      //   상승분이 줄면 "되돌렸다"(GAVE BACK), 하락분이 줄면 "회복했다"(RECOVERED).
      //   실측에서 "GAVE BACK 45% OF TODAY'S DROP" 이 나왔는데, 하락폭이 줄어든 걸
      //   되돌렸다고 쓰면 정반대로 읽힌다.
      if (back >= 20) {
        giveback = dayThen > 0
          ? `GAVE BACK ${back}% OF TODAY'S GAIN`
          : `RECOVERED ${back}% OF TODAY'S DROP`;
      }
    }
  }

  const moving = Math.abs(nqLeg.pct) >= MOVE_MIN_PCT && Math.abs(nqLeg.z) >= MOVE_MIN_Z;
  if (!moving) {
    return { tier: "quiet", reason: "", windowMin, rows, subject: null, subjectPct: null, shape: null, giveback };
  }

  // ── 이게 나스닥만의 움직임인가, 시장 전체인가 ──
  let shape: string | null = null;
  const es = legs.find((l) => l.key === "ES");
  if (es) {
    const n = Math.min(nqLeg.rets.length, es.rets.length) - K;   // 최근 구간 제외
    const a = nqLeg.rets.slice(0, n), b = es.rets.slice(0, n);
    if (n >= 30) {
      const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
      let cov = 0, va = 0, vb = 0;
      for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
      const corr = cov / Math.sqrt(va * vb || 1);
      const beta = cov / (vb || 1);
      // 베타가 터무니없으면 잔차는 의미가 없다 → 폭(breadth)으로만 말한다
      if (corr >= MIN_CORR && beta >= 0.8 && beta <= 2.5) {
        const rNq = Math.log(1 + nqLeg.pct / 100), rEs = Math.log(1 + es.pct / 100);
        const e = rNq - beta * rEs;
        const resid = a.map((x, i) => x - beta * b[i]);
        const zE = e / (Math.max(stdev(resid), MIN_SIGMA) * Math.sqrt(K));
        const excessPct = (Math.exp(e) - 1) * 100;
        // ★ 화면엔 excessPct 만 찍는다. z 는 판단에만 쓴다 —
        //   실측상 excessPct 는 기준구간 길이를 바꿔도 안정적인데 z 는 크게 흔들린다.
        if (Math.abs(zE) >= EXCESS_MIN_Z && Math.abs(excessPct) >= EXCESS_MIN_PCT) {
          shape = `NASDAQ-LED · ${fmt(excessPct)} BEYOND S&P`;
        }
      }
    }
  }
  // ★ 코호트가 3개 미만이면 폭(breadth)을 **주장하지 않는다.**
  //   격자 정렬은 부동소수 3개의 정확한 일치를 요구하므로 코호트가 NQ 하나만 남을 수 있고,
  //   그때 예전 코드는 "SPLIT · 1/1 DOWN" 이라고 찍었다 — 1개로 폭을 말하는 건 무의미하다.
  if (!shape && legs.length >= 3) {
    const same = legs.filter((l) => Math.sign(l.pct) === Math.sign(nqLeg.pct) && Math.abs(l.pct) >= 0.1);
    shape = same.length === legs.length
      ? `BROAD · ${same.length}/${legs.length} ${nqLeg.pct >= 0 ? "UP" : "DOWN"}`
      : `SPLIT · ${same.length}/${legs.length} ${nqLeg.pct >= 0 ? "UP" : "DOWN"}`;
  }

  return {
    tier: "moving",
    reason: "",
    windowMin,
    rows,
    subject: nqLeg.name,
    subjectPct: Math.round(nqLeg.pct * 100) / 100,
    shape,
    giveback
  };
}
