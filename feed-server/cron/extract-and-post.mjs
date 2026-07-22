// ============================================================
//  Claude 출력에서 JSON 을 뽑아 market-feed 로 POST 한다.
//
//  원칙: 애매하면 보내지 않는다.
//  LLM 이 펜스나 잡담을 붙이는 건 관대하게 처리하되, JSON 을 확신할 수 없으면
//  추측해서 보내는 대신 실패로 끝낸다 — 방송 화면에 쓰레기를 올리는 것보다 낫다.
// ============================================================

const raw = process.env.RAW_TEXT ?? "";
const kind = process.env.KIND ?? "";
const model = process.env.MODEL ?? null;
const generatedAt = Number(process.env.GEN_AT) || Date.now();
const base = (process.env.MARKET_FEED_URL || "http://127.0.0.1:6210").replace(/\/+$/, "");
const secret = process.env.MARKET_WRITE_SECRET || "";

function fail(msg) {
  console.error(`[extract] ${msg}`);
  process.exit(1);
}

/** 관대한 JSON 추출: 펜스 제거 → 통째 파싱 → 첫 균형 잡힌 { } 블록 파싱 */
function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  for (const c of candidates) {
    const t = c.trim();
    try {
      return JSON.parse(t);
    } catch {
      /* 아래에서 부분 추출 시도 */
    }
    // 중괄호 균형을 세어 첫 완결 객체를 잘라낸다 (문자열 안의 괄호는 무시)
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") { if (depth === 0) start = i; depth++; }
      else if (ch === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            return JSON.parse(t.slice(start, i + 1));
          } catch { start = -1; }
        }
      }
    }
  }
  return null;
}

const payload = extractJson(raw);
if (!payload) {
  fail(`JSON 을 추출하지 못했습니다. Claude 원본 출력(앞 500자):\n${raw.slice(0, 500)}`);
}
if (!secret) fail("MARKET_WRITE_SECRET 이 없습니다");
if (!kind) fail("KIND 가 없습니다");

const res = await fetch(`${base}/api/feed/${kind}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${secret}`
  },
  body: JSON.stringify({ payload, model, generatedAt })
}).catch((e) => fail(`market-feed 연결 실패: ${e.message}`));

const text = await res.text();
if (!res.ok) {
  // 422 면 프롬프트가 형식을 어긴 것 — 이유가 그대로 로그에 남아야 고칠 수 있다
  fail(`서버가 거절했습니다 (HTTP ${res.status}): ${text}`);
}
console.log(text);
