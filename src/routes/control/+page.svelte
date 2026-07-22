<script lang="ts">
  import { onMount } from "svelte";

  let presets: { key: string; label: string }[] = [];
  let activeKey = "";
  let interval = "1";
  let headline = "";
  let level = 5;
  let status = "";
  let lastBreaking = "";

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
      }
    } catch {}
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

  onMount(loadState);
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
  footer{text-align:center;font-size:12px;color:#4b5563;margin-top:30px;padding-bottom:20px}
</style>
