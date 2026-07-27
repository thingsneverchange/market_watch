// ============================================================
//  헤드라인 회귀 테스트 — **방송 오보 방지선**
//
//  왜 이 파일이 있나:
//   헤드라인 가공에서 사고가 7건 났고 전부 같은 종류였다 —
//   *문장을 잘라내고, 잘린 결과를 원래 주장인 것처럼 방송했다.*
//   그때마다 규칙을 하나 덧붙였고 새 문장이 오면 또 뚫렸다.
//   여기 있는 케이스는 전부 **실제로 방송에 나갔던 문장**이다.
//   가공 로직을 건드릴 때는 반드시 이 파일을 먼저 돌린다.
//
//  실행:  node scripts/headline.test.mjs
//
//  ※ TS 파일을 그대로 읽어 함수만 평가한다(빌드·의존성 없이 돌아가야 하므로).
//    finnhub.ts 의 shortHeadline 은 $env import 에 걸리지 않도록 본문만 떼어 쓴다.
// ============================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRV = join(ROOT, "src/lib/server");

// ★ 타입 주석을 **한 곳에서 일반적으로** 벗긴다.
//   예전엔 시그니처마다 개별 치환을 걸어 뒀는데, headline.ts 에 함수를 하나 추가할
//   때마다 여기가 조용히 깨졌다(실측: ASSET_KEYS 상수 추가 → 테스트 전체 실행 불가).
//   테스트 하네스가 대상 코드보다 먼저 깨지면 방어선 역할을 못 한다.
// ★ headline.ts 는 **그대로 import 한다.** Node 23+ 의 타입 스트리핑이 처리한다.
//   예전엔 정규식으로 타입 주석을 벗겼는데, 함수를 하나 추가할 때마다 여기가 조용히
//   깨졌다(실측: ASSET_KEYS 상수 하나 추가 → 테스트 전체가 실행 불가).
//   **테스트 하네스가 대상 코드보다 먼저 깨지면 방어선 역할을 못 한다.**
const { isFragment, safeToDrop, contradictsLive } =
  await import(pathToFileURL(join(SRV, "headline.ts")).href);

// shortHeadline 만은 본문을 떼어 쓴다 — finnhub.ts 는 $env/static/private 를 import 해서
// 테스트 환경에서 통째로 로드할 수 없다. 의존 함수는 인자로 주입한다.
const finnhubSrc = readFileSync(join(SRV, "finnhub.ts"), "utf8");
const a = finnhubSrc.indexOf("export function shortHeadline");
const b = finnhubSrc.indexOf("\nfunction mapNews", a);
const shortSrc = finnhubSrc
  .slice(a, b)
  .replace("export function", "function")
  .replace(/\(title: string\): string/, "(title)");

