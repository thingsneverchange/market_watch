// ============================================================
//  티커 대조 — "이 심볼이 정말 그 회사인가"
//
//  왜 필요한가:
//   LLM 이 고른 주제에 티커가 붙으면 화면은 그 티커로 실시간 시세를 조회해 옆에 % 를 찍는다.
//   티커가 틀리면 **남의 회사 등락률이 그 주제의 것처럼 방송된다.**
//   형식 검사(`^[A-Z][A-Z.]{0,5}$`)로는 못 막는다 — 철자가 그럴듯하면 전부 통과한다.
//
//  ── 실측으로 확인한 두 가지 위험 (Finnhub /stock/profile2) ──
//   1) 지어낸 심볼:  SPXQ, ZQQZ → `{}`  (등록된 회사가 없다)
//      → 응답이 비면 그 티커는 버린다. 이건 확실하게 걸러진다.
//   2) 실재하지만 **다른 회사**:  SPCE → "Virgin Galactic Holdings"
//      SPCX(=SpaceX) 와 한 글자 차이인데다 둘 다 우주 회사라 헷갈리기 쉽다.
//      심볼이 실재하므로 1)로는 못 잡는다 → 상호를 대조해야 한다.
//
//  ── 대조를 '기본 통과'로 두는 이유 ────────────────────
//   통칭과 법인명은 자주 다르다. 실측:
//     SpaceX  → "Space Exploration Technologies Corp"
//     NVDA    → "NVIDIA Corp"
//     MU      → "Micron Technology Inc"
//   엄격히 일치를 요구하면 **맞는 티커를 떨어뜨린다**(SpaceX 가 실제로 그랬다).
//   그래서 규칙을 뒤집었다: 실재하는 회사면 통과시키되, **명백히 다른 회사일 때만** 거부한다.
//   판정은 '고유 낱말'로 한다 — technology·energy 같은 업종 낱말이 겹치는 건 근거가 아니다.
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
 * 업종·형태를 나타낼 뿐 회사를 특정하지 못하는 낱말.
 * 이게 겹친다고 같은 회사라고 볼 수 없다 — Micron Technology 와 Marvell Technology 는 다르다.
 */
const GENERIC = new Set([
  "technology", "technologies", "tech", "systems", "solutions", "industries", "international",
  "energy", "electric", "power", "resources", "materials", "chemical", "chemicals",
  "financial", "finance", "bank", "bancorp", "capital", "partners", "investments", "trust",
  "communications", "media", "networks", "semiconductor", "semiconductors", "micro",
  "pharmaceutical", "pharmaceuticals", "pharma", "health", "healthcare", "sciences", "biosciences",
  "motors", "airlines", "air", "stores", "brands", "products", "services", "global", "national",
  "american", "america", "united", "general", "first", "new", "north", "south", "east", "west"
]);

/**
 * 통칭과 법인명이 **글자 하나 안 겹치는** 소수 사례.
 * 이건 문자열 규칙으로는 원리적으로 못 푼다 — "Google↔Alphabet" 과
 * "SpaceX↔Virgin Galactic"(다른 회사)은 둘 다 겹침이 0이라 구분이 불가능하다.
 * 그래서 아는 것만 명시적으로 적어 둔다. 추측하지 않는다.
 */
const ALIAS: Record<string, string> = {
  google: "alphabet",
  facebook: "meta",
  instagram: "meta",
  spacex: "space",        // "Space Exploration Technologies"
  starlink: "space"
};

/** 회사를 특정하는 낱말만 남긴다 (3자 이하·업종 낱말 제외) + 알려진 통칭 확장 */
function distinctive(name: string): string[] {
  const words = normCo(name).split(" ").filter((w) => w.length >= 4 && !GENERIC.has(w));
  const out = [...words];
  for (const w of words) if (ALIAS[w]) out.push(ALIAS[w]);
  return out;
}

/**
 * LLM 이 주장한 상호가 거래소 등록 상호와 같은 회사로 볼 수 있는가?
 *
 *  · registered 가 null 이면 **조회 실패** → false. 모르면 시세를 붙이지 않는다.
 *  · registered 가 "" 이면 그 심볼에 등록된 회사가 없다(지어낸 심볼) → false.
 *  · 실재하는 회사면 기본은 통과. 단, 양쪽의 고유 낱말이 **하나도 안 겹치면** 거부한다
 *    (SPCE="Virgin Galactic" 에 "SpaceX" 를 주장하는 경우).
 *  · 한쪽에 고유 낱말이 없으면(전부 업종 낱말이면) 판정하지 않고 통과시킨다 —
 *    근거 없이 맞는 티커를 떨어뜨리지 않기 위해서다.
 */
export function companyMatches(claimed: string, registered: string | null | undefined): boolean {
  if (registered == null || !String(registered).trim()) return false;
  const a = normCo(claimed);
  const b = normCo(registered);
  if (!a || !b) return false;
  if (a === b) return true;

  const da = distinctive(claimed);
  const db = distinctive(registered);
  if (!da.length || !db.length) return true; // 판정 근거 없음 → 통과

  // 한쪽 낱말이 다른 쪽 낱말의 앞부분이면 같은 회사로 본다.
  //   "spacex" ↔ "space"(exploration technologies), "micron" ↔ "micron"
  // 접두 비교라 통칭/법인명 차이를 흡수하면서, 무관한 회사끼리는 걸리지 않는다.
  for (const x of da) {
    for (const y of db) {
      if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
    }
  }
  return false;
}
