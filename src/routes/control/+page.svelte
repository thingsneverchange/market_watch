<script lang="ts">
  import { onMount } from "svelte";

  let presets: { key: string; label: string }[] = [];
  let activeKey = "";
  let interval = "1";
  let headline = "";
  let level = 5;
  let status = "";
  let lastBreaking = "";

  // ── 라이브 영상 ────────────────────────────────
  // 시스템은 "지금 이런 이벤트가 있다"고 **추천만** 하고, 실제 송출은 여기서 사람이 판단해 누른다.
  let videoUrl = "";
  let liveVideo: { id: string; label: string } | null = null;
  let suggestions: { title: string; impact: string; live: boolean; when: string }[] = [];

  // 공개 소스 바로가기 — 미국 정부 저작물은 퍼블릭 도메인이라 재송출이 안전하다.
  // (반면 CNBC·Bloomberg 등 상업 방송 재송출은 저작권 침해 → 채널 스트라이크 위험)
  const SAFE_SOURCES = [
    { label: "연준 (Federal Reserve)", url: "https://www.youtube.com/@federalreserve/live" },
    { label: "백악관 (White House)", url: "https://www.youtube.com/@WhiteHouse/live" }
  ];

  const INTERVALS = [
    { v: "1", t: "1분" }, { v: "5", t: "5분" }, { v: "15", t: "15분" }, { v: "60", t: "1시간" }, { v: "D", t: "일봉" }
  ];

  async function loadState() {
    try {
      const r = await fetch("/api/control");
      if (r.ok) {
        const j = await r.json();
        presets = j.presets ?? [];
        activeKey = j.chartKey;
        interval = j.chartInterval;
        liveVideo = j.video && j.video.id ? { id: j.video.id, label: j.video.label ?? "" } : null;
      }
    } catch {}
  }

  /** 오늘의 이슈에서 "지금 진행 중이거나 곧 시작하는" 이벤트를 추천으로 뽑는다 */
  async function loadSuggestions() {
    try {
      const r = await fetch("/api/digest");
      if (!r.ok) return;
      const j = await r.json();
      const now = Date.now();
      suggestions = (j.brief ?? [])
        .filter((b: any) => b.startET)
        .map((b: any) => {
          const st = Date.parse(b.startET);
          const dur = (b.durationMin ?? 90) * 60000;
          const live = now >= st && now < st + dur;
          const mins = Math.round((st - now) / 60000);
          return {
            title: b.title, impact: b.impact, live,
            when: live ? "진행 중" : mins > 0 ? `${mins}분 후` : "종료"
          };
        })
        .filter((s: any) => s.live || s.when.endsWith("분 후"));
    } catch {}
  }

  async function sendVideo(url: string, label: string) {
    if (!url.trim()) return;
    await post({ action: "video", url, label });
    await loadState();
    flash(liveVideo ? "영상 송출 시작 ✓" : "URL 형식을 확인하세요");
  }
  async function stopVideo() {
    await post({ action: "clearVideo" });
    await loadState();
    flash("영상 내림");
  }

  async function setChart(key: string) {
    activeKey = key;
    flash(`차트 → ${presets.find(p=>p.key===key)?.label ?? key}`);
    await post({ action: "chart", key, interval });
  }
  async function setInterval(v: string) {
    interval = v;
    flash(`봉 → ${INTERVALS.find(i=>i.v===v)?.t}`);
    await post({ action: "chart", key: activeKey, interval: v });
  }
  async function sendBreaking() {
    const h = headline.trim();
    if (!h) return;
    await post({ action: "breaking", headline: h, level });
    lastBreaking = h;
    headline = "";
    flash("속보 송출됨 ✓");
  }
  async function clearBreaking() {
    await post({ action: "clearBreaking" });
    flash("속보 내림");
  }

  async function post(body: any) {
    try {
      await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch { flash("전송 실패 — 서버 연결 확인"); }
  }

  let flashTimer: any;
  function flash(msg: string) {
    status = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (status = ""), 2500);
  }

  onMount(() => {
    loadState();
    loadSuggestions();
    // 추천은 1분마다 갱신 (이벤트가 시작/종료되면 자동 반영)
    // ※ 이 페이지엔 봉 간격 설정용 로컬 setInterval() 이 있어 전역이 가려진다 → window 로 명시.
    const t = window.setInterval(loadSuggestions, 60000);
    return () => window.clearInterval(t);
  });