const shortHeadline = new Function(
  "isFragment", "safeToDrop", `${shortSrc}\nreturn shortHeadline;`
)(isFragment, safeToDrop);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ""}`); }
};
const eq = (name, input, want) => {
  const got = shortHeadline(input);
  ok(name, got === want, `얻음: ${got}\n       기대: ${want}`);
};

console.log("\n=== 실제 방송 사고 (전부 재발 금지) ===");

// 2026-07-27 — 조건절이 삭제돼 무조건 진술로 바뀌었다.
// 외신 논조는 "tactical rather than genuine" 이었고 조건부라는 게 뉴스의 핵심이었다.
eq("조건절(as long as)을 지우지 않는다",
  "Iran says it will halt strikes as long as US bombing pause holds - Reuters",
  "Iran says it will halt strikes as long as US bombing pause holds");

// 2026-07-27 — 귀속이 사라져 혁명수비대의 '주장'이 '사실'로 바뀌었다.
eq("귀속(…Guards say)을 지우지 않는다",
  "Britain would be target if it supports US in war, Iran's Revolutionary Guards say - Reuters",
  "Britain would be target if it supports US in war, Iran's Revolutionary Guards say");

// 2026-07-26 — 종속절만 남아 배경 사실이 헤드라인 행세를 했다.
eq("종속절이 앞에 오면 주절을 살린다",
  "After Trump calls off bombing, Iran signals it will halt strikes as long as US does - Reuters",
  "Iran signals it will halt strikes as long as US does");

// 2026-07-26 — 60자 절단이 전치사에서 끊었다.
eq("전치사로 끝나게 자르지 않는다",
  "Palestinians hope UNESCO designation halts Israeli push at West Bank site - Reuters",
  "Palestinians hope UNESCO designation halts Israeli push at West Bank site");

// 2026-07-26 — 절단이 단위를 날려 300억이 30이 됐다.
eq("숫자에서 단위를 떼어내지 않는다",
  "Nvidia tops estimates as data center revenue surges past $30 billion",
  "Nvidia tops estimates as data center revenue surges past $30 billion");

// 2026-07-25 — 기사 제목의 클릭유도 꼬리가 방송에 나갔다.
eq("클릭유도 꼬리는 제거하되 본문은 보존한다",
  "Megacap earnings and Fed meeting could test a market on edge next week. Here's what's ahead",
  "Megacap earnings and Fed meeting could test a market on edge next week");

console.log("\n=== 정상적으로 줄어야 하는 것 (부수 정보만 제거) ===");
eq("문말 부수절은 제거한다",
  "Iran war spreads to Red Sea and Caspian, Gulf quiet as US forgoes strikes - Reuters",
  "Iran war spreads to Red Sea and Caspian");
eq("출처 접미사는 제거한다",
  "Oil falls on report China pushing for end US-Iran war - Reuters",
  "Oil falls on report China pushing for end US-Iran war");
eq("전치사구(on)를 절 경계로 오인하지 않는다",
  "Shares, bonds make guarded gains as oil slips - Reuters",
  "Shares, bonds make guarded gains as oil slips");
eq("짧은 문장은 그대로 둔다",
  "Dollar pulls back as US-Iran attacks pause, oil drops - Reuters",
  "Dollar pulls back as US-Iran attacks pause, oil drops");

console.log("\n=== 파편 판정 — 차단돼야 하는 것 ===");
for (const t of [
  "After Trump calls off bombing",
  "Palestinians hope UNESCO designation halts Israeli push at",
  "Nvidia tops estimates as data center revenue surges past $30",
  "Amid tariff fears",
  "Following the Fed decision",
  "Oil climbs toward"
]) ok(`차단: "${t}"`, isFragment(t));

console.log("\n=== 파편 판정 — 통과해야 하는 것 (오판이 더 나쁘다) ===");
for (const t of [
  "Iran signals it will halt strikes as long as US does",
  "Amid tariff fears, stocks slip",
  "Iran war spreads to Red Sea and Caspian",
  "Dow falls 500 points",
  "Fed holds rates steady at 4.25%",
  "In a first, the ECB signals a pause",
  "On Wall Street, banks lead the rebound"
]) ok(`통과: "${t}"`, !isFragment(t));

// ============================================================
//  화면의 실시간 시세와 모순되는 기사
//
//  실측 사고 — 같은 화면에 동시에 떠 있었다:
//    헤드라인   "Oil near $100 puts fed and peers in interest-rate spotlight" (27시간 전, 5★)
//    시세 스트립  OIL  84.32  −5.63%
//  기사가 나온 시점엔 맞는 말이었다. 지금은 아니고, 시청자는 둘을 동시에 본다.
// ============================================================
const LIVE = new Map([["OIL", 84.32], ["GOLD", 4092], ["NQ", 28688.5], ["BTC", 65140]]);

console.log("\n=== 시세 모순 — 제외해야 하는 것 ===");
for (const t of [
  "Oil near $100 puts fed and peers in interest-rate spotlight",   // ★ 실제 사고
  "Bitcoin holds above $90,000 as risk appetite returns"
]) ok(`제외: "${t}"`, !!contradictsLive(t, LIVE));

console.log("\n=== 시세 모순 — 통과해야 하는 것 (멀쩡한 기사를 지우면 안 된다) ===");
for (const [t, why] of [
  ["Oil falls to $84 as US and Iran pause strikes", "지금 값과 일치"],
  ["Gold tops $4,000 on safe-haven bid", "지금 값과 일치"],
  ["Nasdaq futures rise above 28,000", "지금 값과 일치"],
  ["Oil slides from $100 after ceasefire report", "과거 기준점 — 지금 값과 달라도 맞는 말"],
  ["Oil could hit $120 if Hormuz closes", "전망 — 반증 대상이 아니다"],
  ["Analysts see gold at $5,000 next year", "전망"],
  ["Copper near $12,000 a tonne on supply squeeze", "우리가 값을 모르는 자산 → 판정 안 함"],
  ["Iran says it will halt strikes as long as US bombing pause holds", "숫자 없음"],
  // ★ 실측 사고: "over 1%" 의 1 을 가격으로 읽어 금 $4,100 과 비교, 괴리 409,930% 로
  //   판정하고 멀쩡한 5★ 헤드라인을 방송에서 지웠다. 반증 장치가 오보를 만든 셈이다.
  ["Gold gains over 1% on pause in US-Iran fighting; Fed decision looms", "퍼센트는 가격이 아니다"],
  ["Oil slides over 5% after ceasefire", "퍼센트는 가격이 아니다"],
  ["Nasdaq futures up over 1.5% premarket", "퍼센트는 가격이 아니다"],
  ["Gold climbs at 20 bps on the session", "bps 는 가격이 아니다"],
  ["Dow adds over 400 points", "points 는 가격이 아니다"]
]) ok(`통과(${why}): "${t.slice(0, 44)}"`, !contradictsLive(t, LIVE));

console.log(`\n${fail === 0 ? "✅" : "❌"}  통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
