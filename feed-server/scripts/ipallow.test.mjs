// IP 허용목록 단위 테스트 — 이게 유일한 방어선이라 반드시 통과해야 한다
import { parseAllowList, normalizeRemote, isAllowed } from "../src/ipallow.mjs";

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`)));

const A = (raw) => parseAllowList(raw).rules;

console.log("\n=== 단일 IP ===");
{
  const r = A("121.178.29.188");
  ok("정확히 일치하면 허용", isAllowed("121.178.29.188", r));
  ok("1비트만 달라도 차단", !isAllowed("121.178.29.189", r));
  ok("다른 대역 차단", !isAllowed("8.8.8.8", r));
}

console.log("\n=== CIDR ===");
{
  const r = A("121.178.0.0/16");
  ok("대역 안 허용", isAllowed("121.178.29.188", r));
  ok("대역 안 다른 IP 허용", isAllowed("121.178.255.1", r));
  ok("대역 밖 차단", !isAllowed("121.179.0.1", r));
  ok("/24 경계", isAllowed("10.0.0.255", A("10.0.0.0/24")) && !isAllowed("10.0.1.0", A("10.0.0.0/24")));
  ok("/32 는 단일 IP", isAllowed("5.5.5.5", A("5.5.5.5/32")) && !isAllowed("5.5.5.6", A("5.5.5.5/32")));
}

console.log("\n=== 여러 규칙 ===");
{
  const r = A("127.0.0.1, 121.178.29.188, 10.0.0.0/8");
  ok("로컬 허용", isAllowed("127.0.0.1", r));
  ok("내 IP 허용", isAllowed("121.178.29.188", r));
  ok("사설망 허용", isAllowed("10.5.5.5", r));
  ok("그 외 차단", !isAllowed("1.1.1.1", r));
  ok("공백/줄바꿈 구분자도 처리", A("1.1.1.1\n2.2.2.2  3.3.3.3").length === 3);
}

console.log("\n=== fail-closed (이게 제일 중요) ===");
{
  ok("빈 설정이면 아무도 못 들어옴", !isAllowed("121.178.29.188", A("")));
  ok("undefined 도 전부 차단", !isAllowed("1.2.3.4", A(undefined)));
  ok("쓰레기 규칙은 무시되고 차단", !isAllowed("1.2.3.4", A("헛소리, not-an-ip")));
  ok("잘못된 규칙은 bad 로 분리", parseAllowList("1.2.3.4, 쓰레기").bad.length === 1);
  ok("IPv6 는 차단(파싱 불가)", !isAllowed("2001:db8::1", A("0.0.0.0/0")));
  ok("빈 원격주소 차단", !isAllowed("", A("1.2.3.4")));
}

console.log("\n=== 위조/우회 시도 방어 ===");
{
  const r = A("121.178.29.188");
  ok("앞자리 0 패딩 우회 차단", !isAllowed("121.178.029.188", r));
  ok("8진수 표기 우회 차단", !isAllowed("0171.0262.035.0274", r));
  ok("범위 초과 옥텟 차단", !isAllowed("121.178.29.999", r));
  ok("옥텟 3개 차단", !isAllowed("121.178.29", r));
  ok("옥텟 5개 차단", !isAllowed("121.178.29.188.1", r));
  ok("포트 붙은 문자열 차단", !isAllowed("121.178.29.188:80", r));
}

console.log("\n=== IPv4-mapped IPv6 정규화 ===");
{
  ok("::ffff:1.2.3.4 → 1.2.3.4", normalizeRemote("::ffff:1.2.3.4") === "1.2.3.4");
  ok("정규화 후 매칭됨", isAllowed(normalizeRemote("::ffff:121.178.29.188"), A("121.178.29.188")));
  ok("정규화 후에도 다른 IP 는 차단", !isAllowed(normalizeRemote("::ffff:1.2.3.4"), A("121.178.29.188")));
}

console.log("\n=== 0.0.0.0/0 은 파싱은 되지만 명시적 옵트인 없이는 쓰지 않는다 ===");
{
  ok("0.0.0.0/0 규칙 자체는 전부 매칭", isAllowed("8.8.8.8", A("0.0.0.0/0")));
  console.log("     (서버는 MARKET_ALLOW_ANY_IP=yes-i-am-sure 없이는 이 규칙을 쓰지 않도록 경고합니다)");
}

console.log(`\n${"=".repeat(40)}\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail === 0 ? 0 : 1);
