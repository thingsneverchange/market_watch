import type { RequestHandler } from "./$types";
import { env } from "$env/dynamic/private";

// ============================================================
//  피드 서버 운영 설정 프록시 (/control 이 쓴다)
//
//  읽기키는 **서버에서만** 쓴다 — 브라우저로 절대 내보내지 않는다.
//  그래서 /control 은 이 라우트를 통해서만 피드 서버 설정을 읽고 쓴다.
// ============================================================

function cfg() {
  const base = String(env.MARKET_FEED_URL || "").replace(/\/+$/, "");
  const key = String(env.MARKET_READ_KEY || "").trim();
  return base && key ? { base, key } : null;
}

const TIMEOUT_MS = 5000;

export const GET: RequestHandler = async () => {
  const c = cfg();
  if (!c) return json({ briefCadence: "auto", configured: false });
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const r = await fetch(`${c.base}/api/settings`, {
      headers: { authorization: `Bearer ${c.key}` },
      signal: ctl.signal,
      cache: "no-store"
    }).finally(() => clearTimeout(timer));
    if (!r.ok) return json({ briefCadence: "auto", configured: false });
    const j: any = await r.json();
    return json({ briefCadence: j?.briefCadence ?? "auto", configured: true });
  } catch {
    return json({ briefCadence: "auto", configured: false });
  }
};

export const POST: RequestHandler = async ({ request }) => {
  const c = cfg();
  if (!c) return json({ ok: false, error: "feed server not configured" }, 503);
  let body: any = {};
  try { body = await request.json(); } catch {}
  const v = String(body?.briefCadence ?? "");
  // 화이트리스트는 피드 서버에도 있지만 여기서도 막는다 (왕복 낭비 방지)
  if (!["auto", "10m", "30m", "2h", "off"].includes(v)) {
    return json({ ok: false, error: "invalid cadence" }, 422);
  }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const r = await fetch(`${c.base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ briefCadence: v }),
      signal: ctl.signal,
      cache: "no-store"
    }).finally(() => clearTimeout(timer));
    const j: any = await r.json().catch(() => ({}));
    return json({ ok: r.ok, briefCadence: j?.briefCadence ?? v }, r.ok ? 200 : 502);
  } catch {
    return json({ ok: false, error: "feed server unreachable" }, 502);
  }
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
