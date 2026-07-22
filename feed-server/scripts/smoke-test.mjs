// market-feed 전체 동작 검증 (서버가 떠 있어야 함)
const BASE = (process.env.MARKET_FEED_URL || "http://127.0.0.1:6210").replace(/\/+$/, "");
const WRITE = process.env.MARKET_WRITE_SECRET || "";
const READ = process.env.MARKET_READ_KEY || "";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log(`  ✅ ${n}${extra && " — " + extra}`)) : (fail++, console.log(`  ❌ ${n}${extra && " — " + extra}`)); };

const req = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts);
  let body = null;
  try { body = JSON.parse(await r.text()); } catch { /* ignore */ }
  return { status: r.status, body };
};
const write = (kind, payload, extra = {}) =>
  req(`/api/feed/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${WRITE}` },
    body: JSON.stringify({ payload, model: "smoke-test", ...extra })
  });

console.log("\n=== 1. 헬스체크 ===");
{
  const r = await req("/health");
  ok("GET /health 200", r.status === 200 && r.body?.ok === true);
}

console.log("\n=== 2. 인증 ===");
{
  ok("읽기: 키 없으면 401", (await req("/api/feed")).status === 401);
  ok("읽기: 틀린 키면 401", (await req("/api/feed?key=wrong")).status === 401);
  ok("읽기: 맞는 키면 200", (await req(`/api/feed?key=${READ}`)).status === 200);

  const asRead = await req("/api/feed/top_story", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${READ}` },
    body: JSON.stringify({ payload: {} })
  });
  ok("★ 읽기키로는 쓰기 불가 (401)", asRead.status === 401, "키 분리가 실제로 작동");
}

console.log("\n=== 3. 검증 — 잘못된 페이로드는 거절돼야 한다 ===");
{
  const cases = [
    ["빈 객체", "top_story", {}],
    ["sentiment 오타", "top_story", { text: "a", sentiment: "bull", why: "b", confidence: "high", sources: [{ title: "t", url: "https://x.com" }] }],
    ["출처 없음", "top_story", { text: "a", sentiment: "neu", why: "b", confidence: "high", sources: [] }],
    ["출처 URL이 http 아님", "top_story", { text: "a", sentiment: "neu", why: "b", confidence: "high", sources: [{ title: "t", url: "javascript:alert(1)" }] }],
    ["text 160자 초과", "top_story", { text: "가".repeat(161), sentiment: "neu", why: "b", confidence: "high", sources: [{ title: "t", url: "https://x.com" }] }],
    ["과거 이벤트", "key_event", { title: "옛날", whenET: "2020-01-01T10:00:00-05:00", importance: 5, note: "n" }],
    ["importance 범위 밖", "key_event", { title: "t", whenET: new Date(Date.now() + 86400e3).toISOString(), importance: 9, note: "n" }],
    ["ticker 형식 위반", "earnings_note", { notes: [{ ticker: "not a ticker!", note: "n" }] }]
  ];
  for (const [name, kind, payload] of cases) {
    const r = await write(kind, payload);
    ok(`거절: ${name}`, r.status === 422, r.status === 422 ? r.body?.error?.slice(0, 60) : `status=${r.status}`);
  }
}

console.log("\n=== 4. 정상 쓰기 → 읽기 왕복 ===");
{
  const now = Date.now();
  const r1 = await write("top_story", {
    text: "연준 위원 발언에 국채금리 하락, 기술주 반등",
    sentiment: "pos",
    why: "9월 인하 가능성이 재부각되며 금리 민감 섹터가 먼저 움직였다.",
    confidence: "medium",
    sources: [{ title: "Fed official signals openness to cuts", url: "https://example.com/a" }]
  }, { generatedAt: now });
  ok("top_story 쓰기 200", r1.status === 200);

  const r2 = await write("key_event", {
    title: "FOMC 금리 결정",
    whenET: new Date(now + 5 * 86400e3).toISOString(),
    importance: 5,
    note: "점도표가 함께 공개돼 연내 인하 횟수 전망이 바뀔 수 있다.",
    estimated: false
  }, { generatedAt: now });
  ok("key_event 쓰기 200", r2.status === 200);

  const r3 = await write("earnings_note", {
    notes: [{ ticker: "ARM", note: "AI 데이터센터 로열티 비중이 관건." }]
  }, { generatedAt: now });
  ok("earnings_note 쓰기 200", r3.status === 200);

  const g = await req(`/api/feed?key=${READ}`);
  ok("읽기 200", g.status === 200);
  ok("3종류 모두 존재", Object.keys(g.body?.items ?? {}).length === 3);
  ok("top_story 내용 일치", g.body?.items?.top_story?.payload?.text?.includes("연준"));
  ok("ageSec 제공됨", Number.isFinite(g.body?.items?.top_story?.ageSec));
  ok("갓 쓴 항목은 stale=false", g.body?.items?.top_story?.stale === false);
  ok("제어문자/줄바꿈 정리됨", !/[\n\r]/.test(g.body?.items?.top_story?.payload?.text ?? ""));
}

console.log("\n=== 5. 신선도 — 낡은 항목은 stale 로 표시돼야 한다 ===");
{
  // top_story 의 maxAge 는 90분. 3시간 전에 생성된 것으로 밀어넣는다.
  await new Promise((r) => setTimeout(r, 5100)); // 쓰기 레이트리밋 회피
  const old = Date.now() - 3 * 3600e3;
  const w = await write("top_story", {
    text: "세 시간 전에 만들어진 오래된 판단",
    sentiment: "neu", why: "신선도 테스트", confidence: "low",
    sources: [{ title: "t", url: "https://example.com/old" }]
  }, { generatedAt: old });
  ok("과거 generatedAt 쓰기 허용", w.status === 200);

  const g = await req(`/api/feed?key=${READ}`);
  const it = g.body?.items?.top_story;
  ok("★ 낡은 항목이 stale=true 로 표시됨", it?.stale === true, `age=${Math.round((it?.ageSec ?? 0) / 60)}분`);
  ok("ageSec 이 실제 나이 반영", (it?.ageSec ?? 0) > 3 * 3600 - 120);
}

console.log("\n=== 6. 미래 시각 조작 방어 ===");
{
  await new Promise((r) => setTimeout(r, 5100));
  const w = await write("top_story", {
    text: "미래에서 온 판단", sentiment: "neu", why: "x", confidence: "low",
    sources: [{ title: "t", url: "https://example.com/f" }]
  }, { generatedAt: Date.now() + 10 * 86400e3 });
  const g = await req(`/api/feed?key=${READ}`);
  ok("★ 미래 generatedAt 은 현재로 클램프됨", w.status === 200 && (g.body?.items?.top_story?.ageSec ?? -1) >= 0,
     "영원히 신선한 척하는 항목을 만들 수 없다");
}

console.log("\n=== 7. 쓰기 레이트리밋 ===");
{
  const p = { text: "a", sentiment: "neu", why: "b", confidence: "low", sources: [{ title: "t", url: "https://example.com" }] };
  await write("top_story", p);
  const second = await write("top_story", p);
  ok("연속 쓰기는 429", second.status === 429);
}

console.log("\n=== 8. 히스토리 ===");
{
  const h = await req(`/api/feed/history/top_story?key=${READ}&limit=5`);
  ok("히스토리 조회 200", h.status === 200);
  ok("히스토리 기록됨", (h.body?.history?.length ?? 0) >= 2);
}

console.log(`\n${"=".repeat(46)}\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail === 0 ? 0 : 1);
