<script lang="ts">
  import "$lib/css/global.css";
  import MinimalChart from "$lib/components/chart.svelte";
  import ImpactBar from "$lib/components/ImpactBar.svelte";
  import BreakingToast from "$lib/components/BreakingToast.svelte";
  import MiniViz from "$lib/components/MiniViz.svelte";
  import { onMount } from "svelte";

  // audio sources from $lib/audio
  const audioMods = import.meta.glob("$lib/audio/*.{mp3,wav,ogg}", {
    eager: true,
    query: "?url",
    import: "default"
  }) as Record<string, string>;
  const audioSources = Object.values(audioMods);

  // ET clock
  let etNow = "";
  const etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });

  // CHARTS (iframe-safe)
  const charts = [
    { label: "SPY", symbol: "AMEX:SPY" },
    { label: "QQQ (NQ proxy)", symbol: "NASDAQ:QQQ" },
    { label: "BTCUSD", symbol: "BITSTAMP:BTCUSD" }
  ];

  // boards
  type TopItem = { k: string; v: string; pct: number };
  type TapeItem = { k: string; v: string; pct?: number | null };
  type Row = { ticker: string; price: number; changePct: number };

  let top: TopItem[] = [];
  let tape1: TapeItem[] = [];
  let tape2: TapeItem[] = [];
  let gainers: Row[] = [];
  let losers: Row[] = [];

  let boardsAsOf = "";
  let boardsNext = 20;
  let digestNext = 600;

  async function refreshBoards() {
    const r = await fetch("/api/boards", { cache: "no-store" });
    const j = await r.json();
    top = j.top ?? [];
    tape1 = j.tape1 ?? [];
    tape2 = j.tape2 ?? [];
    gainers = j.gainers ?? [];
    losers = j.losers ?? [];
    boardsAsOf = j.meta?.asOf ?? "";
  }

  // digest
  type Digest = {
    now: string;
    breaking: null | { timeET: string; headline: string; level: number };
    news: { timeET: string; title: string; impact: string; level: number; link: string | null }[];
  };

  let pack: Digest | null = null;

  let toast: { headline: string; level: number; key: number } | null = null;
  let toastKey = 0;
  function showBreaking(headline: string, level: number) {
    toastKey += 1;
    toast = { headline, level, key: toastKey };
  }

  async function refreshDigest() {
    const r = await fetch("/api/digest", { cache: "no-store" });
    const d = (await r.json()) as Digest;
    pack = d;
    if (d.breaking?.headline) showBreaking(d.breaking.headline, d.breaking.level);
  }

  // movers toggle
  let mode: "gainers" | "losers" = "gainers";

  onMount(() => {
    const tClock = setInterval(() => (etNow = etFmt.format(new Date())), 1000);

    // countdown ticker
    const tCount = setInterval(() => {
      boardsNext = Math.max(0, boardsNext - 1);
      digestNext = Math.max(0, digestNext - 1);
    }, 1000);

    refreshBoards();
    boardsNext = 20;
    const tBoards = setInterval(async () => {
      boardsNext = 20;
      await refreshBoards();
    }, 20_000);

    refreshDigest();
    digestNext = 600;
    const tDigest = setInterval(async () => {
      digestNext = 600;
      await refreshDigest();
    }, 10 * 60_000);

    const tToggle = setInterval(() => {
      mode = mode === "gainers" ? "losers" : "gainers";
    }, 20_000);

    return () => {
      clearInterval(tClock);
      clearInterval(tCount);
      clearInterval(tBoards);
      clearInterval(tDigest);
      clearInterval(tToggle);
    };
  });
</script>

