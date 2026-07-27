// ============================================================
//  FRED 관측치 → 시장이 보는 수치로 변환 (순수 함수)
//
//  fred.ts 에서 떼어냈다. 저기는 $env 를 import 해서 테스트에서 통째로 못 읽는다.
//  **방송에 5★ 로 나가는 숫자를 만드는 코드**라 회귀 테스트가 붙어야 한다.
//
//  ── 실측 사고: CPI 가 3.73% 로 나갔다 (실제 발표 3.5%) ──
//   원인은 계산식이 아니라 **결측 처리와 위치 인덱스의 조합**이었다.
//     FRED 원본 CPIAUCSL 에 2025-10-01 이 결측(".")이다.
//     호출부가 결측을 배열에서 제거 → 배열이 압축됨
//     convert() 가 "1년 전"을 index 12 로 찾음 → 2025-05 (13개월 전)에 도달
//     332.568 / 320.620 = 3.73%   (올바른 값: 332.568 / 321.435 = 3.46%)
//   prev 도 같은 이유로 4.27% (올바른 값 4.17%)라, 둔화 폭이 −0.54%p 로 읽혔다.
//   실제는 −0.71%p 다. 이중 오류였다.
//
//   위치 인덱스는 "결측이 없다"를 전제한다. 그 전제가 깨지면 조용히 틀린 값을 낸다 —
//   에러도 안 나고 그럴듯한 숫자라 화면에서 알아챌 방법이 없다.
//   → **날짜로 찾는다.** 그 날짜가 없으면 계산하지 않고 null 을 낸다.
//     화면은 "—"를 띄운다. 틀린 숫자보다 빈칸이 낫다.
// ============================================================

export type Transform = "yoy" | "mom" | "level" | "delta_k";
export type Obs = { date: string; value: string };

/**
 * 관측일에서 n개월 전 날짜.
 *  FRED 의 월간·분기 시리즈는 그 기간의 **첫날**로 날짜가 찍히므로 항상 "-01" 이다.
 */
export function monthsBefore(date: string, n: number): string {
  const [y, m] = date.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return "";
  const total = y * 12 + (m - 1) - n;
  const yy = Math.floor(total / 12);
  const mm = (total % 12 + 12) % 12 + 1;
  return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-01`;
}

/**
 * 관측치를 시장이 보는 수치로 변환한다 (지수 레벨 그대로는 방송에 못 쓴다).
 *
 * @param obs  **최신순**으로 정렬된 관측치. 결측은 호출부에서 이미 제거됐을 수 있다
 *             (그래서 위치가 아니라 날짜로 찾는다).
 * @param freq FRED 의 frequency_short — "M" | "Q" | "A" | "D" | "W"
 */
export function convert(
  obs: Obs[], t: Transform, freq: string
): { value: number | null; prev: number | null } {
  const by = new Map(obs.map((o) => [o.date, Number(o.value)]));
  const val = (d: string | null): number | null => {
    if (!d) return null;
    const v = by.get(d);
    return Number.isFinite(v) ? (v as number) : null;
  };
  const r = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

  const base = obs[0]?.date ?? null;
  if (!base) return { value: null, prev: null };

  // 일간·주간 시리즈엔 월 산술이 성립하지 않는다 (Fed Funds 같은 것).
  // 이들은 level 변환만 쓰므로 "직전 발표치" = 위치 인덱스가 정확하다.
  const daily = freq === "D" || freq === "W";
  const monthsPerPeriod = freq === "Q" ? 3 : freq === "A" ? 12 : 1;

  /** n기간 전의 날짜 */
  const back = (periods: number): string | null =>
    daily ? (obs[periods]?.date ?? null) : monthsBefore(base, monthsPerPeriod * periods);
  /** n기간 전 시점의 **1년 전** 날짜 */
  const yearAgo = (periods = 0): string | null =>
    daily ? null : monthsBefore(base, monthsPerPeriod * periods + 12);

  if (t === "level") return { value: r(val(base)), prev: r(val(back(1))) };

  if (t === "delta_k") {
    const a = val(base), b = val(back(1)), c = val(back(2));
    return {
      value: a !== null && b !== null ? Math.round(a - b) : null,
      prev: b !== null && c !== null ? Math.round(b - c) : null
    };
  }

  if (t === "mom") {
    const a = val(base), b = val(back(1)), c = val(back(2));
    return {
      value: a !== null && b ? r((a / b - 1) * 100) : null,
      prev: b !== null && c ? r((b / c - 1) * 100) : null
    };
  }

  // yoy — ★ 여기가 사고 지점이었다. 이제 **날짜로** 1년 전을 찾는다.
  //   그 날짜가 결측이면 null 을 낸다. 옆 관측치로 대신하지 않는다 —
  //   그게 바로 3.73% 를 만든 동작이다.
  const a = val(base), b = val(yearAgo(0));
  const c = val(back(1)), d = val(yearAgo(1));
  return {
    value: a !== null && b ? r((a / b - 1) * 100) : null,
    prev: c !== null && d ? r((c / d - 1) * 100) : null
  };
}