</script>

<svelte:head><title>MARKETWATCH · 컨트롤러</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" /></svelte:head>

<div class="ctl">
  <header>
    <div class="ttl">MARKET<span>WATCH</span> · 컨트롤러</div>
    {#if status}<div class="flash">{status}</div>{/if}
  </header>

  <section>
    <h2>📊 차트 심볼</h2>
    <div class="grid">
      {#each presets as p}
        <button class="btn sym" class:on={p.key === activeKey} on:click={() => setChart(p.key)}>{p.label}</button>
      {/each}
    </div>
  </section>

  <section>
    <h2>⏱ 봉 간격</h2>
    <div class="grid iv">
      {#each INTERVALS as i}
        <button class="btn iv-b" class:on={i.v === interval} on:click={() => setInterval(i.v)}>{i.t}</button>
      {/each}
    </div>
  </section>

  <section>
    <h2>🎥 라이브 영상</h2>
    {#if liveVideo}
      <div class="vid-on">
        <span class="vid-dot"></span>
        <span class="vid-lbl">송출 중 — {liveVideo.label || liveVideo.id}</span>
        <button class="btn vstop" on:click={stopVideo}>내리기</button>
      </div>
    {/if}

    <!-- 시스템 추천: '오늘의 이슈' 중 진행 중이거나 곧 시작하는 이벤트. 판단은 사람이 한다. -->
    {#if suggestions.length}
      <div class="sug-lbl">추천 — 지금 볼 만한 이벤트</div>
      {#each suggestions as s}
        <div class="sug" class:live={s.live}>
          <div class="sug-l">
            <div class="sug-t">{s.title}</div>
            <div class="sug-i">{s.impact}</div>
          </div>
          <div class="sug-w" class:on={s.live}>{s.live ? "● 진행 중" : s.when}</div>
        </div>
      {/each}
      <div class="sug-hint">→ 아래에서 해당 방송 URL 을 넣고 송출하세요</div>
    {/if}

    <div class="src-row">
      {#each SAFE_SOURCES as s}
        <a class="btn src" href={s.url} target="_blank" rel="noreferrer">{s.label} 열기 ↗</a>
      {/each}
    </div>

    <input class="vurl" bind:value={videoUrl} placeholder="유튜브 URL 붙여넣기 (youtu.be/… 또는 /watch?v=…)" />
    <div class="row">
      <button class="btn send vsend" on:click={() => sendVideo(videoUrl, "")}>영상 송출</button>
      <button class="btn clear" on:click={() => { videoUrl = ""; }}>지우기</button>
    </div>
    <div class="warn">
      ⚠️ 연준·백악관 등 <b>미국 정부 영상은 재송출 가능</b>(퍼블릭 도메인).
      CNBC·Bloomberg 등 <b>상업 방송 재송출은 저작권 위반</b>이라 채널 스트라이크 위험이 큽니다.
    </div>
  </section>

  <section>
    <h2>🚨 수동 속보</h2>
    <textarea bind:value={headline} placeholder="속보 문구 입력…" rows="2"
      on:keydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendBreaking(); }}></textarea>
    <div class="lv">
      <span>강도</span>
      {#each [3,4,5] as l}
        <button class="btn lv-b" class:on={l === level} on:click={() => level = l}>{l}</button>
      {/each}
    </div>
    <div class="row">
      <button class="btn send" on:click={sendBreaking}>속보 송출</button>
      <button class="btn clear" on:click={clearBreaking}>내리기</button>
    </div>
    {#if lastBreaking}<div class="last">최근: {lastBreaking}</div>{/if}
  </section>

  <footer>오버레이 화면은 1.5초 내 자동 반영됩니다</footer>
</div>

<style>
  :global(body){margin:0;background:#0a0b0e;font-family:'Inter',system-ui,-apple-system,sans-serif;}
  .ctl{max-width:640px;margin:0 auto;padding:16px;color:#f2f3f5;min-height:100vh;}
  header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:18px;position:sticky;top:0;background:#0a0b0e;padding:8px 0;z-index:5;}
  .ttl{font-size:18px;font-weight:800;letter-spacing:-.5px}
  .ttl span{color:#6b7280;font-weight:500}
  .flash{font-size:13px;font-weight:700;color:#39d98a;background:#0d1712;border:1px solid #16281d;padding:6px 10px;border-radius:999px}
  section{margin-bottom:22px}
  h2{font-size:14px;font-weight:800;color:#8a919b;letter-spacing:.04em;margin:0 0 10px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .grid.iv{grid-template-columns:repeat(5,1fr)}
  .btn{border:1px solid #23272f;background:#12151b;color:#e5e7eb;font-size:15px;font-weight:700;
    padding:16px 8px;border-radius:12px;cursor:pointer;transition:.12s;-webkit-tap-highlight-color:transparent;}
  .btn:active{transform:scale(.96)}
  .btn.on{background:#1d2b22;border-color:#2f6b48;color:#4ade80}
  .iv-b{padding:12px 4px;font-size:14px}
  textarea{width:100%;box-sizing:border-box;background:#12151b;border:1px solid #23272f;border-radius:12px;
    color:#fff;font-size:17px;padding:14px;resize:none;font-family:inherit;}
  .lv{display:flex;align-items:center;gap:8px;margin:10px 0}
  .lv span{font-size:13px;color:#8a919b;font-weight:700}
  .lv-b{padding:10px 18px;font-size:15px}
  .lv-b.on{background:#351515;border-color:#7a2b2b;color:#ff8a8a}
  .row{display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-top:4px}
  .send{background:#7f1d1d;border-color:#a83232;color:#fff;font-size:16px;font-weight:800;padding:18px}
  .send:active{background:#991b1b}
  .clear{background:#12151b;color:#9ca3af}
  .last{margin-top:10px;font-size:13px;color:#6b7280}

  /* 라이브 영상 */
  .vid-on{display:flex;align-items:center;gap:10px;background:#1a0d0d;border:1px solid #3a1616;
    border-radius:12px;padding:12px 14px;margin-bottom:12px}
  .vid-dot{width:9px;height:9px;border-radius:50%;background:#ff3b30;box-shadow:0 0 8px #ff3b30;
    animation:vpulse 1.4s infinite;flex-shrink:0}
  @keyframes vpulse{50%{opacity:.35}}
  .vid-lbl{flex:1;min-width:0;font-size:14px;font-weight:700;color:#ff8a8a;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vstop{flex:0 0 auto;padding:10px 16px;font-size:14px;background:#12151b;color:#e5e7eb}
  .sug-lbl{font-size:12px;font-weight:800;color:#6b7280;letter-spacing:.06em;margin:4px 0 8px}
  .sug{display:flex;align-items:center;gap:10px;background:#12151b;border:1px solid #23272f;
    border-radius:10px;padding:11px 13px;margin-bottom:7px}
  .sug.live{border-color:#3a1616;background:#160f10}
  .sug-l{flex:1;min-width:0}
  .sug-t{font-size:15px;font-weight:700;color:#e5e7eb}
  .sug-i{font-size:12px;color:#8a919b;margin-top:2px}
  .sug-w{flex:0 0 auto;font-size:12px;font-weight:800;color:#8a919b;white-space:nowrap}
  .sug-w.on{color:#ff6b6b}
  .sug-hint{font-size:12px;color:#6b7280;margin:6px 0 12px}
  .src-row{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
  .src{flex:1;min-width:140px;text-align:center;text-decoration:none;font-size:13px;padding:12px 8px;
    display:flex;align-items:center;justify-content:center}
  .vurl{width:100%;box-sizing:border-box;background:#12151b;border:1px solid #23272f;border-radius:12px;
    color:#fff;font-size:15px;padding:14px;font-family:inherit}
  .vsend{background:#12303a;border-color:#1d5570;color:#7dd3fc}
  .vsend:active{background:#164152}
  .warn{margin-top:10px;font-size:12px;color:#8a919b;line-height:1.5;
    background:#1a140a;border:1px solid #2e2410;border-radius:10px;padding:10px 12px}
  .warn b{color:#d8a860}
  footer{text-align:center;font-size:12px;color:#4b5563;margin-top:30px;padding-bottom:20px}
</style>
