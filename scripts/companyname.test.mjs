// 상호 대조 테스트 — "SPCX 사고" 재발 방지선
//
// 실행: node scripts/companyname.test.mjs   (npm test 에 포함)
// companyname.ts 는 의존성이 없어 Node 의 타입 스트리핑으로 그대로 import 된다.
import { normCo, companyMatches } from "../src/lib/server/companyname.ts";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; return; }
  fail++;
  console.error(`✗ ${name}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`);
};
const ok = (name, claimed, registered) => eq(name, companyMatches(claimed, registered), true);
const no = (name, claimed, registered) => eq(name, companyMatches(claimed, registered), false);

// ── 정규화 ────────────────────────────────────────────
eq("접미사 제거", normCo("Micron Technology Inc"), "micron technology");
eq("클래스 표기 제거", normCo("Alphabet Inc Class A"), "alphabet");
eq("앰퍼샌드", normCo("Johnson & Johnson"), "johnson and johnson");
eq("점·쉼표", normCo("NVIDIA Corp."), "nvidia");

// ── 같은 회사로 인정해야 하는 것 ──────────────────────
ok("정확히 일치", "Micron Technology", "Micron Technology Inc");
ok("짧은 쪽이 포함", "Micron", "Micron Technology Inc");
ok("긴 쪽이 주장", "Micron Technology Inc", "Micron");
ok("클래스 주식", "Alphabet", "Alphabet Inc Class A");
ok("대소문자 무시", "nvidia corporation", "NVIDIA Corp");
ok("ADR 표기", "Taiwan Semiconductor Manufacturing", "Taiwan Semiconductor Manufacturing Co Ltd ADR");

// ── ★ 실제로 났던 사고 ────────────────────────────────
// 비상장 회사에 철자가 비슷한 남의 티커가 붙어 −1.85% 가 방송됐다.
no("SPCX 사고: 스페이스엑스 ≠ SPCX 등록사", "SpaceX", "TortoiseEcofin Acquisition Corp III");
no("비상장이라 등록사가 없음", "SpaceX", "");
no("조회 실패는 '모른다' → 붙이지 않는다", "Micron Technology", null);
no("undefined 도 마찬가지", "Micron Technology", undefined);

// ── 다른 회사는 갈라야 한다 ───────────────────────────
no("다른 반도체 회사", "Micron Technology", "Marvell Technology Inc");
no("이름이 겹쳐도 다른 회사", "American Airlines", "American Express Co");
no("접미사만 남는 상호", "Inc", "Micron Technology Inc");
no("빈 주장", "", "Micron Technology Inc");

// 낱말 경계 — 짧은 조각이 긴 상호 안에 우연히 박히는 걸 인정하면 안 된다
no("부분 문자열 오탐", "Arm", "Pharma Holdings Inc");
ok("낱말로 들어맞으면 인정", "Arm Holdings", "Arm Holdings plc");

console.log(`\ncompanyname: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
