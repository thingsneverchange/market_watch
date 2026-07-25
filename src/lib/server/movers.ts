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
  recentPct: number;      // 최근 K봉(기본 30분) 변동
  z: number;              // 이례성 점수 (평소 대비 몇 배)
  dir: 1 | -1;
};

const K = 6;              // 최근 6봉 = 30분
const MIN_ABS_PCT = 0.15; // 이보다 작게 움직였으면 사건이 아니다
const MIN_SIGMA = 1e-5;   // 죽은 종목의 z 폭발 방지

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
    dir: r >= 0 ? 1 : -1
  };
}

/** 이례성 높은 순으로 정렬된 목록 */
export async function getMovers(): Promise<Mover[]> {
  const map = await getFutures("m5");
  const out: Mover[] = [];
  for (const q of map.values()) {
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
