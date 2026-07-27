import { getFutures, type FutQuote } from "./finviz";
import { futuresSession } from "../market-hours";

// ============================================================
//  급등·급락 탐지 (Auto-Sniper / "지금 시장이 보고 있는 것")
//
//  단순히 등락률이 큰 순으로 줄 세우면 안 된다. 원유는 평소에도 하루 3% 씩 움직이고
//  10년물은 0.3% 만 움직여도 대사건이다. **종목별 평소 변동성 대비 얼마나 이례적인가**
//  로 정규화해야 "지금 뭔가 터졌다"를 잡아낸다.
//
//  z = (최근 K봉 수익률) / (평소 5분 수익률 표준편차 × √K)
//
//  · sigma 는 **최근 구간을 빼고** 계산한다. 급등 중인 종목이 자기 급등으로 자기
//    기준선을 부풀리면 z 가 낮아져서 정작 사건을 놓친다.
//  · sigma 가 0 에 가까운 죽은 종목은 노이즈로 z 가 폭발하므로 하한을 둔다.
//  · 최소 절대 변동 조건도 같이 건다 — 통계적으로 이례적이어도 0.02% 면 방송할 게 없다.
// ============================================================

export type Mover = {
  key: string;
  label: string;
  price: number;
  changePct: number;      // 당일 등락률
  recentPct: number;      // 최근 K봉 변동
  z: number;              // 이례성 점수 (평소 대비 몇 배)
  dir: 1 | -1;
  /**
   * 최근 K봉이 **실제로** 덮는 분. null = 알 수 없음.
   *
   * ★ 예전엔 이 값을 K×5=30 으로 가정하고 화면에 "IN 30 MIN" 이라고 찍었다.
   *   그런데 Finviz 의 5분봉은 **종목마다 간격이 다르다**. 실측(2026-07-27 10:5x ET):
   *     NQ ES YM ER2 CL NG GC SI HG PL ZN ZB ZF DX QA → 5.00분/봉 (30분 맞음)
   *     BTC 5.22 → 31분 · RB 5.54 → 33분 · HO 5.71 → 34분 · VX 5.90 → 35분 · NKD 5.90 → 35분
   *   실제로 "Bitcoin −0.91% IN 30 MIN" 이 방송됐는데 그 구간은 31분이었다.
   *   작은 차이지만 화면이 틀린 숫자를 말한 건 맞다 → 종목별로 실제 구간을 계산해 싣는다.
   */
  windowMin: number | null;
};

const K = 6;              // 최근 6봉 = 30분
const MIN_ABS_PCT = 0.15; // 이보다 작게 움직였으면 사건이 아니다
const MIN_SIGMA = 1e-5;   // 죽은 종목의 z 폭발 방지

// ============================================================
//  ★ 방송에 띄울 가치가 있는 선물만 본다
//
//  Finviz 는 49개를 한 번에 주는데, 그중 농산물·축산·목재는 거래가 얇아서
//  z-score 가 잘 튄다. 그 결과 Auto-Sniper 추천과 급변 속보 상위가 이렇게 찼다:
//    Cotton, Coffee, Wheat, Lumber, Orange Juice, Feeder Cattle   (실측)
//  미국 증시 방송을 보는 사람 중에 코코아·옥수수·설탕 선물을 보러 온 사람은 없다.
//  통계적으로 이례적인 것과 **이 방송의 시청자에게 사건인 것**은 다르다.
//
//  남기는 기준: 미국 증시와 인과가 있는 것.
//   지수선물 — 그 자체가 시장
//   에너지  — 인플레이션·운송비로 바로 이어진다 (지금 국면의 핵심이기도 하다)
//   금속    — 금=위험프리미엄, 구리=경기
//   금리·달러 — 밸류에이션의 할인율
//   VIX·비트코인 — 위험선호도
// ============================================================
const WATCHED = new Set([
  // 지수선물
  "NQ", "ES", "YM", "ER2",
  // 에너지
  "CL", "BZ", "NG", "RB", "HO",
  // 금속
  "GC", "SI", "HG", "PL",
  // 금리 · 달러
  "ZN", "ZB", "ZF", "DX",
  // 변동성 · 크립토
  "VX", "BTC", "ETH",
  // 해외 지수선물 (야간 흐름을 읽는 데 쓴다)
  "NKD", "DY", "EX"
]);

// ★ 실측으로 확인한 것: 이 목록에 **Finviz 가 주지 않는 키**가 들어 있었다.
//   응답 키를 전수 확인한 결과 `BZ`(브렌트)와 `ETH` 는 아예 존재하지 않는다.
//   브렌트는 `QA` 로 온다 — 즉 에너지가 핵심인 지금 국면에서 브렌트가
//   Auto-Sniper 와 급변 속보에서 **조용히 빠져 있었다**. 없는 키는 아무 오류도
//   내지 않으므로 알아챌 방법이 없었다.
for (const k of ["QA"]) WATCHED.add(k);   // 브렌트 (BZ 가 아니다)
for (const k of ["BZ", "ETH"]) WATCHED.delete(k); // Finviz 미제공 — 목록에 남겨 두면 오해를 부른다

