<script lang="ts">
  import { onMount } from "svelte";

  type Preset = { key: string; label: string; fut?: string; tv?: string; note?: string };
  let presets: Preset[] = [];
  // 화면에 띄울 차트들 (최대 4). 순서가 곧 배치 순서다.
  let activeKeys: string[] = [];
  let chartAuto = true;   // 정규장이면 TradingView 로 자동 전환
  let chartSniper = false;                        // 급등락 자동 포커스
  let chartStyle: "line" | "candle" = "line";
  // "지금 시장이 보고 있는 것" — 평소 변동성 대비 이례성 순
  let movers: { key: string; label: string; price: number; changePct: number;
    recentPct: number; z: number; dir: number }[] = [];
  const MAX_SLOTS = 4;
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
  // 검증된 라이브 영상 후보 — Claude 가 찾고 서버가 oEmbed 로 실존 확인한 것만 온다
  let videos: { title: string; url: string; source: string; note: string | null; live: boolean; startET: string | null; author: string | null }[] = [];
  let videoAuto = false;       // 자동 송출 on/off
  let videoAutoActive = false; // 지금 자동으로 올라가 있는가

  // ── 배경음악 ────────────────────────────────
  // 소리는 방송 화면(오버레이)에서 난다. 여기선 조작만 한다.
  let music = { playing: false, volume: 30 };

  // ── 브리핑 갱신 주기 ────────────────────────────
  // auto = 세션 기반(정규장 10분 / 프리·애프터 30분 / 밤·주말 2시간).
  // 지정학 이슈처럼 주말도 중요한 국면에선 사람이 강제로 올릴 수 있다.
  let cadence = "auto";
  const CADENCES = [
    { v: "auto", t: "Auto", d: "session-based" },
    { v: "10m",  t: "10 min", d: "even weekends" },
    { v: "30m",  t: "30 min", d: "" },
    { v: "2h",   t: "2 hours", d: "" },
    { v: "off",  t: "Off", d: "pause" }
  ];
  async function loadCadence() {
    try {
      const r = await fetch("/api/settings");
      if (r.ok) cadence = (await r.json()).briefCadence ?? "auto";
    } catch {}
  }
  async function setCadence(v: string) {
    cadence = v;
    try {
      const r = await fetch("/api/settings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ briefCadence: v })
      });
      if (r.ok) {
        flash(`Brief updates → ${CADENCES.find(c => c.v === v)?.t}`);
      } else {
        // 서버가 아직 구버전이면 이 엔드포인트가 없다 → 원인을 정확히 알려 준다
        flash(r.status === 502 || r.status === 404
          ? "Feed server needs update (deploy /api/settings)"
          : "Failed to set cadence");
      }
    } catch { flash("Feed server unreachable"); }
  }

  // 공개 소스 바로가기 — 미국 정부 저작물은 퍼블릭 도메인이라 재송출이 안전하다.
  // (반면 CNBC·Bloomberg 등 상업 방송 재송출은 저작권 침해 → 채널 스트라이크 위험)
  const SAFE_SOURCES = [
    { label: "Federal Reserve", url: "https://www.youtube.com/@federalreserve/live" },
    { label: "White House", url: "https://www.youtube.com/@WhiteHouse/live" }
  ];

  type Range = { v: string; t: string; d?: string };
  // TradingView 위젯용 봉 간격
  const INTERVALS: Range[] = [
    { v: "1", t: "1m" }, { v: "5", t: "5m" }, { v: "15", t: "15m" }, { v: "60", t: "1H" }, { v: "D", t: "1D" }
  ];
  // 자체 선물 차트는 Finviz 가 주는 3가지 시계열만 존재한다.
  // 여기에 1m/5m/15m 을 그대로 노출하면 눌러도 화면이 안 바뀌어(전부 5분봉으로 매핑)
  // 컨트롤이 고장난 것처럼 보인다 → 실제 있는 것만 보여준다.
  const FUT_RANGES: Range[] = [
    { v: "1",  t: "24H", d: "5m bars" },
    { v: "60", t: "12D", d: "1h bars" },
    { v: "D",  t: "14M", d: "1d bars" }
  ];
  // 선택된 차트 중 하나라도 자체 렌더(선물)면 범위 버튼을 그 기준으로 보여준다.
  // 자동 전환이 켜져 있고 지금이 정규장이면 TradingView 라 봉 간격이 맞다.
  $: activePresets = activeKeys
    .map((k) => presets.find((p) => p.key === k))
    .filter((p): p is Preset => !!p);
  $: isFutPreset = activePresets.some((p) => !!p.fut);
  $: ranges = isFutPreset ? FUT_RANGES : INTERVALS;
  $: full = activeKeys.length >= MAX_SLOTS;

  async function loadState() {
    try {
      const r = await fetch("/api/control");
      if (r.ok) {
        const j = await r.json();
        presets = j.presets ?? [];
        activeKeys = Array.isArray(j.chartKeys) && j.chartKeys.length ? j.chartKeys : [];
        chartAuto = j.chartAuto !== false;
        chartSniper = !!j.chartSniper;
        chartStyle = j.chartStyle === "candle" ? "candle" : "line";
        interval = j.chartInterval;
        liveVideo = j.video && j.video.id ? { id: j.video.id, label: j.video.label ?? "" } : null;
        if (j.music) music = { playing: j.music.playing, volume: j.music.volume };
        videoAuto = !!j.videoAuto;
        videoAutoActive = !!j.videoAutoActive;
      }
    } catch {}
  }

  /** 검증된 영상 후보 목록 (버튼 한 번으로 송출) */
  async function loadVideos() {
    try {
      const r = await fetch("/api/videos");
      if (r.ok) videos = (await r.json()).videos ?? [];
    } catch {}
  }

  /** 오늘의 이슈에서 "지금 LIVE이거나 곧 시작하는" 이벤트를 추천으로 뽑는다 */
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
            when: live ? "LIVE" : mins > 0 ? `${mins}m` : "ended"
          };
        })
        .filter((s: any) => s.live || s.when.endsWith("m"));
    } catch {}
  }

  async function sendVideo(url: string, label: string) {
    if (!url.trim()) return;
    await post({ action: "video", url, label });
    await loadState();
    flash(liveVideo ? "Video on air ✓" : "Check the URL format");
  }
  async function musicToggle() {
    music.playing = !music.playing;
    await post({ action: "music", playing: music.playing });
    flash(music.playing ? "Music playing" : "Music paused");
  }
  async function musicSkip(cmd: "next" | "prev") {
    music.playing = true;
    await post({ action: "music", cmd });
    flash(cmd === "next" ? "Next track" : "Previous track");
  }
  async function musicVolume(e: Event) {
    music.volume = Number((e.target as HTMLInputElement).value);
    await post({ action: "music", volume: music.volume });
  }

  async function toggleAuto() {
    videoAuto = !videoAuto;
    await post({ action: "videoAuto", on: videoAuto });
    await loadState();
    flash(videoAuto ? "Auto-air ON — Fed/gov live only" : "Auto-air OFF");
  }

  async function stopVideo() {
    await post({ action: "clearVideo" });
    await loadState();
    flash("Video stopped");
  }

  /** 프리셋 토글 — 이미 있으면 빼고, 없으면 추가(최대 4개). 마지막 하나는 못 뺀다. */
  async function toggleChart(key: string) {
    const i = activeKeys.indexOf(key);
    if (i >= 0) {
      if (activeKeys.length === 1) { flash("Need at least one chart"); return; }
      activeKeys = activeKeys.filter((k) => k !== key);
    } else {
      if (activeKeys.length >= MAX_SLOTS) { flash(`Max ${MAX_SLOTS} charts — remove one first`); return; }
      activeKeys = [...activeKeys, key];
    }
    flash(`${activeKeys.length} chart${activeKeys.length > 1 ? "s" : ""} on air`);
    await post({ action: "chart", keys: activeKeys, interval });
  }
  /** 한 개만 남기고 나머지를 치운다 (제일 자주 쓰는 동작이라 따로 둔다) */
  async function soloChart(key: string) {
    activeKeys = [key];
    flash(`Solo → ${presets.find(p=>p.key===key)?.label ?? key}`);
    await post({ action: "chart", keys: activeKeys, interval });
  }
  async function setInterval(v: string) {
    interval = v;
    flash(`${isFutPreset ? "Range" : "Interval"} → ${ranges.find(i=>i.v===v)?.t}`);
    await post({ action: "chart", keys: activeKeys, interval: v });
  }
  async function loadMovers() {
    try {
      const r = await fetch("/api/movers?n=8");
      if (r.ok) movers = (await r.json()).movers ?? [];
    } catch {}
  }
  /** 추천 목록에서 바로 차트에 올린다 (프리셋에 없는 종목은 fv: 키로) */
  async function airMover(key: string) {
    const preset = presets.find((p) => p.fut === key);
    const k = preset ? preset.key : `fv:${key}`;
    if (activeKeys.includes(k)) { flash("Already on air"); return; }
    activeKeys = activeKeys.length >= MAX_SLOTS
      ? [...activeKeys.slice(0, -1), k]   // 꽉 찼으면 마지막 슬롯 교체
      : [...activeKeys, k];
    flash(`Added ${movers.find(m => m.key === key)?.label ?? key}`);
    await post({ action: "chart", keys: activeKeys, interval });
  }
  async function toggleSniper() {
    chartSniper = !chartSniper;
    flash(chartSniper ? "Auto-Sniper ON" : "Auto-Sniper OFF");
    await post({ action: "chart", keys: activeKeys, interval, sniper: chartSniper });
  }
  async function setStyle(v: "line" | "candle") {
    chartStyle = v;
    flash(`Chart style → ${v}`);
    await post({ action: "chart", keys: activeKeys, interval, style: v });
  }
  async function toggleChartAuto() {
    chartAuto = !chartAuto;
    flash(chartAuto ? "Regular hours → TradingView" : "Always self-rendered futures");
    await post({ action: "chart", keys: activeKeys, interval, auto: chartAuto });
  }
  async function sendBreaking() {
    const h = headline.trim();
    if (!h) return;
    await post({ action: "breaking", headline: h, level });
    lastBreaking = h;
    headline = "";
    flash("Alert sent ✓");
  }
  async function clearBreaking() {
    await post({ action: "clearBreaking" });
    flash("Alert cleared");
  }

  async function post(body: any) {
    try {
      await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch { flash("Send failed — check server"); }
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
    loadVideos();
    loadCadence();
    loadMovers();
    // 추천은 1분마다 갱신 (이벤트가 시작/종료되면 자동 반영)
    // ※ 이 페이지엔 봉 간격 설정용 로컬 setInterval() 이 있어 전역이 가려진다 → window 로 명시.
    const t = window.setInterval(() => { loadSuggestions(); loadVideos(); }, 60000);
    // 시세 추천은 더 자주 — 급등락은 1분이면 이미 늦다
    const tm = window.setInterval(loadMovers, 20000);
    return () => { window.clearInterval(t); window.clearInterval(tm); };
  });
