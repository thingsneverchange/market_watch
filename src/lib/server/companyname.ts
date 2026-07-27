// ============================================================
//  상호 대조 — "이 티커가 정말 그 회사인가"
//
//  왜 이게 따로 있나:
//   LLM 이 고른 주제에 티커를 붙여 주면, 화면은 그 티커로 실시간 시세를 조회해
//   주제 옆에 % 를 찍는다. 티커가 틀리면 **남의 회사 등락률이 그 주제의 것처럼 방송된다.**
//   실제 사고: "SPACEX SHARE UNLOCK" 에 ticker="SPCX" 가 붙어 −1.85% 가 나갔다.
//   스페이스엑스는 비상장이라 티커가 있을 수 없고, SPCX 는 전혀 다른 종목이다.
//   형식 검사(`^[A-Z][A-Z.]{0,5}$`)로는 못 막는다 — 철자가 그럴듯하면 전부 통과한다.
//
//  그래서 LLM 에게 티커와 함께 **정식 상호**를 내게 하고, 거래소 등록 상호와 대조한다.
//  이 파일은 의존성이 없어(=$env 를 import 하지 않아) 테스트에서 그대로 불러 쓸 수 있다.
// ============================================================

/** 법인격 접미사·구두점·클래스 표기를 걷어낸 비교용 형태 */
export function normCo(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    // 접미사는 회사를 구별하지 않는다: "Micron Technology Inc" 와 "Micron Technology" 는 같다
    .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|nv|sa|ag|se|holdings?|group|the|adr|ord|shs)\b/g, " ")
    .replace(/\bclass [a-c]\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * LLM 이 주장한 상호가 거래소 등록 상호와 같은 회사인가?
 *
 *  · registered 가 null 이면 **확인 실패**(네트워크·예산) → false.
 *    "모르겠으면 붙이지 않는다". 틀린 시세를 방송하느니 % 를 비워 두는 게 낫다.
 *  · registered 가 "" 이면 그 심볼에 회사가 없다(비상장·상장폐지) → false.
 */
export function companyMatches(claimed: string, registered: string | null | undefined): boolean {
  if (registered == null || !String(registered).trim()) return false;
  const a = normCo(claimed);
  const b = normCo(registered);
  if (!a || !b) return false;
  if (a === b) return true;
  // 한쪽이 다른 쪽을 통째로 품는 경우: "nvidia" ⊂ "nvidia" / "micron technology" ⊃ "micron"
  // 단, 두 글자짜리 조각이 우연히 들어맞는 걸 막기 위해 짧은 쪽에 하한을 둔다.
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 4 && long.includes(short)) {
    // 낱말 경계에서만 인정한다 — "arm" 이 "pharma" 에 걸리는 식의 오탐 방지
    return new RegExp(`(^| )${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(long);
  }
  return false;
}