<div id="frame">
  {#if toast}
    <BreakingToast
      key={toast.key}
      headline={toast.headline}
      level={toast.level}
      durationMs={22000}
      soundSrc="/sfx/breaking.mp3"
      soundVolume={0.14}
    />
  {/if}

  <!-- compact header -->
  <header class="top">
    <div class="left">
      <span class="dot"></span>
      <span class="name">Firmnote</span>
      <span class="time">{etNow} ET</span>
    </div>

    <div class="right">
      <MiniViz sources={audioSources} volume={0.40}/>
    </div>
  </header>

  <!-- top strip (big) -->
  <section class="strip">
    {#each top as it (it.k)}
      <div class="sItem">
        <div class="sK">{it.k}</div>
        <div class="sV">{it.v}</div>
        <div class:pos={it.pct >= 0} class:neg={it.pct < 0} class="sP">
          {it.pct >= 0 ? "▲" : "▼"} {it.pct >= 0 ? "+" : ""}{it.pct.toFixed(2)}%
        </div>
      </div>
    {/each}
  </section>

  <main class="main">
    <!-- charts -->
    <section class="charts">
      {#each charts as c (c.symbol)}
        <div class="card chart">
          <div class="cHead">
            <div class="cName">{c.label}</div>
            <div class="cHint">1m</div>
          </div>
          <div class="cBody">
            <MinimalChart symbol={c.symbol} interval="1" height={260} theme="dark" />
          </div>
        </div>
      {/each}
    </section>

    <!-- right panel -->
    <aside class="side">
      <div class="card panel">
        <div class="pHead">
          <div class="pTitle">{mode === "gainers" ? "Top Gainers" : "Top Losers"}</div>
          <div class="pHint">next {boardsNext}s</div>
        </div>

        <div class="pSub">
          <div class="meta">Market data • {boardsAsOf ? boardsAsOf.slice(11,19) + "Z" : "—"}</div>
          <div class="tag">{mode.toUpperCase()}</div>
        </div>

        <div class="pList">
          {#each (mode === "gainers" ? gainers : losers).slice(0,6) as r (r.ticker)}
            <div class="mRow">
              <div class="mT">{r.ticker}</div>
              <div class="mP">{r.price.toFixed(2)}</div>
              <div class:pos={r.changePct >= 0} class:neg={r.changePct < 0} class="mC">
                {r.changePct >= 0 ? "+" : ""}{r.changePct.toFixed(2)}%
              </div>
            </div>
          {/each}

          {#if (mode === "gainers" ? gainers : losers).length === 0}
            <div class="empty">Loading movers… ({boardsNext}s)</div>
          {/if}
        </div>
      </div>

      <div class="card panel">
        <div class="pHead">
          <div class="pTitle">Now</div>
          <div class="pHint">next {digestNext}s</div>
        </div>

        <div class="nowBox">
          <div class="nowLine">{pack?.now ?? "…"}</div>
        </div>

        <div class="pHead2">
          <div class="pTitle2">News</div>
        </div>

        <div class="nList">
          {#each (pack?.news ?? []).slice(0,5) as n (n.title)}
            <a class="nRow" href={n.link ?? "#"} target="_blank" rel="noreferrer">
              <div class="nTop">
                <div class="nTime">{n.timeET || "—"}</div>
                <ImpactBar level={n.level}/>
              </div>
              <div class="nTitle">{n.title}</div>
              <div class="nImpact">{n.impact}</div>
            </a>
          {/each}
        </div>
      </div>
    </aside>
  </main>

  <!-- TWO-LINE TAPES -->
  <footer class="tapes">
    <div class="tape">
      <div class="track">
        {#each tape1 as it (it.k)}
          <div class="ti">
            <span class="k">{it.k}</span>
            <span class="v">{it.v}</span>
            {#if typeof it.pct === "number"}
              <span class:pos={it.pct >= 0} class:neg={it.pct < 0} class="p">
                {it.pct >= 0 ? "▲" : "▼"} {it.pct >= 0 ? "+" : ""}{it.pct.toFixed(2)}%
              </span>
            {/if}
          </div>
          <span class="sep">•</span>
        {/each}
        {#each tape1 as it (it.k + "_2")}
          <div class="ti">
            <span class="k">{it.k}</span>
            <span class="v">{it.v}</span>
            {#if typeof it.pct === "number"}
              <span class:pos={it.pct >= 0} class:neg={it.pct < 0} class="p">
                {it.pct >= 0 ? "▲" : "▼"} {it.pct >= 0 ? "+" : ""}{it.pct.toFixed(2)}%
              </span>
            {/if}
          </div>
          <span class="sep">•</span>
        {/each}
      </div>
    </div>

    <div class="tape">
      <div class="track slower">
        {#each tape2 as it (it.k)}
          <div class="ti">
            <span class="k">{it.k}</span>
            <span class="v">{it.v}</span>
            {#if typeof it.pct === "number"}
              <span class:pos={it.pct >= 0} class:neg={it.pct < 0} class="p">
                {it.pct >= 0 ? "▲" : "▼"} {it.pct >= 0 ? "+" : ""}{it.pct.toFixed(2)}%
              </span>
            {/if}
          </div>
          <span class="sep">•</span>
        {/each}
        {#each tape2 as it (it.k + "_2")}
          <div class="ti">
            <span class="k">{it.k}</span>
            <span class="v">{it.v}</span>
            {#if typeof it.pct === "number"}
              <span class:pos={it.pct >= 0} class:neg={it.pct < 0} class="p">
                {it.pct >= 0 ? "▲" : "▼"} {it.pct >= 0 ? "+" : ""}{it.pct.toFixed(2)}%
              </span>
            {/if}
          </div>
          <span class="sep">•</span>
        {/each}
      </div>
    </div>
  </footer>

  <!-- CHAT: fixed bottom-right -->
  <div class="chatDock">
    <div class="chatHead">CHAT</div>
    <div class="chatBody">YouTube live chat embed slot</div>
  </div>
</div>

<style>
#frame{
  width:1920px;height:1080px;
  background:#0b0c10;color:#e5e7eb;
  overflow:hidden;position:relative;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
}

.top{
  height:44px; padding:10px 18px;
  display:flex;align-items:center;justify-content:space-between;
}
.left{display:flex;align-items:center;gap:10px}
.dot{
  width:10px;height:10px;border-radius:999px;background:#ff3b30;
  opacity:.85; animation:pulse 1.2s ease-in-out infinite;
}
@keyframes pulse{0%{transform:scale(.95);opacity:.55}50%{transform:scale(1.12);opacity:1}100%{transform:scale(.95);opacity:.55}}
.name{font-size:18px;font-weight:950;letter-spacing:-.02em}
.time{font-size:16px;font-weight:900;opacity:.75;margin-left:6px}
.right{display:flex;align-items:center;gap:10px}

.strip{
  height:86px;padding: 8px 18px 10px 18px;
  display:grid;grid-template-columns: repeat(5, 1fr);
  gap:10px;
}
.sItem{
  border-radius:18px;
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.10);
  padding:12px 14px;
  display:flex;flex-direction:column;gap:6px;
}
.sK{font-size:14px;font-weight:950;opacity:.8;letter-spacing:.08em}
.sV{font-size:24px;font-weight:950;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.sP{font-size:16px;font-weight:950;font-variant-numeric:tabular-nums}
.pos{color:#34d399}
.neg{color:#fb7185}

.main{
  height: calc(1080px - 44px - 86px - 44px - 16px);
  padding: 10px 18px;
  display:grid;
  grid-template-columns: 1fr 520px;
  gap:12px;
}

.charts{
  display:grid;
  grid-template-rows: repeat(3, 1fr);
  gap:12px;
  min-height:0;
}

.side{
  display:grid;
  grid-template-rows: 1fr 1.2fr;
  gap:12px;
  min-height:0;
}

.card{
  border-radius:22px;
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.10);
  box-shadow:0 16px 60px rgba(0,0,0,.40);
  overflow:hidden;
  display:flex;flex-direction:column;
  min-height:0;
}

.cHead{
  padding:10px 14px;
  border-bottom:1px solid rgba(255,255,255,.08);
  display:flex;align-items:center;justify-content:space-between;
}
.cName{font-size:16px;font-weight:950;opacity:.95}
.cHint{font-size:14px;font-weight:900;opacity:.75}
.cBody{padding:10px;height:260px;flex:0 0 auto;}

.panel .pHead{
  padding:12px 14px 10px 14px;
  border-bottom:1px solid rgba(255,255,255,.08);
  display:flex;justify-content:space-between;align-items:baseline;
}
.pHead2{
  padding:10px 14px;
  border-top:1px solid rgba(255,255,255,.08);
  border-bottom:1px solid rgba(255,255,255,.08);
}
.pTitle{font-size:18px;font-weight:950}
.pTitle2{font-size:16px;font-weight:950;opacity:.9;letter-spacing:.08em}
.pHint{font-size:14px;font-weight:900;opacity:.7}

.pSub{
  padding:10px 14px;
  display:flex;justify-content:space-between;align-items:center;
}
.meta{font-size:13px;font-weight:900;opacity:.65}
.tag{
  font-size:12px;font-weight:950;letter-spacing:.12em;
  padding:8px 10px;border-radius:999px;
  border:1px solid rgba(255,255,255,.12);
  background:rgba(255,255,255,.06);
}

.pList{padding:12px;display:flex;flex-direction:column;gap:10px;min-height:0}
.mRow{
  display:grid;
  grid-template-columns: 110px 1fr 120px;
  align-items:center;
  padding:12px 12px;
  border-radius:16px;
  background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.08);
}
.mT{font-size:18px;font-weight:950}
.mP{font-size:18px;font-weight:950;text-align:right;opacity:.92;font-variant-numeric:tabular-nums}
.mC{font-size:18px;font-weight:950;text-align:right;font-variant-numeric:tabular-nums}
.empty{padding:14px;font-size:16px;font-weight:900;opacity:.7}

.nowBox{padding:12px}
.nowLine{
  font-size:20px;font-weight:950;line-height:1.25;
  padding:12px;border-radius:16px;
  background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.08);
}

.nList{padding:12px;display:flex;flex-direction:column;gap:10px;min-height:0}
.nRow{
  display:block;
  padding:12px;
  border-radius:16px;
  background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.08);
  text-decoration:none;color:#e5e7eb;
}
.nTop{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.nTime{font-size:14px;font-weight:950;opacity:.72;letter-spacing:.06em}
.nTitle{
  font-size:18px;font-weight:950;line-height:1.25;letter-spacing:-.02em;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.nImpact{
  margin-top:6px;
  font-size:16px;font-weight:900;opacity:.78;line-height:1.2;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}

.tapes{
  position:absolute;left:18px;right:18px;bottom:12px;
  display:flex;flex-direction:column;gap:8px;
}
.tape{
  height:44px;border-radius:999px;
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.10);
  overflow:hidden;display:flex;align-items:center;
}
.track{
  display:inline-flex;align-items:center;gap:18px;
  padding-left:18px;white-space:nowrap;
  animation: scroll 34s linear infinite;
}
.track.slower{animation-duration: 44s;}
.ti{
  display:inline-flex;align-items:baseline;gap:10px;
  min-width: 240px; justify-content:space-between;
  font-variant-numeric: tabular-nums;
}
.k{font-size:16px;font-weight:950;opacity:.92;width:84px}
.v{font-size:16px;font-weight:950;width:90px;text-align:right;opacity:.95}
.p{font-size:16px;font-weight:950;width:90px;text-align:right}
.sep{font-size:18px;font-weight:950;opacity:.25}
@keyframes scroll{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}

/* chat fixed */
.chatDock{
  position:absolute;
  right:18px;
  bottom: 110px; /* tapes 위 */
  width: 520px;
  height: 260px;
  border-radius:22px;
  background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.10);
  box-shadow:0 16px 60px rgba(0,0,0,.40);
  overflow:hidden;
}
.chatHead{
  padding:10px 14px;
  border-bottom:1px solid rgba(255,255,255,.08);
  font-size:16px;font-weight:950;
}
.chatBody{
  height: calc(260px - 44px);
  display:flex;align-items:center;justify-content:center;
  font-size:16px;font-weight:900;opacity:.7;
}
</style>
