// 티커 대조 테스트
//
// ★ 등록 상호는 전부 Finnhub /stock/profile2 **실측값**이다. 지어낸 값이 하나도 없다.
//   (앞서 "SPCX 는 다른 회사"라고 확인 없이 단정했다가 틀렸다 — SPCX 는 실제 SpaceX 이고
//    2026-06-12 나스닥 상장이다. 그래서 이 파일의 값은 전부 API 로 찍어서 넣었다.)
//
// 실행: node scripts/companyname.test.mjs   (npm test 에 포함)
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

// ── 통칭 ≠ 법인명 이어도 통과해야 한다 (실측 등록명) ──
// 여기서 막히면 맞는 티커에 시세가 안 붙는다. 실제로 그 버그를 냈었다.
ok("SPCX: 통칭 SpaceX ↔ 법인 Space Exploration Technologies", "SpaceX", "Space Exploration Technologies Corp");
ok("NVDA", "NVIDIA", "NVIDIA Corp");
ok("MU", "Micron Technology", "Micron Technology Inc");
ok("BE", "Bloom Energy Corporation", "Bloom Energy Corp");
ok("GOOGL: 통칭 Google ↔ 법인 Alphabet 은 판정 불가 → 통과", "Google", "Alphabet Inc");
ok("클래스 주식", "Alphabet", "Alphabet Inc Class A");
ok("대소문자 무시", "nvidia corporation", "NVIDIA Corp");
ok("ADR 표기", "Taiwan Semiconductor Manufacturing", "Taiwan Semiconductor Manufacturing Co Ltd ADR");

// ── ★ 진짜 위험: 실재하지만 다른 회사 ─────────────────
// SPCE 와 SPCX 는 한 글자 차이인데다 둘 다 우주 회사다. 형식 검사도, 실재 검사도 통과한다.
no("SPCE 를 스페이스엑스라고 주장", "SpaceX", "Virgin Galactic Holdings Inc");
no("같은 업종 낱말만 겹치는 건 근거가 아니다", "Micron Technology", "Marvell Technology Inc");
no("완전히 다른 회사", "Bloom Energy", "Virgin Galactic Holdings Inc");

// ── 지어낸 심볼 / 조회 실패 ───────────────────────────
// profile2 가 `{}` 를 주는 경우다 (SPXQ·ZQQZ 로 실측 확인).
no("등록된 회사 없음(지어낸 심볼)", "SpaceX", "");
no("조회 실패는 '모른다' → 붙이지 않는다", "Micron Technology", null);
no("undefined 도 마찬가지", "Micron Technology", undefined);
no("빈 주장", "", "Micron Technology Inc");

console.log(`\ncompanyname: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
