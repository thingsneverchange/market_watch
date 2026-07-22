// ============================================================
//  ET(미 동부시간) → UTC epoch 변환
//
//  ※ 이 로직은 감사에서 90개 케이스(DST 경계·연말·윤년 전 구간) 검증을 통과했다.
//     동작을 바꾸지 말 것. calendar 와 digest 두 곳에서 쓰게 되어 공용으로 뺐을 뿐이다.
// ============================================================

/** 주어진 (날짜, ET시각)을 정확한 UTC epoch(ms)로. 미 동부 서머타임 자동 반영. */
export function etToEpoch(dateStr: string, etHour: number, etMin: number): number {
  // 해당 날짜 정오 UTC를 기준으로 America/New_York 오프셋을 실측
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const etStr = probe.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  const utcStr = probe.toLocaleString("en-US", { timeZone: "UTC", hour12: false });
  // 두 표기의 시(hour) 차이 = ET 오프셋 (음수: UTC보다 뒤)
  const etH = Number(etStr.split(" ")[1].split(":")[0]);
  const utcH = Number(utcStr.split(" ")[1].split(":")[0]);
  let offset = etH - utcH; // 예: EDT면 -4, EST면 -5
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  // ET시각을 UTC로: UTC = ET - offset
  const base = Date.parse(`${dateStr}T00:00:00Z`);
  return base + (etHour - offset) * 3600e3 + etMin * 60e3;
}

/**
 * 실적 시각 **추정**: bmo=08:00 ET, amc=16:30 ET, 미정=12:00 ET
 * 카운트다운 표시에 쓴다. 실제 발표는 이보다 이를 수 있다.
 */
export function earnEpoch(dateStr: string, hour: string): number {
  if (hour === "bmo") return etToEpoch(dateStr, 8, 0);
  if (hour === "amc") return etToEpoch(dateStr, 16, 30);
  return etToEpoch(dateStr, 12, 0);
}

/**
 * "이 시각이 지났으면 이미 발표됐다고 봐야 하는" 경계.
 *
 * earnEpoch 와 일부러 다르다. amc 실적은 대부분 16:01~16:20 ET 에 나오는데
 * 추정치 16:30 을 그대로 쓰면 **이미 나온 실적을 '예정'으로 표시**한다
 * (실제로 GOOGL·TSLA 에서 이 문제를 겪었다).
 * 발표 여부 판정은 장 마감(16:00) 기준으로 앞당겨 잡는다.
 */
export function earnPendingFrom(dateStr: string, hour: string): number {
  if (hour === "bmo") return etToEpoch(dateStr, 7, 0);   // 장전 발표는 07:00 부터
  if (hour === "amc") return etToEpoch(dateStr, 16, 0);  // 장 마감과 동시에
  return etToEpoch(dateStr, 16, 0);                       // 시각 미정이면 그날 장 마감 기준
}
