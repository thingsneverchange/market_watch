// ============================================================
//  속보 사이렌 게이트 — 사이렌을 울리기 전에 피드 서버(haiku)로 1회 검증한다.
//
//  흐름:
//   1) breaking 라우트가 "사이렌감(kind=breaking)" 항목을 classifyAlert() 에 넘긴다.
//   2) 처음 보는 항목은 pending 으로 등록하고 백그라운드로 피드 서버에 검증을 요청한다.
//      → 그 폴에서는 보류(withhold). "확인하고 나서 사이렌" 원칙.
//   3) 다음 폴(≤15초)에서 판정이 오면:
//        real/unsure → "ok"  (사이렌 유지)
//        noise       → "noise"(무음 UPDATE 로 강등)
//
//  실패 철학: fail-open. 검증기 미설정·타임아웃·오류는 전부 "ok" 로 흘려보낸다.
//            (인프라가 잠깐 죽었다고 진짜 속보를 삼키지 않는다)
// ============================================================
import { env } from "$env/dynamic/private";

type Status = "pending" | "real" | "noise" | "unsure";
type Entry = { status: Status; at: number };

const RESOLVED_TTL_MS = 30 * 60_000; // 판정 캐시 유효기간
// 피드 서버의 검증(claude -p)이 실측 ~11초, 타임아웃 22초다. 클라이언트는 그보다 넉넉히 잡아
// 서버 판정을 끝까지 기다린다 (성급히 끊어 fail-open 하면 검증이 무의미해진다).
const FETCH_TIMEOUT_MS = 26_000;
const PENDING_TIMEOUT_MS = 30_000;   // 이보다 오래 pending 이면 fail-open (백스톱)

const state = new Map<string, Entry>();

function cfg(): { base: string; key: string } | null {
  const base = String(env.MARKET_FEED_URL || "").replace(/\/+$/, "");
  const key = String(env.MARKET_READ_KEY || "").trim();
  return base && key ? { base, key } : null;
}

export type AlertGate = "off" | "ok" | "noise" | "pending";

/**
 * 동기 반환. 처음 보는 항목이면 백그라운드 검증을 시작하고 "pending" 을 돌려준다.
 * 라우트를 절대 블로킹하지 않는다.
 */
export function classifyAlert(item: { id: string; title: string; source?: string; ageSec?: number }): AlertGate {
  const c = cfg();
  if (!c) return "off"; // 검증기 미설정 → 게이트 없음(기존 동작 그대로)

  const now = Date.now();
  const e = state.get(item.id);
  if (e) {
    if (e.status === "pending") {
      if (now - e.at > PENDING_TIMEOUT_MS) { e.status = "unsure"; e.at = now; return "ok"; }
      return "pending";
    }
    if (now - e.at < RESOLVED_TTL_MS) return e.status === "noise" ? "noise" : "ok";
    state.delete(item.id); // 만료 → 재검증
  }

  state.set(item.id, { status: "pending", at: now });
  void verifyRemote(c, item);
  if (state.size > 300) sweep(now);
  return "pending";
}

async function verifyRemote(c: { base: string; key: string }, item: { id: string; title: string; source?: string; ageSec?: number }) {
  let status: Status = "unsure";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(`${c.base}/api/verify-alert`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ title: item.title, source: item.source ?? "", ageSec: item.ageSec ?? 0 }),
      signal: ctl.signal,
      cache: "no-store"
    }).finally(() => clearTimeout(timer));
    if (r.ok) {
      const j: any = await r.json();
      status = j?.verdict === "noise" ? "noise" : j?.verdict === "real" ? "real" : "unsure";
    }
  } catch {
    status = "unsure";
  }
  state.set(item.id, { status, at: Date.now() });
}

function sweep(now: number) {
  for (const [id, e] of state) if (now - e.at > RESOLVED_TTL_MS && e.status !== "pending") state.delete(id);
}