</script>

<svelte:head><title>MARKETWATCH · CONTROL</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" /></svelte:head>

<div class="ctl">
  <header>
    <div class="ttl">MARKET<span>WATCH</span> · CONTROL</div>
    {#if status}<div class="flash">{status}</div>{/if}
  </header>

  <section>
    <h2>📊 Charts <span class="h2sub">— {activeKeys.length}/{MAX_SLOTS} on air · tap to add or remove · “only” to show just that one</span></h2>

    <!-- 지금 배치 미리보기 — 몇 분할인지 한눈에 -->
    <div class="slots">
      {#each activeKeys as k, i}
        <span class="slot">{i + 1}. {presets.find(p => p.key === k)?.label ?? k}</span>
      {/each}
    </div>

    <div class="grid">
      {#each presets as p}
        {@const on = activeKeys.includes(p.key)}
        <div class="symwrap">
          <button class="btn sym" class:on class:dim={!on && full}
                  on:click={() => toggleChart(p.key)}>
            {p.label}
            {#if on}<span class="pos">{activeKeys.indexOf(p.key) + 1}</span>{/if}
            <!-- 지수 원본이 아니라 대체물이면 컨트롤에서도 밝힌다 -->
            {#if p.note}<small>{p.note}</small>
            {:else if !p.fut}<small>TradingView only</small>
            {:else if !p.tv}<small>24/7 self-rendered</small>{/if}
          </button>
          {#if !on}
            <button class="only" title="Show only this" on:click={() => soloChart(p.key)}>only</button>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <section>
    <h2>🎯 Auto-Sniper <span class="h2sub">— auto-focus whatever is spiking</span></h2>
    <button class="btn wide" class:on={chartSniper} on:click={toggleSniper}>
      {chartSniper ? "AUTO-SNIPER ON" : "AUTO-SNIPER OFF"}
      <small>{chartSniper
        ? "takes the LAST slot · holds 90s · only moves ≥2.5x normal volatility"
        : "your chart picks stay exactly as you set them"}</small>
    </button>
    <div class="mhint">Your first chart is never replaced. Idle while futures are closed —
      a “30-minute move” from last Friday isn’t news.</div>
  </section>

  <section>
    <h2>🔥 Market focus <span class="h2sub">— unusual vs its own normal volatility</span></h2>
    {#if movers.length}
      <div class="movers">
        {#each movers as m}
          <button class="mv" class:up={m.dir > 0} class:dn={m.dir < 0}
                  on:click={() => airMover(m.key)}>
            <span class="mv-l">{m.label}</span>
            <span class="mv-z">{m.z}x</span>
            <span class="mv-p">{m.recentPct > 0 ? "+" : ""}{m.recentPct}%<small>30m</small></span>
          </button>
        {/each}
      </div>
      <div class="mhint">Tap to put it on air. “2.4x” = the last 30 minutes moved 2.4&times; this
        symbol’s own typical range — so a quiet bond spiking outranks oil’s everyday swing.</div>
    {:else}
      <div class="mhint">Nothing unusual right now.</div>
    {/if}
  </section>

  <section>
    <h2>🕯 Style</h2>
    <div class="grid iv">
      <button class="btn iv-b" class:on={chartStyle === "line"} on:click={() => setStyle("line")}>
        Line<small>exact closes</small></button>
      <button class="btn iv-b" class:on={chartStyle === "candle"} on:click={() => setStyle("candle")}>
        Candles<small>from 5m closes</small></button>
    </div>
    <div class="mhint">The free feed gives closes only, not per-bar OHLC — so candle wicks are
      built from 5-minute closes and can be slightly short. Open/close are exact. True tick
      candles come from the TradingView mode during regular hours.</div>
  </section>

  <section>
    <h2>🔀 Regular hours</h2>
    <button class="btn wide" class:on={chartAuto} on:click={toggleChartAuto}>
      {chartAuto ? "AUTO — TradingView during regular hours" : "ALWAYS self-rendered futures"}
      <small>{chartAuto
        ? "candles & indicators 9:30–16:00 ET, futures the rest of the day"
        : "never blank, no iframes — use this if TradingView fails to load"}</small>
    </button>
  </section>

  <section>
    <h2>🕯 {isFutPreset ? "Chart range" : "Candle size"}
      <span class="h2sub">— {isFutPreset ? "how far back the futures chart goes" : "chart timeframe"}</span></h2>
    <div class="grid iv">
      {#each ranges as i}
        <button class="btn iv-b" class:on={i.v === interval} on:click={() => setInterval(i.v)}>
          {i.t}{#if i.d}<small>{i.d}</small>{/if}
        </button>
      {/each}
    </div>
  </section>

  <section>
    <h2>🔄 Brief updates <span class="h2sub">— how often Claude refreshes TODAY</span></h2>
    <div class="grid cad">
      {#each CADENCES as c}
        <button class="btn cad-b" class:on={c.v === cadence} on:click={() => setCadence(c.v)}>
          {c.t}{#if c.d}<small>{c.d}</small>{/if}
        </button>
      {/each}
    </div>
    <div class="mhint">Auto = 10 min during the session, 30 min pre/after, 2 h overnight &amp; weekends.
      Force a faster cadence when weekends matter (e.g. geopolitical risk).</div>
  </section>

  <section>
    <h2>🎥 Live Video</h2>
    {#if liveVideo}
      <div class="vid-on">
        <span class="vid-dot"></span>
        <span class="vid-lbl">ON AIR{videoAutoActive ? " (auto)" : ""} — {liveVideo.label || liveVideo.id}</span>
        <button class="btn vstop" on:click={stopVideo}>Stop</button>
      </div>
    {/if}

    <!-- 자동 송출: 연준·정부 라이브만 스스로 올린다. 수동이 항상 우선하고, 내리면 30분 억제. -->
    <button class="btn autotog" class:on={videoAuto} on:click={toggleAuto}>
      {videoAuto ? "✓ AUTO-AIR ON" : "AUTO-AIR OFF"}
      <small>{videoAuto ? "Fed / gov live streams air automatically" : "tap to auto-air Fed & gov live streams"}</small>
    </button>

    <!-- 시스템 추천: '오늘의 이슈' 중 LIVE이거나 곧 시작하는 이벤트. 판단은 사람이 한다. -->
    {#if suggestions.length}
      <div class="sug-lbl">SUGGESTED — worth showing now</div>
      {#each suggestions as s}
        <div class="sug" class:live={s.live}>
          <div class="sug-l">
            <div class="sug-t">{s.title}</div>
            <div class="sug-i">{s.impact}</div>
          </div>
          <div class="sug-w" class:on={s.live}>{s.live ? "● LIVE" : s.when}</div>
        </div>
      {/each}
      <div class="sug-hint">→ paste the stream URL below to air it</div>
    {/if}

    {#if videos.length}
      <div class="sug-lbl">VERIFIED STREAMS — one tap to air</div>
      {#each videos as v}
        <div class="vrow" class:live={v.live}>
          <div class="vrow-l">
            <div class="vrow-t">{v.title}</div>
            <div class="vrow-s">
              {#if v.live}<span class="vlive">● LIVE</span>{/if}
              <span class="vsrc">{v.source.toUpperCase()}</span>
              {#if v.author}<span>{v.author}</span>{/if}
              {#if v.note}<span>· {v.note}</span>{/if}
            </div>
          </div>
          <button class="btn vair" on:click={() => sendVideo(v.url, v.title)}>Air</button>
        </div>
      {/each}
    {/if}

    <div class="src-row">
      {#each SAFE_SOURCES as s}
        <a class="btn src" href={s.url} target="_blank" rel="noreferrer">{s.label} ↗</a>
      {/each}
    </div>

    <input class="vurl" bind:value={videoUrl} placeholder="Paste YouTube URL (youtu.be/… or /watch?v=…)" />
    <div class="row">
      <button class="btn send vsend" on:click={() => sendVideo(videoUrl, "")}>Air Video</button>
      <button class="btn clear" on:click={() => { videoUrl = ""; }}>Clear</button>
    </div>
    <div class="warn">
      ⚠️ US government streams (Fed, White House) are <b>public domain — safe to rebroadcast</b>.
      Commercial networks (CNBC, Bloomberg) are <b>not</b> — rebroadcasting them risks a channel strike.
    </div>
  </section>

  <section>
    <h2>🎵 Music</h2>
    <div class="mrow">
      <button class="btn mbtn play" class:on={music.playing} on:click={musicToggle}>
        {music.playing ? "❚❚ Pause" : "► Play"}
      </button>
      <button class="btn mbtn" on:click={() => musicSkip("prev")}>⏮</button>
      <button class="btn mbtn" on:click={() => musicSkip("next")}>⏭</button>
    </div>
    <div class="vol">
      <span>Volume</span>
      <input type="range" min="0" max="100" value={music.volume} on:change={musicVolume} />
      <b>{music.volume}</b>
    </div>
    <div class="mhint">Audio plays on the broadcast screen (captured by OBS), not here.</div>
  </section>

  <section>
    <h2>🚨 Manual Alert</h2>
    <textarea bind:value={headline} placeholder="Alert headline…" rows="2"
      on:keydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendBreaking(); }}></textarea>
    <div class="lv">
      <span>Level</span>
      {#each [3,4,5] as l}
        <button class="btn lv-b" class:on={l === level} on:click={() => level = l}>{l}</button>
      {/each}
    </div>
    <div class="row">
      <button class="btn send" on:click={sendBreaking}>Send Alert</button>
      <button class="btn clear" on:click={clearBreaking}>Clear</button>
    </div>
    {#if lastBreaking}<div class="last">Last: {lastBreaking}</div>{/if}
  </section>

  <footer>Overlay updates within 1.5s</footer>
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
  .h2sub{font-weight:600;color:#4b5563;letter-spacing:0}
  .grid.cad{grid-template-columns:repeat(5,1fr)}
  .cad-b{padding:12px 2px;font-size:13px;display:flex;flex-direction:column;gap:2px;align-items:center}
  .cad-b small{font-size:9px;color:#6b7280;font-weight:600}
  .cad-b.on small{color:#4ade80}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .grid.iv{grid-template-columns:repeat(5,1fr)}
  .btn{border:1px solid #23272f;background:#12151b;color:#e5e7eb;font-size:15px;font-weight:700;
    padding:16px 8px;border-radius:12px;cursor:pointer;transition:.12s;-webkit-tap-highlight-color:transparent;}
  .btn:active{transform:scale(.96)}
  .btn.on{background:#1d2b22;border-color:#2f6b48;color:#4ade80}
  .slots{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
  .slot{font-size:11px;font-weight:800;color:#4ade80;background:#0d1712;border:1px solid #16281d;
    border-radius:999px;padding:4px 10px}
  .symwrap{position:relative;display:flex}
  .symwrap .btn{flex:1}
  .sym{padding-top:16px}
  .sym small{display:block;font-size:9px;font-weight:600;color:#6b7280;margin-top:3px;
    line-height:1.2;white-space:normal}
  .sym.on small{color:#4ade80}
  .sym.dim{opacity:.4}
  .pos{position:absolute;top:5px;right:6px;font-size:10px;font-weight:800;color:#0b0e13;
    background:#4ade80;border-radius:999px;min-width:15px;height:15px;line-height:15px;text-align:center}
  .only{position:absolute;top:4px;right:5px;font-size:9px;font-weight:800;color:#6b7280;
    background:#12151b;border:1px solid #23272f;border-radius:4px;padding:2px 5px;cursor:pointer}
  .only:hover{color:#c7cdd6;border-color:#3a4150}
  .movers{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
  .mv{display:flex;align-items:baseline;gap:8px;background:#12151b;border:1px solid #23272f;
    border-radius:8px;padding:10px 12px;cursor:pointer;text-align:left;color:#c7cdd6}
  .mv:hover{border-color:#3a4150}
  .mv-l{font-size:13px;font-weight:800;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mv-z{font-size:11px;font-weight:800;color:#f0b429}
  .mv-p{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums}
  .mv-p small{font-size:8px;color:#6b7280;margin-left:3px;font-weight:700}
  .mv.up .mv-p{color:#39d98a}
  .mv.dn .mv-p{color:#ff5c5c}
  .wide{width:100%;display:flex;flex-direction:column;gap:3px;align-items:center;padding:14px}
  .wide small{font-size:10px;font-weight:600;color:#6b7280}
  .wide.on small{color:#4ade80}
  .iv-b{padding:12px 4px;font-size:14px;display:flex;flex-direction:column;gap:2px;align-items:center}
  .iv-b small{font-size:9px;color:#6b7280;font-weight:600}
  .iv-b.on small{color:#4ade80}
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

  /* 음악 조작 */
  .mrow{display:flex;gap:8px}
  .mbtn{flex:0 0 auto;padding:14px 0;width:64px;font-size:16px}
  .mbtn.play{flex:1;font-size:15px}
  .mbtn.play.on{background:#0d1712;border-color:#16281d;color:#39d98a}
  .vol{display:flex;align-items:center;gap:12px;margin-top:12px}
  .vol span{font-size:13px;color:#8a919b;font-weight:700;flex:0 0 auto}
  .vol input{flex:1;accent-color:#39d98a}
  .vol b{font-size:14px;color:#e5e7eb;width:32px;text-align:right;font-variant-numeric:tabular-nums}
  .mhint{margin-top:10px;font-size:12px;color:#6b7280;line-height:1.5}

  /* 검증된 영상 후보 — 버튼 한 번으로 송출 */
  .vrow{display:flex;align-items:center;gap:10px;background:#12151b;border:1px solid #23272f;
    border-radius:10px;padding:11px 12px;margin-bottom:7px}
  .vrow.live{border-color:#3a1616;background:#160f10}
  .vrow-l{flex:1;min-width:0}
  .vrow-t{font-size:15px;font-weight:700;color:#e5e7eb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vrow-s{display:flex;gap:7px;align-items:center;font-size:11px;color:#6b7280;margin-top:3px;flex-wrap:wrap}
  .vlive{color:#ff6b6b;font-weight:800}
  .vsrc{color:#7dd3fc;font-weight:800;letter-spacing:.04em}
  .autotog{width:100%;display:flex;flex-direction:column;gap:3px;align-items:center;
    padding:14px;margin-bottom:12px;font-size:14px;letter-spacing:.04em}
  .autotog small{font-size:11px;font-weight:600;color:#6b7280;letter-spacing:0}
  .autotog.on{background:#0d1712;border-color:#2f6b48;color:#4ade80}
  .autotog.on small{color:#39d98a}
  .vair{flex:0 0 auto;padding:10px 18px;font-size:14px;background:#12303a;border-color:#1d5570;color:#7dd3fc}
  footer{text-align:center;font-size:12px;color:#4b5563;margin-top:30px;padding-bottom:20px}
</style>
