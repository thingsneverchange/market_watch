// ============================================================
//  속보 검증기 — 사이렌을 울리기 전에 "이게 진짜 시장을 움직이는 속보인가?"를
//  값싼 모델(haiku)에게 한 번 물어본다.
//
//  왜:
//   · breaking 라우트의 키워드 스코어러는 "beats estimates" 같은 문구만 봐도 L4/L5 를 준다.
//     그래서 오피니언·예고·잡기사가 사이렌을 울리는 오탐이 실제로 있었다.
//   · headline 텍스트만 읽고 판단하면 되는 일이라 도구·웹검색이 필요 없다 → 빠르고 싸다.
//
//  비용: 구독 토큰(CLAUDE_CODE_OAUTH_TOKEN)으로 `claude -p` 를 돌린다 → API 종량과금 없음.
//        같은 헤드라인은 1시간 캐시하므로 유니크 속보당 정확히 1회만 모델을 부른다.
//
//  실패 철학: fail-open. 스폰 실패/타임아웃/혼잡이면 verdict="unsure" 를 돌려주고,
//            호출자(market_watch)는 그때 기존 규칙대로 사이렌을 울린다.
//            검증 인프라가 잠깐 죽었다고 진짜 속보를 삼키지 않는다.
// ============================================================
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MODEL = process.env.VERIFY_MODEL || "claude-haiku-4-5-20251001";
// `claude -p` 는 CLI 콜드스타트(런타임 로드) 때문에 haiku 여도 실측 ~11초가 걸린다.
// 12초로 잡으면 상시 타임아웃 경계라 "verify failed" 가 잦다 → 넉넉히 22초.
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 22_000);
const CACHE_TTL_MS = 60 * 60_000; // 같은 헤드라인 1시간 캐시
// 동시 1개만. 이 서버는 themecloset 과 램을 공유하고 cron 도 별도로 claude 를 띄운다.
// 속보는 드물어 직렬로 충분하고, 동시에 여러 claude 를 띄워 램을 스파이크시키지 않는다.
const MAX_CONCURRENT = 1;

const cache = new Map(); // hash -> { at, result }
let running = 0;

function keyOf(title) {
  return crypto.createHash("sha1").update(String(title).toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

/** 관대한 JSON 추출 (펜스/잡담 제거, 첫 균형 객체) */
function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  for (const c of [fenced?.[1], text]) {
    if (!c) continue;
    const t = c.trim();
    try { return JSON.parse(t); } catch {}
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") { if (depth === 0) start = i; depth++; }
      else if (ch === "}") { if (--depth === 0 && start >= 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { start = -1; } } }
    }
  }
  return null;
}

function buildPrompt(title, source, ageMin) {
  return (
`You are a market-desk editor deciding whether a news headline deserves a BREAKING siren on a live market broadcast.

Headline: "${String(title).slice(0, 300)}"
Source: ${String(source || "unknown").slice(0, 60)}
Age: ${ageMin} minutes

Judge ONLY from the headline text. A BREAKING siren is justified ONLY if this is a genuine, significant, market-moving event happening NOW — a sharp index/major-stock move, a Fed/rate/CPI/jobs surprise, major M&A, a big earnings surprise, a regulatory or geopolitical shock. It is NOT justified for: opinion/analysis ("should you buy", "is it time to"), previews or scheduling ("to report next week", "announces timing"), minor single-stock noise, listicles/rankings, sponsored/PR, sports/entertainment, or vague/stale items.

Reply with ONLY this JSON and nothing else:
{"marketMoving": true, "verdict": "real", "reason": "<max 8 words>"}
or
{"marketMoving": false, "verdict": "noise", "reason": "<max 8 words>"}`
  );
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    let out = "", done = false;
    let child;
    try {
      child = spawn(CLAUDE_BIN, ["-p", prompt, "--model", MODEL], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill("SIGKILL"); } catch {} resolve(null); } }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {}); // 로그는 흘려보낸다
    child.on("error", () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
    child.on("close", () => { if (!done) { done = true; clearTimeout(timer); resolve(out); } });
  });
}

/**
 * @returns {{marketMoving:boolean, verdict:"real"|"noise"|"unsure", reason:string, cached:boolean}}
 */
export async function verifyAlert({ title, source, ageSec }) {
  const t = String(title || "").trim();
  if (!t) return { marketMoving: true, verdict: "unsure", reason: "empty title", cached: false };

  const hkey = keyOf(t);
  const now = Date.now();
  const hit = cache.get(hkey);
  if (hit && now - hit.at < CACHE_TTL_MS) return { ...hit.result, cached: true };

  // 혼잡하면 검증하지 않고 fail-open (다음 폴에서 캐시로 잡히거나 재시도)
  if (running >= MAX_CONCURRENT) return { marketMoving: true, verdict: "unsure", reason: "verifier busy", cached: false };

  running++;
  try {
    const ageMin = Math.max(0, Math.round(Number(ageSec || 0) / 60));
    const raw = await runClaude(buildPrompt(t, source, ageMin));
    const j = extractJson(raw);
    let result;
    if (j && (j.verdict === "real" || j.verdict === "noise")) {
      result = {
        marketMoving: j.verdict === "real",
        verdict: j.verdict,
        reason: String(j.reason || "").slice(0, 80)
      };
      cache.set(hkey, { at: Date.now(), result }); // 확정 판단만 캐시
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    } else {
      // 모델 실패/파싱 실패 → 캐시하지 않는다 (다음에 다시 시도), fail-open
      result = { marketMoving: true, verdict: "unsure", reason: "verify failed" };
    }
    return { ...result, cached: false };
  } finally {
    running--;
  }
}
