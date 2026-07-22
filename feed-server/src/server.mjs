// ============================================================
//  market-feed — Claude Code 가 쓰고 market_watch 가 읽는 작은 피드 서비스
//
//  · 의존성 0개 (node:http / node:sqlite / node:crypto 만 사용)
//  · themecloset_builder 코드는 한 줄도 건드리지 않는다 (독립 프로세스/포트/DB)
//  · 인증: 쓰기키와 읽기키를 **분리**. 읽기키가 새도 데이터를 못 덮어쓴다.
//    (themecloset_builder 의 worker-request-auth.ts 패턴을 그대로 따름)
// ============================================================
import http from "node:http";
import crypto from "node:crypto";
import { openDb, putItem, getAll, getHistory, stats, KINDS } from "./db.mjs";
import { validate } from "./validate.mjs";
import { parseAllowList, normalizeRemote, isAllowed, recordDenied, deniedSummary } from "./ipallow.mjs";

const PORT = Number(process.env.PORT || 6210);
const HOST = process.env.HOST || "127.0.0.1";

// ── IP 허용목록 ───────────────────────────────────────
// 이 서버엔 방화벽이 없다. 여기가 유일한 차단 지점이다.
const { rules: ALLOW_RULES, bad: BAD_RULES } = parseAllowList(process.env.MARKET_ALLOWED_IPS);
// 0.0.0.0/0 을 실수로 넣으면 전 세계에 열린다 — 명시적으로 켜야만 허용한다.
const ALLOW_ANY = process.env.MARKET_ALLOW_ANY_IP === "yes-i-am-sure";
const DB_FILE = process.env.MARKET_DB_FILE || new URL("../data/feed.db", import.meta.url).pathname;
const MAX_BODY = 64 * 1024; // 이 피드에 64KB 넘는 요청이 올 이유가 없다

// ★ 비밀값은 절대 모듈 로드 시점에 상수로 굳히지 않는다 (lazy read).
//   themecloset_builder 의 회귀 테스트가 강제하는 규칙과 동일 —
//   PM2 가 dotenv 를 나중에 주입해도 안전해야 한다.
const readSecret = (name) => String(process.env[name] || "").trim();

