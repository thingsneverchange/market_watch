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

// ============================================================
//  헤드라인이 **우리 화면의 실시간 값과 모순되는지** 검사한다
//
//  실측 사고 — 같은 화면에 이 둘이 동시에 떠 있었다:
//    헤드라인  "Oil near $100 puts fed and peers in interest-rate spotlight"  (27시간 전, 5★)
//    시세 스트립  OIL  84.32  −5.63%
//  기사가 나온 시점엔 맞는 말이었다. 지금은 아니다. 시청자는 둘을 **동시에** 본다.
//
//  나이로 거르는 것과는 다른 문제다. 27시간 된 기사라도 여전히 유효할 수 있고,
//  반대로 3시간 된 기사가 급변한 시세에 무효화될 수도 있다.
//  기준은 시간이 아니라 **우리가 반증할 수 있느냐**여야 한다.
//  값을 아는 자산에 대해서만 판정한다 — 모르면 아무 말도 하지 않는다.
// ============================================================

/** 헤드라인이 말하는 자산 → 우리가 실시간으로 아는 값의 키 */
const ASSET_KEYS: [RegExp, string][] = [
  [/\b(?:oil|crude|brent|wti)\b/i, "OIL"],
  [/\bgold\b/i, "GOLD"],
  [/\b(?:bitcoin|btc)\b/i, "BTC"],
  [/\b(?:nasdaq|ndx)\b/i, "NQ"],
  [/\bs\s?&\s?p\s?500\b/i, "ES"],
  [/\bdow\b/i, "YM"],
  [/\bvix\b/i, "VIX"]
];

/**
 * **현재 상태를 단정하는** 수치 표현만 본다.
 *  "from $100"(과거 기준점) · "could hit $120"(전망) 은 지금 값과 달라도 틀린 게 아니다.
 */
/**
 * ★ **퍼센트는 가격이 아니다.**
 *  실측 사고: "Gold gains over 1% on pause in US-Iran fighting" 에서 `over 1` 을
 *  가격 주장으로 읽어, 금 $4,100 과 비교해 괴리 409,930% 로 판정하고
 *  멀쩡한 5★ 헤드라인을 방송에서 지웠다. 반증 장치가 오히려 오보를 만든 셈이다.
 *  → 숫자 뒤에 %(또는 percent/bps/pt)가 붙으면 수준 주장이 아니다.
 *  또한 통화기호나 네 자리 이상이 아니면 애초에 가격 수준으로 보지 않는다 —
 *  "up 3 points" 같은 표현을 가격이라 우길 이유가 없다.
 */
const LEVEL_CLAIM =
  /\b(?:near|around|above|below|over|under|tops?|hits?|breaches?|crosses?|holds?|stays? at|steady at|at)\s+(\$|€|£)?(\d[\d,]*(?:\.\d+)?)(?!\s*(?:%|percent|bps|pt\b|point))/i;

/** 전망·가정 어법이 섞여 있으면 현재 단정이 아니다 */
const FORWARD =
  /\b(?:could|may|might|would|forecast\w*|expects?|expected|sees?|target\w*|risk of|projected|outlook|toward|towards|if|unless|should)\b/i;

/** 이보다 벌어지면 "지금은 틀린 말"로 본다. 넉넉히 잡는다 — 멀쩡한 기사를 지우면 안 된다. */
const MAX_DIVERGENCE = 0.08;

export type Contradiction = { asset: string; claimed: number; live: number; gap: number };

/**
 * 헤드라인이 주장하는 가격 수준이 지금 값과 크게 어긋나는가.
 *
 * @param live 자산키 → 현재가. 우리가 화면에 띄우고 있는 값 그대로여야 한다.
 * @returns 모순이면 상세, 아니면 null (판정 불가도 null — 모르면 주장하지 않는다)
 */
