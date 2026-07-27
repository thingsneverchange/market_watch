// ============================================================
//  FRED 변환 회귀 테스트 — **5★ 지표가 방송에 나가는 숫자다**
//
//  실행:  node scripts/fredmath.test.mjs
//
//  여기 있는 관측치는 전부 **FRED 원본 실데이터**다(2026-07-27 조회).
//  사고가 났던 그 배열을 그대로 박아 둔다 — 다시 밀리면 여기서 잡힌다.
// ============================================================
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { convert, monthsBefore } =
  await import(pathToFileURL(join(ROOT, "src/lib/server/fredmath.ts")).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ""}`); }
};
const eq = (name, got, want) =>
  ok(name, got === want, `기대 ${want} · 실제 ${got}`);

const O = (rows) => rows.map(([date, value]) => ({ date, value: String(value) }));

// ── ★ 사고 재현: CPIAUCSL, 2025-10 결측 ──────────────────
//  결측을 제거하고 위치 인덱스로 "1년 전"을 찾으면 13개월 전에 닿는다.
//  방송에 3.73% 가 나갔다. 실제 발표는 3.5% 였다.
const CPI = O([
  ["2026-06-01", 332.568], ["2026-05-01", 333.979], ["2026-04-01", 332.407],
  ["2026-03-01", 330.293], ["2026-02-01", 327.460], ["2026-01-01", 326.588],
  ["2025-12-01", 326.031], ["2025-11-01", 325.063],
  // 2025-10-01 은 원본이 "." (결측) — 호출부가 제거해서 여기 없다
  ["2025-09-01", 324.245], ["2025-08-01", 323.291], ["2025-07-01", 322.169],
  ["2025-06-01", 321.435], ["2025-05-01", 320.620], ["2025-04-01", 320.302],
  ["2025-03-01", 319.785], ["2025-02-01", 319.679], ["2025-01-01", 318.961],
  ["2024-12-01", 317.604], ["2024-11-01", 316.528]
]);

console.log("\n=== 결측이 있는 월간 시리즈의 YoY (실제 사고) ===");
{
  const { value, prev } = convert(CPI, "yoy", "M");
  eq("CPI YoY 는 2025-06 과 비교해야 한다 (13개월 전이 아니라)", value, 3.46);
  eq("prev 도 날짜 기준이어야 한다", prev, 4.17);
  ok("사고 당시의 값(3.73)이 다시 나오지 않는다", value !== 3.73, `실제 ${value}`);
}

console.log("\n=== 1년 전 관측치가 결측이면 계산하지 않는다 ===");
{
  // 기준의 정확히 12개월 전(2025-06)을 지운다 → 옆 값으로 때우면 안 된다
  const holed = CPI.filter((o) => o.date !== "2025-06-01");
  const { value } = convert(holed, "yoy", "M");
  eq("값을 지어내지 않고 null (화면은 '—')", value, null);
}

console.log("\n=== 결측이 없으면 기존 동작과 같다 ===");
{
  const clean = O([
    ["2026-06-01", 110], ["2026-05-01", 109], ["2026-04-01", 108], ["2026-03-01", 107],
    ["2026-02-01", 106], ["2026-01-01", 105], ["2025-12-01", 104], ["2025-11-01", 103],
    ["2025-10-01", 102], ["2025-09-01", 101], ["2025-08-01", 100], ["2025-07-01", 99],
    ["2025-06-01", 100], ["2025-05-01", 100]
  ]);
  eq("YoY = 110/100 − 1", convert(clean, "yoy", "M").value, 10);
  eq("MoM = 110/109 − 1", convert(clean, "mom", "M").value, 0.92);
}

console.log("\n=== 분기 시리즈 (GDP) — 4분기 전 = 12개월 전 ===");
{
  const gdp = O([
    ["2026-01-01", 23500], ["2025-10-01", 23300], ["2025-07-01", 23100],
    ["2025-04-01", 22900], ["2025-01-01", 22886], ["2024-10-01", 22700]
  ]);
  // 23500 / 22886 − 1 = 2.68%  ← 프로덕션에 나가던 값과 일치해야 한다
  eq("분기 YoY 는 4분기 전과 비교", convert(gdp, "yoy", "Q").value, 2.68);
  ok("배열 길이로 스텝을 추측하지 않는다(예전 사고: +7.76%)",
    convert(gdp, "yoy", "Q").value < 5, `실제 ${convert(gdp, "yoy", "Q").value}`);
}

console.log("\n=== 일간 시리즈 (Fed Funds) — 월 산술이 성립하지 않는다 ===");
{
  const dff = O([
    ["2026-07-23", 3.63], ["2026-07-22", 3.63], ["2026-07-21", 3.62]
  ]);
  const { value, prev } = convert(dff, "level", "D");
  eq("현재값", value, 3.63);
  eq("직전 발표치는 위치 기준(전일)", prev, 3.63);
}

console.log("\n=== 고용 증감 (delta_k) ===");
{
  const payems = O([
    ["2026-06-01", 160057], ["2026-05-01", 160000], ["2026-04-01", 159871]
  ]);
  const { value, prev } = convert(payems, "delta_k", "M");
  eq("전월 대비 증감(천명)", value, 57);
  eq("그 전월 증감", prev, 129);
}

console.log("\n=== 결측이 delta_k / mom 도 밀리지 않는가 ===");
{
  // 2026-05 가 빠진 상태 → 전월(2026-05)이 없으므로 계산 불가여야 한다.
  //   예전 위치 인덱스라면 2026-04 를 "전월"로 써서 조용히 틀린 값을 냈다.
  const holed = O([["2026-06-01", 160057], ["2026-04-01", 159871]]);
  eq("전월이 결측이면 null", convert(holed, "delta_k", "M").value, null);
  eq("mom 도 마찬가지", convert(holed, "mom", "M").value, null);
}

console.log("\n=== monthsBefore 경계 ===");
eq("연도 경계", monthsBefore("2026-01-01", 1), "2025-12-01");
eq("12개월", monthsBefore("2026-06-01", 12), "2025-06-01");
eq("여러 해", monthsBefore("2026-03-01", 27), "2023-12-01");

console.log(`\n${fail === 0 ? "✅" : "❌"}  통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
