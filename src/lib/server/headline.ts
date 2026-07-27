// ============================================================
//  헤드라인 완결성 검사 — **방송 직전 관문**
//
//  왜 축약 규칙만 고쳐선 안 되나:
//   실제 사고. 원문은
//     "After Trump calls off bombing, Iran signals it will halt strikes as long as US does"
//   인데 화면엔 이것만 나갔다:
//     "After Trump calls off bombing"
//   이건 단순히 어색한 문장이 아니다. **없는 뉴스를 주장하는 것처럼 읽힌다** —
//   시청자는 "트럼프가 폭격을 취소했다"를 그 자체로 오늘의 헤드라인으로 받아들인다.
//   실제 뉴스(이란의 조건부 중단 신호)는 사라지고, 배경 사실 하나가 헤드라인 행세를 한다.
//   방송에서 이건 오보와 같은 무게다.
//
//  그래서 축약 로직을 고치는 것과 **별개로** 여기서 한 번 더 막는다:
//   · 축약 규칙은 새로운 문장 패턴을 만날 때마다 또 뚫린다 (실측으로만 발견된다)
//   · 파편을 만드는 경로가 하나가 아니다 — 규칙 축약, 길이 절단, 그리고 **Claude 생성문**
//   · 한 번 방송에 나간 문장은 이력(story-log)에 박제돼 계속 되돌아온다
//  경로마다 고치는 대신 출구 하나를 지킨다.
//
//  판정은 보수적으로 — **멀쩡한 헤드라인을 파편이라 부르는 쪽이 더 나쁘다**(화면이 빈다).
// ============================================================

/**
 * 종속접속사. 이걸로 시작하는 문장은 **주절이 따라와야** 완결된다.
 *  "After X, Y"  → 완결   |  "After X" → 미완성
 *  ※ "in"·"on"·"for" 같은 순수 전치사는 넣지 않는다. 정상 헤드라인도 흔히 그렇게 시작한다
 *    ("In a first, ...", "On Wall Street, ...").
 */
const SUBORDINATOR =
  /^(?:after|as|amid|while|when|whenever|before|since|once|though|although|because|until|unless|despite|following|ahead of|now that|in the wake of|on the heels of|if)\b/i;

/** 이런 단어로 끝나면 문장이 허공에 뜬다 — 뒤에 뭔가 더 있어야 한다 */
const DANGLING_END =
  /\b(?:at|in|on|of|for|to|with|from|by|and|or|the|a|an|as|its|his|her|their|that|than|into|over|under|about|between|during|per|via|amid|but|nor|so|yet|after|before|toward|towards|against|among)$/i;

/**
 * 방송에 내보내면 안 되는 미완성 문장인가.
 *
 * true 를 돌려주면 호출부는 **그 문장을 쓰지 않는다** — 폴백하거나 건너뛴다.
 * "짧아서 잘렸다"가 아니라 "읽는 사람이 사실을 잘못 알게 된다"가 기준이다.
 */
export function isFragment(text: string): boolean {
  const s = String(text || "").trim().replace(/[.!?]+$/, "").trim();

  // 너무 짧으면 헤드라인이 아니다 (자리표시자·오류 문자열 포함)
  if (s.length < 14) return true;

  // ★ 종속절만 있는 경우. 주절은 콤마 뒤에 온다 — 콤마가 없으면 주절 자체가 없다.
  //   "After Trump calls off bombing"        → 파편
  //   "Amid tariff fears, stocks slip"       → 정상 (콤마 뒤에 주절이 있다)
  if (SUBORDINATOR.test(s) && !/,\s*\S{3}/.test(s)) return true;

  // 전치사·접속사로 끝남 — "…halts Israeli push at"
  if (DANGLING_END.test(s)) return true;

  // 단위가 떨어져 나간 숫자 — "…surges past $30" 은 300억을 30으로 읽게 만든다.
  //   앞에 전치사가 붙은 형태만 잡는다. "Dow falls 500 points" 같은 정상 문장은 건드리지 않는다.
  if (/\b(?:past|above|below|near|toward|towards|to|at|by|of)\s+[$€£]?\d[\d.,]*$/i.test(s)) return true;

  return false;
}

// ============================================================
//  절단이 **뜻을 바꾸는지** 검사한다
//
//  근본 원인 정리 — 지금까지 헤드라인 사고 7건이 전부 같은 실수였다:
//    "문장을 잘라내고, 잘린 결과를 원래 주장인 것처럼 방송했다."
//  그때마다 패턴 규칙을 하나 덧붙였고(클릭유도 꼬리 → 종속절 → 전치사 → 숫자),
//  새 문장이 오면 또 뚫렸다. 규칙을 더 쌓는 건 답이 아니다.
//
//  기준을 뒤집는다: 자르는 게 기본이 아니라, **지워도 주장이 안 바뀌는 것만** 자른다.
//  아래 표현이 잘려나가는 쪽에 있으면 절단을 거부한다 —
//  이들은 전부 주절의 주장을 **제한**하는 말이라, 지우면 더 센 주장이 된다.
//
//  실측 사고:
//    "Iran says it will halt strikes as long as US bombing pause holds"
//      → "Iran says it will halt strikes"        무조건 중단으로 읽힌다.
//        정작 외신 논조는 "tactical rather than genuine" 이고, 조건부라는 게 뉴스의 핵심이었다.
//    "Britain would be target …, Iran's Revolutionary Guards say"
//      → "Britain would be target …"             혁명수비대의 주장이 사실 진술로 바뀐다.
// ============================================================
const ESSENTIAL = new RegExp([
  // 조건 — 지우면 무조건 진술이 된다
  "as long as", "so long as", "only if", "unless", "provided", "pending",
  "subject to", "contingent", "\\bif\\b", "in case",
  // 부정·반박
  "\\bnot\\b", "\\bno\\b", "never", "denie[sd]", "deny", "reject(?:s|ed)?",
  "declin(?:e|es|ed)", "dismiss(?:es|ed)?", "without",
  // 완화·추정 — 확정처럼 읽히면 안 된다
  "reportedly", "allegedly", "\\bmay\\b", "\\bmight\\b", "\\bcould\\b",
  "expected to", "\\bset to\\b", "likely", "unlikely", "\\bif so\\b",
  // 귀속 — 누구의 주장인가
  "\\bsays?\\b", "\\bsaid\\b", "according to", "warn(?:s|ed)?",
  "claim(?:s|ed)?", "\\btold\\b", "sources? say"
].join("|"), "i");

/**
 * `removed` 를 지워도 `kept` 가 원문과 같은 주장인가.
 *
 * false 면 호출부는 **절단을 포기하고 원문을 쓴다.** 길어서 두 줄이 되는 것보다
 * 조건이 사라져 더 센 주장이 되는 게 훨씬 나쁘다 — 후자는 오보다.
 */
export function safeToDrop(removed: string): boolean {
  return !ESSENTIAL.test(String(removed || ""));
}