function timingSafeEq(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // 길이가 달라도 상수시간을 흉내내어 길이 오라클을 줄인다
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** Authorization: Bearer <token> 또는 ?key= (오버레이가 <img>/fetch 로 쓰기 편하게) */
function presentedToken(req, url) {
  const h = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  const q = url.searchParams.get("key");
  return q ? q.trim() : "";
}

function authorize(req, url, secretName) {
  const expected = readSecret(secretName);
  if (!expected) return { ok: false, status: 503, message: `${secretName} 가 설정되지 않았습니다` };
  const got = presentedToken(req, url);
  if (!got || !timingSafeEq(got, expected)) return { ok: false, status: 401, message: "Unauthorized" };
  return { ok: true };
}

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- 아주 단순한 쓰기 레이트리밋 (같은 kind 를 초당 여러 번 밀어넣지 못하게) ----
const lastWrite = new Map();
const MIN_WRITE_INTERVAL_MS = 5_000;

openDb(DB_FILE);

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return send(res, 400, { error: "bad url" });
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // ── 원격 IP 확인 (프록시 헤더는 신뢰하지 않는다 — 위조 가능) ──
  const remote = normalizeRemote(req.socket.remoteAddress);

  // /whoami 는 허용목록 **전에** 처리한다.
  // 집 IP 가 바뀌어 접속이 막혔을 때, 내 현재 IP 를 확인할 유일한 창구다.
  // 자기 자신의 IP 만 돌려주므로 노출되는 정보가 없다.
  if (req.method === "GET" && path === "/whoami") {
    return send(res, 200, { ip: remote, allowed: ALLOW_ANY || isAllowed(remote, ALLOW_RULES) });
  }

  if (!ALLOW_ANY && !isAllowed(remote, ALLOW_RULES)) {
    recordDenied(remote);
    console.warn(`[market-feed] 차단된 IP: ${remote} → ${req.method} ${path}`);
    // 404 로 응답한다. 403 은 "여기 뭔가 있다"를 알려주는 셈이라,
    // 스캐너에게는 아무것도 없는 것처럼 보이는 편이 낫다.
    return send(res, 404, { error: "not found" });
  }

  try {
    // ---------- 헬스체크 (허용 IP 만, 데이터 노출 없음) ----------
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return send(res, 200, {
        ok: true,
        service: "market-feed",
        yourIp: remote,
        allowedRules: ALLOW_RULES.map((r) => r.text),
        recentDenied: deniedSummary(),
        ...stats()
      });
    }

    // ---------- 읽기 ----------
    if (req.method === "GET" && path === "/api/feed") {
      const auth = authorize(req, url, "MARKET_READ_KEY");
      if (!auth.ok) return send(res, auth.status, { error: auth.message });
      return send(res, 200, getAll());
    }

    if (req.method === "GET" && path.startsWith("/api/feed/history/")) {
      const auth = authorize(req, url, "MARKET_READ_KEY");
      if (!auth.ok) return send(res, auth.status, { error: auth.message });
      const kind = path.split("/").pop();
      if (!KINDS[kind]) return send(res, 404, { error: `알 수 없는 kind: ${kind}` });
      return send(res, 200, { kind, history: getHistory(kind, Number(url.searchParams.get("limit") || 20)) });
    }

    // ---------- 쓰기 (Claude Code cron 전용) ----------
    if (req.method === "POST" && path.startsWith("/api/feed/")) {
      const auth = authorize(req, url, "MARKET_WRITE_SECRET");
      if (!auth.ok) return send(res, auth.status, { error: auth.message });

      const kind = path.split("/").pop();
      if (!KINDS[kind]) return send(res, 404, { error: `알 수 없는 kind: ${kind}` });

      const prev = lastWrite.get(kind) || 0;
      if (Date.now() - prev < MIN_WRITE_INTERVAL_MS) {
        return send(res, 429, { error: `${kind}: 쓰기가 너무 잦습니다 (최소 ${MIN_WRITE_INTERVAL_MS / 1000}초 간격)` });
      }

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return send(res, e.status === 413 ? 413 : 400, { error: "JSON 파싱 실패" });
      }

      const v = validate(kind, body.payload);
      if (!v.ok) {
        // 거절 이유를 명확히 돌려줘야 cron 로그만 보고 프롬프트를 고칠 수 있다
        console.warn(`[market-feed] ${kind} 거절: ${v.error}`);
        return send(res, 422, { error: v.error, hint: "payload 형식을 확인하세요" });
      }

      // generatedAt 은 Claude 가 만든 시각. 안 주면 지금으로 보되, 미래는 허용하지 않는다.
      const now = Date.now();
      let generatedAt = Number(body.generatedAt);
      if (!Number.isFinite(generatedAt) || generatedAt <= 0) generatedAt = now;
      if (generatedAt > now + 60_000) generatedAt = now;

      const saved = putItem({
        kind,
        payload: v.payload,
        model: typeof body.model === "string" ? body.model.slice(0, 60) : null,
        generatedAt
      });
      lastWrite.set(kind, now);
      console.log(`[market-feed] ${kind} 갱신됨 (model=${body.model ?? "?"})`);
      return send(res, 200, { ok: true, ...saved });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[market-feed] 처리 실패:", err);
    return send(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[market-feed] listening on http://${HOST}:${PORT}  db=${DB_FILE}`);
  for (const name of ["MARKET_WRITE_SECRET", "MARKET_READ_KEY"]) {
    if (!readSecret(name)) console.warn(`[market-feed] ⚠️ ${name} 미설정 — 해당 엔드포인트는 503 을 반환합니다`);
  }
  if (BAD_RULES.length) {
    console.warn(`[market-feed] ⚠️ 해석 불가한 IP 규칙 (무시됨): ${BAD_RULES.join(", ")}`);
  }
  if (ALLOW_ANY) {
    console.warn("[market-feed] 🚨 MARKET_ALLOW_ANY_IP 가 켜져 있습니다 — 전 세계에 열려 있습니다");
  } else if (ALLOW_RULES.length === 0) {
    // fail-closed: 설정 실수로 전체 공개되는 사고를 원천 차단한다
    console.warn("[market-feed] ⚠️ MARKET_ALLOWED_IPS 가 비어 있어 /whoami 외 모든 요청을 차단합니다");
  } else {
    console.log(`[market-feed] 허용 IP: ${ALLOW_RULES.map((r) => r.text).join(", ")}`);
  }
  if (HOST === "0.0.0.0") {
    console.log("[market-feed] 0.0.0.0 바인딩 — 이 서버엔 방화벽이 없으므로 IP 허용목록이 유일한 방어선입니다");
  }
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[market-feed] ${sig} 수신 — 종료합니다`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
