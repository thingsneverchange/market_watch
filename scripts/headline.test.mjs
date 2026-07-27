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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRV = join(ROOT, "src/lib/server");

const headlineSrc = readFileSync(join(SRV, "headline.ts"), "utf8")
  .replace(/export /g, "")
  .replace(/\(text: string\): boolean/, "(text)")
  .replace(/\(removed: string\): boolean/, "(removed)");

const finnhubSrc = readFileSync(join(SRV, "finnhub.ts"), "utf8");
const a = finnhubSrc.indexOf("export function shortHeadline");
const b = finnhubSrc.indexOf("\nfunction mapNews", a);
const shortSrc = finnhubSrc
  .slice(a, b)
  .replace("export function", "function")
  .replace(/\(title: string\): string/, "(title)");

const { shortHeadline, isFragment } = new Function(
  `${headlineSrc}\n${shortSrc}\nreturn { shortHeadline, isFragment };`
)();

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

console.log(`\n${fail === 0 ? "✅" : "❌"}  통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
