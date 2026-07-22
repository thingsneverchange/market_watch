// ============================================================
//  상태 페이지 — 브라우저로 들어왔을 때 보여줄 화면
//
//  "IP 로 들어가서 확인" 이 raw JSON 이면 확인이 안 된다.
//  지금 무엇이 들어 있고, 얼마나 낡았고, 오버레이가 이걸 쓸지 폴백할지를
//  한눈에 보여준다.
// ============================================================
import { KINDS } from "./db.mjs";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

function age(sec) {
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.round(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.round(sec / 3600)}시간 전`;
  return `${Math.round(sec / 86400)}일 전`;
}

function renderItem(kind, it) {
  const cfg = KINDS[kind];
  if (!it) {
    return `<div class="card empty">
      <div class="k">${esc(cfg.label)}</div>
      <div class="none">아직 데이터 없음 — 오버레이는 규칙기반으로 동작합니다</div>
    </div>`;
  }
  const p = it.payload;
  let body = "";
  if (kind === "top_story") {
    body = `<div class="txt">${esc(p.text)}</div>
      <div class="why">${esc(p.why)}</div>
      <div class="meta">방향 <b class="s-${esc(p.sentiment)}">${esc(p.sentiment)}</b> · 확신도 <b>${esc(p.confidence)}</b></div>
      <details><summary>출처 ${p.sources.length}건</summary><ul>${p.sources
        .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title)}</a></li>`)
        .join("")}</ul></details>`;
  } else if (kind === "key_event") {
    body = `<div class="txt">${esc(p.title)}</div>
      <div class="why">${esc(p.note)}</div>
      <div class="meta">${esc(p.whenET)} · 중요도 ${esc(p.importance)}/5${p.estimated ? " · <b>시각 추정치</b>" : ""}</div>`;
  } else {
    body = `<ul class="notes">${p.notes
      .map((n) => `<li><b>${esc(n.ticker)}</b> ${esc(n.note)}</li>`)
      .join("")}</ul>`;
  }
  return `<div class="card ${it.stale ? "stale" : "fresh"}">
    <div class="k">${esc(cfg.label)}
      <span class="badge ${it.stale ? "b-stale" : "b-fresh"}">${it.stale ? "STALE — 오버레이가 폴백함" : "신선함 — 오버레이가 사용중"}</span>
    </div>
    ${body}
    <div class="foot">${age(it.ageSec)} 생성 · ${esc(it.model ?? "?")} · 유효기간 ${Math.round(cfg.maxAgeMs / 60000)}분</div>
  </div>`;
}

export function statusPage({ feed, yourIp, allowedRules, denied }) {
  const cards = Object.keys(KINDS).map((k) => renderItem(k, feed.items[k])).join("\n");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>market-feed 상태</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0d11;color:#e8eaed;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;padding:20px}
.wrap{max-width:820px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8a919b;font-size:13px;margin-bottom:20px}
.card{background:#12151b;border:1px solid #23272f;border-left:4px solid #39d98a;border-radius:10px;padding:14px 16px;margin-bottom:14px}
.card.stale{border-left-color:#f5a623}
.card.empty{border-left-color:#4b5563}
.k{font-size:11px;font-weight:800;letter-spacing:.08em;color:#8a919b;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:0}
.b-fresh{background:#0d1712;color:#39d98a;border:1px solid #16281d}
.b-stale{background:#1a140a;color:#f5a623;border:1px solid #2e2410}
.txt{font-size:19px;font-weight:700;line-height:1.35;margin-bottom:6px}
.why{color:#aab1bb;font-size:14px;margin-bottom:8px}
.meta{font-size:12px;color:#8a919b}
.foot{margin-top:10px;padding-top:8px;border-top:1px solid #1c2027;font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums}
.none{color:#6b7280}
.s-pos{color:#39d98a}.s-neg{color:#ff5c5c}.s-neu{color:#9aa3ad}
ul{margin:6px 0;padding-left:18px}li{margin:3px 0}
.notes li{color:#c7cdd6;font-size:14px}
a{color:#7db0e8}
details summary{cursor:pointer;color:#8a919b;font-size:12px;margin-top:6px}
.info{background:#101318;border:1px solid #1c2027;border-radius:10px;padding:12px 16px;font-size:13px;color:#9aa3ad;margin-top:22px}
.info b{color:#c7cdd6}
code{background:#0b0d11;padding:1px 5px;border-radius:4px;font-size:12px;color:#c7cdd6}
</style></head><body><div class="wrap">
<h1>market-feed</h1>
<div class="sub">Claude Code 가 만든 판단을 오버레이가 읽어갑니다 · 접속 IP <b>${esc(yourIp)}</b></div>
${cards}
<div class="info">
  <b>여기는 데이터 저장소입니다. 방송 화면이 아닙니다.</b><br>
  방송 화면은 맥에서 <code>npm run dev</code> 후 <code>http://localhost:5173</code> 입니다.<br><br>
  <b>허용 IP</b> ${allowedRules.map((r) => `<code>${esc(r)}</code>`).join(" ")}<br>
  IP 가 바뀌면 <code>ssh root@165.232.146.7 '/home/market-feed/feed-server/deploy/allow-ip.sh auto'</code>
  ${denied.length ? `<br><br><b>최근 차단</b> ${denied.slice(0, 5).map((d) => `<code>${esc(d.ip)}</code>×${d.count}`).join(" ")}` : ""}
</div>
</div></body></html>`;
}