/** 스파크라인 마크의 시각 라벨 → 자정 기준 분 */
const CLOCK: Record<string, number> = {
  "12AM": 0, "2AM": 120, "4AM": 240, "6AM": 360, "8AM": 480, "10AM": 600,
  "12PM": 720, "2PM": 840, "4PM": 960, "6PM": 1080, "8PM": 1200, "10PM": 1320
};

/**
 * 이 종목의 봉 하나가 실제 몇 분인가. 시각 마크 두 개의 간격을 봉 수로 나눈다.
 * 마크가 부족하면 null — **5분이라고 가정하지 않는다**(그 가정이 위 버그를 만들었다).
 */
function minutesPerBar(marks: Record<number, string>): number | null {
  const pts = Object.entries(marks)
    .map(([i, l]) => ({ i: Number(i), l: String(l) }))
    .filter((p) => Number.isInteger(p.i) && p.l in CLOCK)
    .sort((a, b) => a.i - b.i);
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const bars = b.i - a.i;
  if (bars <= 0) return null;
  const mins = ((CLOCK[b.l] - CLOCK[a.l]) + 1440) % 1440;
  const mpb = mins / bars;
  return Number.isFinite(mpb) && mpb > 0 ? mpb : null;
}

/** 표본 표준편차 */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** 테스트에서 직접 부르기 위해 export 한다 */
export function score(q: FutQuote): Mover | null {
  const s = q.spark.filter((n) => Number.isFinite(n) && n > 0);
  if (s.length < K + 30) return null;   // 표본이 너무 적으면 판단하지 않는다

  // 5분 로그수익률
  const rets: number[] = [];
  for (let i = 1; i < s.length; i++) rets.push(Math.log(s[i] / s[i - 1]));

  // ★ 기준 변동성은 **최근 K봉을 제외하고** 잰다 (자기 급등에 기준선이 오염되지 않게)
  const baseline = rets.slice(0, Math.max(10, rets.length - K));
  const sigma = Math.max(stdev(baseline), MIN_SIGMA);

  const last = s[s.length - 1];
  const prev = s[s.length - 1 - K];
  if (!prev) return null;

  const r = Math.log(last / prev);
  const recentPct = (last / prev - 1) * 100;
  if (Math.abs(recentPct) < MIN_ABS_PCT) return null;

  const z = r / (sigma * Math.sqrt(K));
  if (!Number.isFinite(z)) return null;

  return {
    key: q.key,
    label: q.label,
    price: q.price,
    changePct: q.changePct,
    recentPct: Math.round(recentPct * 100) / 100,
    // 표시 상한 99 — 변동성이 거의 0 이던 종목이 갑자기 움직이면 z 가 수천까지 튄다.
    // "2378x normal" 은 방송 화면에서 정보가 아니라 오류처럼 보인다.
    z: Math.min(99, Math.round(Math.abs(z) * 10) / 10),
    dir: r >= 0 ? 1 : -1,
    windowMin: (() => {
      const mpb = minutesPerBar(q.marks ?? {});
      return mpb == null ? null : Math.round(mpb * K);
    })()
  };
}

/** 이례성 높은 순으로 정렬된 목록 */
export async function getMovers(): Promise<Mover[]> {
  const map = await getFutures("m5");
  const out: Mover[] = [];
  for (const q of map.values()) {
    // 농산물·축산 등은 아예 후보에서 뺀다 (WATCHED 주석 참고)
    if (!WATCHED.has(q.key)) continue;
    const m = score(q);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.z - a.z);
}

// ── Auto-Sniper 의 표적 유지 ────────────────────
//  방송 화면이 몇 초마다 종목을 갈아타면 볼 수가 없다.
//  한 번 잡으면 최소 시간 동안 유지하고, 그보다 확실히 더 센 사건이 와야 갈아탄다.
const HOLD_MS = 90_000;      // 최소 유지 시간
const SWITCH_MARGIN = 1.4;   // 갈아타려면 현재 표적보다 이만큼 더 세야 한다
const MIN_Z = 2.5;           // 이 미만이면 "사건"으로 보지 않는다

let target: { key: string; z: number; at: number } | null = null;

/**
 * 지금 물어야 할 표적. 조건에 맞는 사건이 없으면 null 을 반환하고,
 * 호출부는 사용자가 고른 차트를 그대로 둔다 (빈 슬롯을 만들지 않는다).
 */
export async function getSniperTarget(): Promise<Mover | null> {
  // ★ 장이 닫혀 있으면 "최근 30분 변동"은 최근이 아니다 — 금요일 마감 직전 30분이다.
  //   그걸 지금 터진 사건처럼 화면에 물리면 명백한 거짓말이 된다. 휴장 중엔 표적 없음.
  if (!futuresSession().open) { target = null; return null; }

  const movers = await getMovers();
  const top = movers.find((m) => m.z >= MIN_Z) ?? null;
  const now = Date.now();

  if (target) {
    const still = movers.find((m) => m.key === target!.key);
    const held = now - target.at < HOLD_MS;
    // 유지 시간 안이거나, 새 후보가 충분히 세지 않으면 표적을 바꾸지 않는다
    if (still && (held || !top || top.key === target.key || top.z < target.z * SWITCH_MARGIN)) {
      target = { key: still.key, z: Math.max(target.z, still.z), at: target.at };
      return still;
    }
  }

  if (!top) { target = null; return null; }
  target = { key: top.key, z: top.z, at: now };
  return top;
}
