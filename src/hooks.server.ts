import type { Handle } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

// ============================================================
//  IP 허용목록 — 이 앱의 유일한 방어선
//
//  왜 필요한가: 서버에 nginx 없이 포트를 직접 여는 구조라, 오버레이가 인터넷에 그대로 노출된다.
//  그런데 /control 과 /api/control 은 **인증이 없다** — 열려 있으면 아무나
//  방송 화면에 가짜 속보를 띄우거나 차트를 바꿀 수 있다. 그건 방송 사고다.
//
//  market-feed 의 ipallow 와 같은 원칙:
//   · fail-closed — 목록이 비면 전부 차단 (설정 실수로 전 세계에 열리는 사고 방지)
//   · 프록시 헤더(X-Forwarded-For)를 신뢰하지 않는다 — 위조 가능. 소켓 주소만 본다.
//   · 차단은 404 로 응답 (403 은 "여기 뭔가 있다"를 알려주는 셈)
//   · /whoami 만 예외 — 집 IP 가 바뀌어 막혔을 때 내 IP 를 확인할 유일한 창구
// ============================================================

/** ::ffff:1.2.3.4 → 1.2.3.4 (IPv4-mapped IPv6 정규화) */
function normalize(ip: string): string {
  const s = String(ip || "").trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return m ? m[1] : s;
}

function ipToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    // "01" 같은 0 패딩은 거절한다 (파서마다 8진수로 읽어 우회에 쓰인다)
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p[0] === "0")) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

type Rule = { text: string; base: number; mask: number };

function parseAllow(raw: string): Rule[] {
  const out: Rule[] = [];
  for (const tok of String(raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [ipPart, bitsPart] = tok.split("/");
    const base = ipToLong(ipPart);
    if (base == null) continue;
    const bits = bitsPart == null ? 32 : Number(bitsPart);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    out.push({ text: tok, base: (base & mask) >>> 0, mask });
  }
  return out;
}

const RULES = parseAllow(env.MARKET_WATCH_ALLOWED_IPS ?? "");
const ALLOW_ANY = env.MARKET_WATCH_ALLOW_ANY_IP === "yes-i-am-sure";
/** /api/control 변경 요청에 요구하는 비밀키. 없으면 쓰기를 거부한다(열어 두지 않는다). */
const CONTROL_SECRET = String(env.MARKET_WATCH_CONTROL_SECRET ?? "").trim();

function allowed(ip: string): boolean {
  if (ALLOW_ANY) return true;
  const n = ipToLong(ip);
  if (n == null) return false;
  return RULES.some((r) => ((n & r.mask) >>> 0) === r.base);
}

// ── 시작 시 상태를 소리 내어 알린다 ────────────────
//  예전엔 목록이 비면 **조용히** 게이트가 꺼졌다. 화면은 완벽히 잘 돌아가므로
//  운영자가 알아챌 방법이 전혀 없었다. 오타 하나로 유일한 방어선이 사라지는데도.
if (ALLOW_ANY) {
  console.warn("[market-watch] ⚠ MARKET_WATCH_ALLOW_ANY_IP 가 켜져 있습니다 — IP 게이트 없음");
} else if (RULES.length === 0) {
  console.warn(
    "[market-watch] ⚠ MARKET_WATCH_ALLOWED_IPS 에 유효한 규칙이 없습니다 — **모든 요청을 차단**합니다.\n" +
    "   로컬 개발이면 MARKET_WATCH_ALLOW_ANY_IP=yes-i-am-sure 를 쓰세요."
  );
} else {
  console.log(`[market-watch] IP 게이트 활성 — 규칙 ${RULES.length}개`);
}
if (!CONTROL_SECRET) {
  console.warn("[market-watch] ⚠ MARKET_WATCH_CONTROL_SECRET 이 없습니다 — /api/control 쓰기가 거부됩니다");
}

/** 상수시간 비교 — 길이가 다르면 즉시 false (타이밍 정보를 주지 않기 위해 길이를 먼저 본다) */
function secretEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Authorization: Bearer <token> 또는 ?key= (운영자가 브라우저에서 쓰기 편하게) */
function presentedToken(event: { request: Request; url: URL }): string {
  const m = /^Bearer\s+(.+)$/i.exec(String(event.request.headers.get("authorization") || ""));
  if (m) return m[1].trim();
  return (event.url.searchParams.get("key") || "").trim();
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const handle: Handle = async ({ event, resolve }) => {
  // ★ fail-CLOSED. 예전엔 여기서 `return resolve(event)` 로 **전부 통과**시켰다.
  //   이 파일 머리말이 "목록이 비면 전부 차단"이라고 선언하고 있는데 구현이 정반대였고,
  //   parseAllow 는 형식이 어긋난 토큰을 조용히 버리므로(IPv6·호스트명·0 패딩 옥텟)
  //   오타 하나면 규칙이 0개가 되어 /control 이 인터넷 전체에 열렸다.
  //   그 뒤에 있는 건 인증 없는 쓰기 경로다 — 아무나 방송에 가짜 속보를 띄울 수 있다.
  //   로컬 개발은 ALLOW_ANY 로 **명시적으로** 열게 한다. 빈 목록에서 유추하지 않는다.
  if (RULES.length === 0 && !ALLOW_ANY) {
    if (event.url.pathname === "/whoami") {
      let probe = "";
      try { probe = normalize(event.getClientAddress()); } catch { /* 알 수 없으면 빈 값 */ }
      return new Response(
        JSON.stringify({ ip: probe, allowed: false, reason: "allowlist empty — all requests blocked" }),
        { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  let ip = "";
  try {
    ip = normalize(event.getClientAddress());
  } catch {
    ip = "";
  }

  // 내 IP 확인 창구 — 허용목록과 무관하게 항상 응답한다 (자기 IP 만 알려주므로 안전)
  if (event.url.pathname === "/whoami") {
    return new Response(JSON.stringify({ ip, allowed: allowed(ip) }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  // ── 쓰기 인증 (IP 와 **독립적인 두 번째 겹**) ────────
  //  IP 만으로는 부족하다. install.sh 가 127.0.0.1 을 영구 허용으로 심으므로
  //  **같은 서버의 다른 프로세스**(피드 서버, cron, 같이 도는 다른 앱)의 SSRF 하나면
  //  `curl localhost:6211/api/control` 로 방송에 임의 문구를 띄울 수 있다.
  //  또 install.sh 는 휴대폰에서 공인 IP 로 접속하라고 안내하는데, 셀룰러는 통신사
  //  CGNAT 뒤라 그 주소를 넣는 순간 **같은 CGNAT 가입자 전원**에게 제어판이 열린다.
  //  그래서 변경 요청은 IP 와 무관하게 비밀키를 요구한다.
  if (MUTATING.has(event.request.method) && event.url.pathname.startsWith("/api/control")) {
    if (!CONTROL_SECRET) {
      return new Response(JSON.stringify({ error: "MARKET_WATCH_CONTROL_SECRET 이 설정되지 않았습니다" }), {
        status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" }
      });
    }
    const got = presentedToken(event);
    if (!got || !secretEq(got, CONTROL_SECRET)) {
      console.warn(`[market-watch] 제어 쓰기 거부: ${ip} → ${event.request.method} ${event.url.pathname}`);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" }
      });
    }
  }

  if (!allowed(ip)) {
    console.warn(`[market-watch] 차단된 IP: ${ip} → ${event.request.method} ${event.url.pathname}`);
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  return resolve(event);
};
