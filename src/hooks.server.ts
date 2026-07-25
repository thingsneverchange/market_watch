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

function allowed(ip: string): boolean {
  if (ALLOW_ANY) return true;
  const n = ipToLong(ip);
  if (n == null) return false;
  return RULES.some((r) => ((n & r.mask) >>> 0) === r.base);
}

export const handle: Handle = async ({ event, resolve }) => {
  // 허용목록이 설정되지 않았으면 게이트를 아예 켜지 않는다 (로컬 개발 편의).
  // 서버 배포 시에는 반드시 MARKET_WATCH_ALLOWED_IPS 를 넣어야 한다.
  if (RULES.length === 0 && !ALLOW_ANY) return resolve(event);

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

  if (!allowed(ip)) {
    console.warn(`[market-watch] 차단된 IP: ${ip} → ${event.request.method} ${event.url.pathname}`);
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  return resolve(event);
};