export function contradictsLive(
  headline: string, live: Map<string, number>
): Contradiction | null {
  const s = String(headline || "");
  if (FORWARD.test(s)) return null;              // 전망·가정문은 반증 대상이 아니다

  const hit = ASSET_KEYS.find(([re]) => re.test(s));
  if (!hit) return null;                          // 우리가 값을 모르는 자산
  const now = live.get(hit[1]);
  if (!Number.isFinite(now) || !now) return null;

  const m = s.match(LEVEL_CLAIM);
  if (!m) return null;
  const [, currency, digits] = m;
  const claimed = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(claimed) || claimed <= 0) return null;

  // ★ 통화기호가 없고 자릿수도 작으면 **가격 수준 주장이 아니다.**
  //   "gains over 1", "up at 3" 같은 걸 가격이라 우기면 반증 장치가 오보를 만든다.
  //   기준은 자의적이지 않다 — 우리가 아는 값의 자릿수와 비슷해야 같은 것을 말한 것이다.
  if (!currency && claimed < now / 10) return null;

  const gap = Math.abs(claimed - now) / claimed;
  return gap > MAX_DIVERGENCE
    ? { asset: hit[1], claimed, live: now, gap: Math.round(gap * 1000) / 10 }
    : null;
}

// ============================================================
//  통신사·매체의 **고정 칼럼 브랜드** 판정
//
//  실측 사고: TOP STORY 최상단에 "Morning Bid: Markets dare to hope" 가 올라갔다.
//   로이터가 매일 내보내는 시황 칼럼의 코너 이름이다. 무슨 일이 있었는지 아무것도
//   말하지 않고("시장이 희망을 품는다"는 어느 날 아침에나 쓸 수 있다),
//   같은 제목이 매일 새 기사로 다시 들어온다.
//   시청자가 TOP STORY 에서 알고 싶은 건 **지금 시장을 움직이는 사건**이지
//   그 사건을 다룬 칼럼의 이름이 아니다.
//
//  ※ 내용 자체는 유효할 수 있으므로 목록에서 지우지는 않는다.
//    **최상단 자리만** 안 준다 (호출부가 matched 를 지운다).
// ============================================================
const COLUMN =
  /^\s*(?:morning bid|market wrap|markets wrap|daily briefing|take five|breakingviews|instant view|factbox|explainer|analysis|column|live updates?|market talk|the close|opening bell|closing bell|five things|5 things|today'?s markets?)\b|:\s*(?:live updates?|analysis|explainer|factbox)\b/i;

/** 기사가 아니라 **코너 이름**인가 (TOP STORY 최상단 자격 없음) */
export function isColumnBrand(headline: string): boolean {
  return COLUMN.test(String(headline || ""));
}

// ============================================================
//  실시간 와이어(newswire.ts) 전용 게이트
//
//  구글 뉴스 검색은 최신성이 뛰어난 대신 **SEO·자동생성 사이트를 길게 끌고 온다.**
//  와이어를 붙이자마자 화면에 이런 게 올라왔다 (실측, 2026-07-27):
//    "Northeast Bancorp (NASDAQ:NBN) Issues Quarterly Earnings Results" — MarketBeat
//    그 외 GuruFocus · TechStock² · The Times of India
//  틀린 정보는 아니지만, 방송 화면의 출처로 나가면 신뢰도가 깎인다.
//
//  ※ 허용목록이 아니라 **차단목록**으로 간다.
//    허용목록은 처음 보는 매체의 진짜 특종을 통째로 버린다 —
//    실제로 이번 반도체 국면의 1보는 The Information 이었고, 그건 허용목록에 없었을 것이다.
// ============================================================
const BLOCKED_PUBLISHER =
  /(marketbeat|gurufocus|zacks|tipranks|simply ?wall|investorplace|insider monkey|24\/7 wall|talkmarkets|etf daily|defense world|stocktwits|techstock|the times of india|financial world|american banking|modern readers|ledger gazette|dispatch tribunal)/i;

/** 알려진 콘텐츠밀·자동생성 매체인가 */
export function isBlockedPublisher(source: string): boolean {
  return BLOCKED_PUBLISHER.test(String(source || ""));
}

// 소형주 보도자료·시세 자동기사 — 매체와 무관하게 방송할 사건이 아니다.
// "(NASDAQ:XXX) Issues …", "Shares Gap Up", "Given Average Rating", "Position Boosted By …"
//
// ★ 로펌 집단소송 보도자료가 특히 많다. PR Newswire 를 타고 Morningstar·Yahoo 같은
//   멀쩡한 매체로 신디케이트되기 때문에 **매체 차단으로는 못 걸린다.** 실측:
//     "INVESTOR ALERT: The Hub Group, Inc. (NASDAQ: HUBG) Investors with Substantial Losses…"
//   콜론 뒤 공백(`NASDAQ: HUBG`) 때문에 티커 패턴도 비껴갔다 → 공백을 허용한다.
const PR_NOISE =
  /(earnings call (?:transcript|presentation|highlights|slides)|q[1-4] \d{4} (?:results|earnings) - (?:earnings call|results)|\((?:NASDAQ|NYSE|AMEX|OTCMKTS):\s?[A-Z.]{1,6}\)\s+(?:issues|announces|declares|schedules|reports|sets|files|investors)|investor alert|shareholder (?:alert|rights|investigation|deadline)|class action|securities fraud|law offices of|deadline reminder|encourages investors|investors with (?:substantial )?losses|contact the firm|shares? (?:gap|trading) (?:up|down)|stock (?:price )?(?:up|down) \d|given (?:a |an )?(?:average|consensus) rating|price target (?:raised|lowered|set|cut) (?:to|at)|short interest (?:up|down)|(?:position|stake|holdings) (?:boosted|lowered|trimmed|raised) by|buys new (?:shares|stake))/i;

/** 자동생성 시세·보도자료 기사인가 (방송할 사건이 아니다) */
export function isPressRelease(headline: string): boolean {
  return PR_NOISE.test(String(headline || ""));
}

// ============================================================
//  논평·분석 **형식** 판정 — TOP STORY 자격
//
//  실측 사고: 방송 최상단에 이게 올라갔다.
//    "Did Trump's Subsidy Review Cause the Semiconductor Price Surge?
//     The Real Bottleneck Lies in Apple's Supplier"   (economy.ac, 18분)
//  같은 화면 아래에는 진짜 사건이 있었다:
//    "SK Hynix shares plunge 13% in Seoul as chip sell-off deepens"  (CNBC, 163분)
//  선정 점수가 `등급 − 나이/6시간` 뿐이라, 18분짜리 클릭베이트가 신선도로 이겼다.
//
//  ※ 형식으로 가른다. **질문은 사건이 아니다** — 누군가의 해석이다.
//    시청자가 TOP STORY 에서 알고 싶은 건 "무슨 일이 일어났나"이지
//    "무엇이 원인이었을까?" 라는 물음이 아니다.
//  ※ isColumnBrand 와 같은 처리 — 목록에는 남기고 **최상단 자리만** 안 준다.
//    내용 자체는 유효할 수 있다.
// ============================================================
const ANALYSIS_FORM = new RegExp([
  // 의문사로 시작해 물음표가 따라오는 형식 — "Did X Cause Y?" "Is It Time To …?"
  "^(?:did|do|does|is|are|was|were|will|would|should|can|could|has|have|how|why|what|which|who|when|where)\\b[^?]{0,140}\\?",
  // 물음표로 끝나는 헤드라인 — 사건 보도는 이렇게 끝나지 않는다
  "\\?\\s*$",
  // 해설물 상투구
  "^(?:here['\u2019]?s|the real\\b|what to know|everything you need|explained\\b|analysis:|opinion:|commentary:)",
  "\\b(?:here['\u2019]?s why|here['\u2019]?s what|what it means for|the real (?:reason|bottleneck|story|winner|loser|problem|risk))\\b"
].join("|"), "i");

/** 사건 보도가 아니라 **해석·논평 형식**인가 (TOP STORY 최상단 자격 없음) */
export function isAnalysisForm(headline: string): boolean {
  return ANALYSIS_FORM.test(String(headline || ""));
}

// ============================================================
//  매체 등급 — 순위의 보정항
//
//  왜 필요한가: 위 사고에서 economy.ac(처음 보는 사이트)가 CNBC 를 이겼다.
//  점수에 매체가 아예 없었기 때문이다.
//
//  ※ **모르는 매체를 깎지 않고, 아는 매체에 가점을 준다.**
//    처음 보는 매체가 진짜 특종을 낼 수 있다 — 이번 중국 반도체 국면의 1보가
//    The Information 이었다. 감점 방식이면 그걸 묻어 버린다.
// ============================================================
const MAJOR_OUTLET =
  /\b(reuters|bloomberg|cnbc|wall street journal|wsj|financial times|\bft\b|marketwatch|barron|associated press|\bap\b|axios|politico|nikkei|the economist|forbes|fortune|business insider|yahoo finance|the information|cnn|bbc|guardian|france ?24|npr|semafor|the verge|techcrunch|ars technica|digitimes)\b/i;

/** 방송에 이름을 걸 만한 매체인가 → 순위 가점 */
export function isMajorOutlet(source: string): boolean {
  return MAJOR_OUTLET.test(String(source || ""));
}

// ============================================================
//  "이게 시장 사건인가" — 순위의 두 번째 보정항
//
//  실측 사고 2단계. 매체 가점을 넣어 클릭베이트를 최상단에서 밀어냈더니
//  이번엔 이게 올라왔다:
//    "Automotive chip demand surges in 2Q26 on EV reset"  (digitimes, 120분)
//  같은 화면 아래:
//    "SK Hynix shares plunge 13% in Seoul as chip sell-off deepens"  (CNBC, 166분)
//    "Korean Markets Hit by Turmoil as Chip Rout Forces Trading Halts"  (Bloomberg, 48분)
//  그 시각 SOXX 는 −3.63%. 화면의 테이프가 말하는 것과 헤드라인이 정확히 겹치는데도
//  업계 수요 전망이 최상단을 차지했다.
//
//  빠져 있던 건 매체가 아니라 **"무슨 일이 일어났는가"** 였다.
//  마켓 방송의 TOP STORY 는 해설도 전망도 아니고 **시장이 움직인 사건**이어야 한다.
//  그건 헤드라인 형태로 꽤 정확히 드러난다 — 방향 동사 + 폭.
// ============================================================

/** 시장이 실제로 움직였다고 말하는 동사 */
const MOVE_VERB =
  /\b(?:plunge[sd]?|plummet\w*|tumble[sd]?|slump\w*|sink[s]?|sank|slide[sd]?|crash\w*|collapse[sd]?|rout\w*|sell-?off|selloff|nosedive[sd]?|crater\w*|surge[sd]?|soar\w*|spike[sd]?|jump\w*|rally|rallie[sd]|rebound\w*|skyrocket\w*|halt(?:s|ed)?|suspend(?:s|ed)?|freefall|free fall|slid|fell|drop\w*|climb\w*|gain\w*|lose[s]?|lost)\b/i;

/** 폭이 붙어 있는가 — "13%", "600 points", "$4bn" */
// ★ % 뒤에 \b 를 붙이면 안 된다. "%" 도 뒤의 공백도 비단어 문자라 경계가 성립하지 않아
//   "plunge 13% in Seoul" 이 통째로 매치에 실패한다(실측으로 잡힌 버그).
//   단어로 끝나는 단위에만 \b 를 붙인다.
const MAGNITUDE = /\d[\d,.]*\s*(?:%|percent\b|points?\b|pts?\b|bps\b)|[$€£]\s?\d[\d,.]*\s*(?:bn|billion|tn|trillion|million)?/i;

/** 시장 스트레스 자체를 가리키는 말 — 폭이 없어도 사건이다 */
const STRESS =
  /\b(?:trading halt\w*|circuit breaker\w*|limit down|limit up|turmoil|rout|panic|capitulation|margin call\w*|flash crash|bear market|correction territory)\b/i;

/**
 * 이 헤드라인이 **시장 사건**을 말하는 정도. 순위에 더할 가점.
 *
 *  1.0 — 방향 동사 + 폭 ("plunge 13%", "Dow jumps 600 points")
 *  0.6 — 시장 스트레스 표현 (거래정지·루트·서킷브레이커)
 *  0.3 — 방향 동사만 ("chip demand surges") — 사건일 수도, 업계 전망일 수도 있다
 *  0   — 그 외
 *
 * ※ 이건 사건성을 재는 것이지 중요도가 아니다. 중요도는 level 이 이미 담당한다.
 */
export function marketEventScore(headline: string): number {
  const s = String(headline || "");
  const verb = MOVE_VERB.test(s);
  if (verb && MAGNITUDE.test(s)) return 1;
  if (STRESS.test(s)) return 0.6;
  return verb ? 0.3 : 0;
}
