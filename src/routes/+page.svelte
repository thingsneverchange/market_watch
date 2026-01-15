<script lang="ts">
  import "$lib/css/global.css";
  import MinimalChart from "$lib/components/chart.svelte";
  import BreakingToast from "$lib/components/BreakingToast.svelte";
  import MiniViz from "$lib/components/MiniViz.svelte";
  import ImpactBar from "$lib/components/ImpactBar.svelte";
  import { onMount } from "svelte";

  // 오디오 소스
  const audioMods = import.meta.glob("$lib/audio/*.{mp3,wav,ogg}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
  const audioSources = Object.values(audioMods);

  // --- 상태 변수 ---
  let etNow = "";
  let marketMsg = "LOADING...";
  let isMarketOpen = false;

  let boards = { top: [], tape: [], gainers: [], losers: [] };
  let digest = { driver: { text: "Connecting to market feed...", sentiment: "neutral" }, news: [] };
  // 매크로 더미 (API 연결 전까지 보여줄 예시)
  let macro = { title: "FOMC Minutes", time: new Date(Date.now() + 1000 * 60 * 15), imp: 5 }; // 15분 뒤

  let breakingData = null; // 토스트 알림용
  let moverMode: "gainers" | "losers" = "gainers"; // 핫무버 전환용

  // --- 스케일링 (1920x1080 고정) ---
  let scale = 1;
  function updateScale() {
    // 가로/세로 중 더 작은 비율에 맞춰서 꽉 채움 (Letterbox 없이)
    const sx = window.innerWidth / 1920;
    const sy = window.innerHeight / 1080;
    scale = Math.min(sx, sy);
  }

  // --- 데이터 패칭 ---
  async function refreshData() {
    // 1. 보드 데이터
    try {
      const b = await (await fetch("/api/boards")).json();
      if (b && b.top) boards = b;
    } catch {}

    // 2. 뉴스 데이터
    try {
      const d = await (await fetch("/api/digest")).json();
      if (d && d.driver) digest = d;

      // 랜덤하게 뉴스 하나를 Breaking News로 띄움 (데모용)
      if (d.news && d.news.length > 0 && Math.random() > 0.8) {
        const pick = d.news[0];
        breakingData = { headline: pick.title, level: pick.level };
      }
    } catch {}
  }

  // --- 시계 및 카운트다운 ---
  let macroText = "--:--";

  function updateTimers() {
    const now = new Date();

    // 1. ET 시계
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    etNow = new Intl.DateTimeFormat("en-US", { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:true }).format(et);

    // 2. 마켓 오픈/클로즈 계산
    const day = et.getDay();
    const min = et.getHours() * 60 + et.getMinutes();
    const OPEN = 570; // 09:30
    const CLOSE = 960; // 16:00

    if (day === 0 || day === 6) {
      isMarketOpen = false;
      marketMsg = "WEEKEND";
    } else if (min >= OPEN && min < CLOSE) {
      isMarketOpen = true;
      marketMsg = "MARKET OPEN";
    } else {
      isMarketOpen = false;
      if (min < OPEN) {
        const diff = OPEN - min;
        const h = Math.floor(diff / 60);
        const m = diff % 60;
        marketMsg = `OPENS IN ${h}h ${m}m`;
      } else {
        marketMsg = "MARKET CLOSED";
      }
    }

    // 3. 매크로 타이머 (T-03:00 -> IN 03m 12s)
    if (macro.time) {
      const diff = macro.time.getTime() - now.getTime();
      if (diff <= 0) {
        macroText = "RELEASED";
      } else {
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        macroText = `IN ${m}m ${s}s`;
      }
    }
  }

  onMount(() => {
    updateScale();
    refreshData();

    const tScale = window.addEventListener("resize", updateScale);
    const tTimer = setInterval(updateTimers, 1000);
    const tData = setInterval(refreshData, 15000); // 15초마다 갱신
    const tMove = setInterval(() => {
        moverMode = moverMode === "gainers" ? "losers" : "gainers";
    }, 5000); // 5초마다 게이너/루저 전환

    return () => {
      window.removeEventListener("resize", updateScale);
      clearInterval(tTimer);
      clearInterval(tData);
      clearInterval(tMove);
    };
  });

  // 스타일 헬퍼
  function sentColor(s: string) {
    if (s === 'bull' || s === 'pos') return 'pos'; // Green
    if (s === 'bear' || s === 'neg') return 'neg'; // Red
    return 'neu'; // Grey
  }
</script>

<div class="wrap" style="width: 1920px; height: 1080px; transform: scale({scale}); transform-origin: top left;">

  {#if breakingData}
    <BreakingToast headline={breakingData.headline} level={breakingData.level} />
  {/if}

  <header class="hd">
    <div class="hd-left">
      <div class="logo">FIRNOTE</div>
      <div class="badge" class:active={isMarketOpen}>{marketMsg}</div>
    </div>

    <div class="top-list">
      {#each boards.top as t}
        <div class="idx">
          <span class="k">{t.k}</span>
          <span class="v" class:u={t.pct>=0} class:d={t.pct<0}>
            {t.pct>0?"+":""}{Number(t.pct).toFixed(2)}%
          </span>
        </div>
      {/each}
    </div>

    <div class="hd-right">
      <div class="clock">{etNow} ET</div>
      <MiniViz sources={audioSources} volume={0.4} />
    </div>
  </header>

  <main class="grid">

    <div class="col left">
      <div class="card driver {sentColor(digest.driver.sentiment)}">
        <div class="lbl">MARKET DRIVER</div>
        <div class="driver-txt">{digest.driver.text}</div>
      </div>

      <div class="card macro">
        <div class="macro-head">
          <span class="lbl-y">UPCOMING MACRO</span>
          <span class="timer">{macroText}</span>
        </div>
        <div class="macro-body">
          <div class="m-tit">{macro.title}</div>
          <div class="m-imp">IMPACT {macro.imp}/5</div>
        </div>
      </div>

      <div class="card news">
        <div class="lbl">LATEST NEWS</div>
        <div class="news-list">
          {#each digest.news as n}
            <div class="news-item {sentColor(n.sentiment)}">
              <div class="n-top">
                <span class="n-time">{n.timeET}</span>
                <ImpactBar level={n.level} />
              </div>
              <div class="n-tit">{n.title}</div>
            </div>
          {/each}
          {#if digest.news.length === 0}
            <div class="empty">Scanning newswires...</div>
          {/if}
        </div>
      </div>
    </div>

    <div class="col center">
      <div class="chart-grid">
        <div class="c-cell big">
            <MinimalChart symbol="CME_MINI:NQ1!" interval="5" height={380} />
            <div class="c-ovl">NASDAQ 100</div>
        </div>
        <div class="c-cell big">
            <MinimalChart symbol="CME_MINI:ES1!" interval="5" height={380} />
            <div class="c-ovl">S&P 500</div>
        </div>
        <div class="c-cell big">
            <MinimalChart symbol="CBOT_MINI:YM1!" interval="5" height={380} />
            <div class="c-ovl">DOW JONES</div>
        </div>
        <div class="c-cell wide">
            <MinimalChart symbol="OANDA:XAUUSD" interval="15" height={300} />
            <div class="c-ovl">GOLD</div>
        </div>
        <div class="c-cell wide">
            <MinimalChart symbol="BITSTAMP:BTCUSD" interval="15" height={300} />
            <div class="c-ovl">BITCOIN</div>
        </div>
      </div>
    </div>

    <div class="col right">
      <div class="card movers">
        <div class="m-head">
          {#if moverMode === 'gainers'}
            <span class="u">🚀 TOP GAINERS</span>
          {:else}
            <span class="d">🩸 TOP LOSERS</span>
          {/if}
        </div>
        <div class="m-list">
          {#each (moverMode==='gainers' ? boards.gainers : boards.losers) as m}
            <div class="m-row">
              <span class="mt">{m.t}</span>
              <span class="mv">{Number(m.p).toFixed(2)}</span>
              <span class="mp" class:u={m.pct>=0} class:d={m.pct<0}>
                {m.pct>0?"+":""}{Number(m.pct).toFixed(2)}%
              </span>
            </div>
          {/each}
          {#if boards.gainers.length === 0}
            <div class="empty">Loading Data...</div>
          {/if}
        </div>
        <div class="bar-wrap"><div class="bar-fill"></div></div>
      </div>

      <div class="card chat">
        <div class="lbl">LIVE CHAT</div>
        <div class="chat-area">
          <div class="ph">Chat Embed Area</div>
        </div>
      </div>
    </div>

  </main>

  <footer class="ft">
    <div class="track">
      {#each [...boards.tape, ...boards.tape] as t}
        <div class="mq-item">
          <span class="mq-k">{t.k}</span>
          <span class="mq-v">{t.v}</span>
          <span class="mq-p" class:u={t.pct>=0} class:d={t.pct<0}>
            {Number(t.pct).toFixed(2)}%
          </span>
        </div>
        <span class="mq-sep">•</span>
      {/each}
    </div>
  </footer>
</div>

<style>
  /* RESET */
  :global(body) { margin: 0; background: #000; overflow: hidden; font-family: 'Inter', sans-serif; }

  .wrap {
    background: #0b0c10; color: #e5e5e5;
    display: flex; flex-direction: column; overflow: hidden;
  }

  /* UTILS */
  .u { color: #34d399; } .d { color: #fb7185; }
  .pos { background: #064e3b; border-left: 6px solid #34d399; }
  .neg { background: #7f1d1d; border-left: 6px solid #ef4444; }
  .neu { background: #1f2937; border-left: 6px solid #9ca3af; }

  /* HEADER (60px) */
  .hd { height: 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; background: rgba(255,255,255,0.03); border-bottom: 1px solid rgba(255,255,255,0.1); }
  .hd-left { display: flex; gap: 16px; align-items: center; }
  .logo { font-size: 26px; font-weight: 900; letter-spacing: -1px; }
  .badge { font-size: 14px; font-weight: 800; padding: 4px 10px; border-radius: 4px; background: #333; color: #999; }
  .badge.active { background: #dc2626; color: white; }

  .top-list { display: flex; gap: 24px; }
  .idx { display: flex; gap: 8px; font-size: 18px; font-weight: 700; }
  .idx .k { color: #9ca3af; }

  .hd-right { display: flex; gap: 20px; align-items: center; }
  .clock { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; }

  /* GRID */
  .grid { flex: 1; padding: 12px; display: grid; grid-template-columns: 400px 1fr 360px; gap: 12px; overflow: hidden; }
  .col { display: flex; flex-direction: column; gap: 12px; height: 100%; overflow: hidden; }

  /* CARDS */
  .card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; overflow: hidden; }
  .lbl { font-size: 13px; font-weight: 900; color: #6b7280; padding: 10px 14px; background: rgba(0,0,0,0.3); letter-spacing: 0.5px; }

  /* LEFT: Driver & News */
  .driver { flex: 0 0 auto; min-height: 140px; display: flex; flex-direction: column; }
  .driver-txt { padding: 16px; font-size: 24px; font-weight: 800; line-height: 1.3; color: #fff; }

  .macro { flex: 0 0 auto; background: #111; padding: 14px; }
  .macro-head { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .lbl-y { font-weight: 800; color: #facc15; font-size: 14px; }
  .timer { font-size: 20px; font-weight: 900; color: #fff; font-variant-numeric: tabular-nums; }
  .m-tit { font-size: 18px; font-weight: 700; }
  .m-imp { font-size: 12px; font-weight: 700; color: #9ca3af; margin-top: 2px; }

  .news { flex: 1; display: flex; flex-direction: column; }
  .news-list { flex: 1; overflow-y: hidden; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .news-item { padding: 12px; border-radius: 4px; }
  .n-top { display: flex; justify-content: space-between; margin-bottom: 4px; }
  .n-time { font-size: 13px; font-weight: 700; color: #d1d5db; opacity: 0.8; }
  .n-tit { font-size: 18px; font-weight: 700; line-height: 1.25; }
  .empty { padding: 20px; text-align: center; color: #555; font-weight: 700; }

  /* CENTER: Charts */
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr 1fr 1fr; grid-template-rows: 1.4fr 1fr; gap: 8px; height: 100%; }
  .c-cell { background: #000; border: 1px solid #333; border-radius: 6px; position: relative; overflow: hidden; }
  .c-cell.big { grid-column: span 2; } /* Top 3 */
  .c-cell.wide { grid-column: span 3; } /* Bot 2 */
  .c-ovl { position: absolute; top: 8px; left: 10px; font-size: 15px; font-weight: 900; background: rgba(0,0,0,0.6); padding: 4px 8px; border-radius: 4px; pointer-events: none; z-index: 10; }

  /* RIGHT: Movers */
  .movers { flex: 0 0 auto; min-height: 400px; display: flex; flex-direction: column; position: relative; }
  .m-head { padding: 14px; font-size: 20px; font-weight: 900; background: rgba(0,0,0,0.3); text-align: center; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .m-list { padding: 8px; flex: 1; }
  .m-row { display: grid; grid-template-columns: 1fr 80px 80px; padding: 10px 12px; font-size: 18px; font-weight: 800; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .mt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv { text-align: right; color: #9ca3af; }
  .mp { text-align: right; }

  .bar-wrap { height: 4px; background: #222; width: 100%; margin-top: auto; }
  .bar-fill { height: 100%; background: #444; width: 0%; animation: fill 5s linear infinite; }
  @keyframes fill { from { width: 0%; } to { width: 100%; } }

  .chat { flex: 1; display: flex; flex-direction: column; }
  .chat-area { flex: 1; background: #000; display: flex; align-items: center; justify-content: center; }
  .ph { font-size: 20px; font-weight: 900; color: #333; }

  /* FOOTER */
  .ft { height: 48px; background: #000; border-top: 1px solid #222; display: flex; align-items: center; overflow: hidden; white-space: nowrap; }
  .track { display: flex; padding-left: 20px; animation: scroll 40s linear infinite; }
  .mq-item { display: flex; gap: 8px; align-items: center; font-size: 18px; font-weight: 700; }
  .mq-k { color: #d1d5db; }
  .mq-v { color: #9ca3af; font-variant-numeric: tabular-nums; }
  .mq-sep { margin: 0 32px; color: #444; font-size: 12px; }

  @keyframes scroll { 100% { transform: translateX(-50%); } }
</style>
