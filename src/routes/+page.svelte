<script lang="ts">
  import "$lib/css/global.css";
  import MinimalChart from "$lib/components/chart.svelte";
  import BreakingToast from "$lib/components/BreakingToast.svelte"; // 토스트 컴포넌트
  import { onMount } from "svelte";

  // --- STATE ---
  let etNow = "";
  let marketMsg = ""; // "Opens in..."
  let isMarketOpen = false;

  let boards = { top: [], tape: [], gainers: [], losers: [] };
  let digest = { driver: { text: "Loading...", sentiment: "neutral" }, news: [] };
  let macro = { title: "Loading...", time: null as Date|null, imp: 3 };

  // Breaking News Trigger
  let breakingData = null;

  // --- LOGIC ---
  function updateClock() {
    const now = new Date();
    // ET Time Calculation
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    etNow = new Intl.DateTimeFormat("en-US", { hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:true }).format(et);

    // Market Open Countdown (Simple NYSE Rule: Mon-Fri 09:30-16:00 ET)
    const day = et.getDay(); // 0=Sun
    const h = et.getHours();
    const m = et.getMinutes();
    const totalM = h * 60 + m;
    const OPEN = 570; // 09:30
    const CLOSE = 960; // 16:00

    if (day === 0 || day === 6) { // Weekend
        isMarketOpen = false;
        // Calculate milliseconds to Monday 9:30
        let daysToMon = (1 + 7 - day) % 7 || 7; // if Sat(6) -> 2 days, Sun(0) -> 1 day
        // This is rough approximation logic for display
        marketMsg = "WEEKEND • CLOSED";
    } else if (totalM >= OPEN && totalM < CLOSE) {
        isMarketOpen = true;
        marketMsg = "MARKET OPEN";
    } else {
        isMarketOpen = false;
        // Simple "Opens in" logic
        if (totalM < OPEN) {
            const diff = OPEN - totalM;
            const hh = Math.floor(diff/60);
            const mm = diff%60;
            marketMsg = `OPENS IN ${hh}h ${mm}m`;
        } else {
            marketMsg = "MARKET CLOSED";
        }
    }
  }

  // Countdown for Macro
  let macroCountdown = "";
  function updateMacroTimer() {
    if (!macro.time) { macroCountdown = "--:--"; return; }
    const diff = macro.time.getTime() - Date.now();
    if (diff <= 0) {
        macroCountdown = "RELEASED";
        return;
    }
    const mm = Math.floor(diff / 60000);
    const ss = Math.floor((diff % 60000) / 1000);
    macroCountdown = `T-MINUS ${mm}:${String(ss).padStart(2,'0')}`;
  }

  // Data Fetching
  async function refreshAll() {
    // 1. Boards
    const b = await (await fetch("/api/boards")).json();
    boards = b;

    // 2. Digest
    const d = await (await fetch("/api/digest")).json();
    digest = d;

    // Breaking Toast Test (임의로 첫번째 뉴스를 breaking으로 띄워봄 - 실제론 조건 필요)
    if (d.news.length > 0 && Math.random() > 0.7) {
        breakingData = { headline: d.news[0].title, level: d.news[0].level };
    }

    // 3. Calendar (Mocking logic for now as user api had 404)
    // 실제로는 /api/calendar 결과를 파싱해서 macro.time에 Date 객체 넣어야 함
    // 여기서는 예시로 10분 뒤 이벤트를 생성
    const now = new Date();
    macro = {
        title: "FOMC Minutes",
        time: new Date(now.getTime() + 10 * 60000), // 10분 뒤
        imp: 5
    };
  }

  onMount(() => {
    refreshAll();
    setInterval(updateClock, 1000);
    setInterval(updateMacroTimer, 1000);
    setInterval(refreshAll, 15000);
  });

  // Scale wrapper to fit window
  let scale = 1;
  function handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Fit 1920x1080 into window
    scale = Math.min(w / 1920, h / 1080);
  }
</script>

<svelte:window on:resize={handleResize} />
<div class="viewport" style="transform: scale({scale || 1})">

    {#if breakingData}
        <BreakingToast headline={breakingData.headline} level={breakingData.level} />
    {/if}

    <header class="head">
        <div class="brand">
            <div class="logo">FIRMNOTE</div>
            <div class="status-badge" class:open={isMarketOpen}>{marketMsg}</div>
        </div>
        <div class="clock">{etNow} ET</div>
    </header>

    <section class="top-bar">
        {#each boards.top as t}
            <div class="idx-box">
                <span class="idx-k">{t.k}</span>
                <span class="idx-v" class:up={t.pct>=0} class:down={t.pct<0}>
                    {t.pct>0?"+":""}{t.pct?.toFixed(2)}%
                </span>
            </div>
        {/each}
    </section>

    <main class="grid">
        <div class="col left">
            <div class="card driver" class:bull={digest.driver.sentiment==='bull'} class:bear={digest.driver.sentiment==='bear'}>
                <div class="label">MARKET DRIVER</div>
                <div class="driver-text">{digest.driver.text}</div>
            </div>

            <div class="card macro">
                <div class="macro-row">
                    <span class="label">UPCOMING EVENT</span>
                    <span class="timer">{macroCountdown}</span>
                </div>
                <div class="macro-title">{macro.title} <span class="imp">IMPACT {macro.imp}/5</span></div>
            </div>

            <div class="news-stack">
                <div class="label-sm">IMPACT NEWS</div>
                {#each digest.news as n}
                    <div class="news-item" class:pos={n.sentiment==='pos'} class:neg={n.sentiment==='neg'}>
                        <div class="news-head">
                            <span class="news-lvl">LVL {n.level}</span>
                            <span class="news-res">STACKED</span>
                        </div>
                        <div class="news-title">{n.title}</div>
                    </div>
                {/each}
            </div>
        </div>

        <div class="col center">
            <div class="chart-grid">
                <div class="c-cell big"><MinimalChart symbol="CME_MINI:NQ1!" interval="5" height={360} /><div class="c-ovl">NASDAQ</div></div>
                <div class="c-cell big"><MinimalChart symbol="CME_MINI:ES1!" interval="5" height={360} /><div class="c-ovl">S&P 500</div></div>
                <div class="c-cell big"><MinimalChart symbol="CBOT_MINI:YM1!" interval="5" height={360} /><div class="c-ovl">DOW</div></div>
                <div class="c-cell wide"><MinimalChart symbol="OANDA:XAUUSD" interval="15" height={300} /><div class="c-ovl">GOLD</div></div>
                <div class="c-cell wide"><MinimalChart symbol="BITSTAMP:BTCUSD" interval="15" height={300} /><div class="c-ovl">BITCOIN</div></div>
            </div>
        </div>

        <div class="col right">
            <div class="card movers">
                <div class="label">HOT MOVERS</div>
                <div class="movers-list">
                    {#each boards.gainers as g}
                        <div class="mover-row">
                            <span class="tkr">{g.t}</span>
                            <span class="pct up">+{g.pct?.toFixed(2)}%</span>
                        </div>
                    {/each}
                    <div class="sep"></div>
                    {#each boards.losers as l}
                        <div class="mover-row">
                            <span class="tkr">{l.t}</span>
                            <span class="pct down">{l.pct?.toFixed(2)}%</span>
                        </div>
                    {/each}
                </div>
            </div>

            <div class="card chat-box">
                <div class="label">LIVE CHAT</div>
                <div class="embed-area">Chat Ready</div>
            </div>
        </div>
    </main>

    <footer class="footer">
        <div class="marquee">
            {#each [...boards.tape, ...boards.tape] as t} <div class="mq-item">
                    <span class="mq-k">{t.k}</span>
                    <span class="mq-v">{t.v}</span>
                    <span class="mq-p" class:up={t.pct>=0} class:down={t.pct<0}>
                        {t.pct? (t.pct>0?"+":"")+t.pct.toFixed(2)+"%" : ""}
                    </span>
                    <span class="dash">//</span>
                </div>
            {/each}
        </div>
    </footer>
</div>

<style>
    /* RESET & BASE */
    :global(body) { margin:0; background:#000; overflow:hidden; font-family: sans-serif; }

    .viewport {
        width: 1920px; height: 1080px;
        background: #050505; color: white;
        transform-origin: top left; /* Scale from top-left */
        display: flex; flex-direction: column;
    }

    /* HEADER */
    .head { height: 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; background: #0a0a0a; border-bottom: 2px solid #222; }
    .logo { font-size: 32px; font-weight: 900; letter-spacing: -1px; margin-right: 16px; }
    .status-badge { font-size: 18px; font-weight: 700; padding: 4px 12px; border-radius: 6px; background: #333; color: #aaa; }
    .status-badge.open { background: #22c55e; color: #000; }
    .clock { font-size: 32px; font-weight: 800; font-variant-numeric: tabular-nums; }

    /* TOP BAR */
    .top-bar { height: 60px; display: flex; gap: 32px; align-items: center; padding: 0 24px; background: #111; border-bottom: 1px solid #333; }
    .idx-box { display: flex; gap: 12px; font-size: 24px; font-weight: 800; }
    .idx-k { color: #888; }
    .up { color: #4ade80; } .down { color: #f87171; }

    /* GRID LAYOUT */
    .grid { flex: 1; display: grid; grid-template-columns: 400px 1fr 380px; gap: 8px; padding: 8px; overflow: hidden; }
    .col { display: flex; flex-direction: column; gap: 8px; height: 100%; overflow: hidden; }

    /* CARDS & TEXT - BIGGER FONTS */
    .card { background: #161616; border-radius: 8px; border: 1px solid #333; overflow: hidden; }
    .label { font-size: 16px; font-weight: 900; color: #666; padding: 12px; background: rgba(0,0,0,0.3); letter-spacing: 1px; }
    .label-sm { font-size: 14px; font-weight: 900; color: #555; margin-bottom: 8px; padding-left: 4px; }

    /* LEFT COL */
    .driver { padding: 0; min-height: 140px; }
    .driver.bull { background: #064e3b; border-color: #059669; } /* Dark Green BG */
    .driver.bear { background: #7f1d1d; border-color: #dc2626; } /* Dark Red BG */
    .driver-text { font-size: 28px; font-weight: 800; padding: 16px; line-height: 1.2; }

    .macro { padding: 16px; background: #222; }
    .macro-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .timer { font-size: 28px; font-weight: 900; color: #facc15; font-variant-numeric: tabular-nums; }
    .macro-title { font-size: 20px; font-weight: 700; }
    .imp { font-size: 14px; background: #fff; color: #000; padding: 2px 6px; border-radius: 4px; margin-left: 8px; }

    .news-stack { flex: 1; overflow-y: hidden; display: flex; flex-direction: column; gap: 6px; }
    .news-item { background: #1a1a1a; padding: 14px; border-left: 8px solid #444; border-radius: 4px; }
    .news-item.pos { border-left-color: #22c55e; background: rgba(34,197,94,0.1); }
    .news-item.neg { border-left-color: #ef4444; background: rgba(239,68,68,0.1); }
    .news-head { display: flex; justify-content: space-between; font-size: 14px; font-weight: 800; color: #888; margin-bottom: 4px; }
    .news-title { font-size: 20px; font-weight: 700; line-height: 1.2; }

    /* CENTER COL - CHARTS */
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; grid-template-rows: 1.2fr 1fr; gap: 6px; height: 100%; }
    .c-cell { background: #000; border: 1px solid #333; position: relative; }
    .c-cell.wide { grid-column: span 3; display: flex; } /* 하단을 2개가 아닌 3개 병합 후 내부 분할 하거나, grid 수정 필요. 위 코드에선 wide를 span 3하고 내부에서 flex로 나누진 않았음. CSS grid 수정: */
    /* 수정된 grid: 하단 2개 배치를 위해 */
    .chart-grid { grid-template-columns: 1fr 1fr 1fr 1fr 1fr 1fr; } /* 6 cols */
    .c-cell.big { grid-column: span 2; } /* 상단 3개 (2+2+2=6) */
    .c-cell.wide { grid-column: span 3; } /* 하단 2개 (3+3=6) */

    .c-ovl { position: absolute; top: 8px; left: 8px; font-size: 18px; font-weight: 900; background: rgba(0,0,0,0.6); padding: 4px 8px; z-index: 10; pointer-events: none; }

    /* RIGHT COL */
    .movers { flex: 0 0 auto; }
    .movers-list { padding: 8px; }
    .mover-row { display: grid; grid-template-columns: 1fr 100px; padding: 8px 12px; font-size: 20px; font-weight: 800; background: #1a1a1a; margin-bottom: 4px; border-radius: 4px; }
    .sep { height: 8px; }

    .chat-box { flex: 1; display: flex; flex-direction: column; }
    .embed-area { flex: 1; background: #000; display: flex; align-items: center; justify-content: center; font-size: 20px; color: #333; font-weight: 900; }

    /* FOOTER MARQUEE */
    .footer { height: 50px; background: #172554; display: flex; align-items: center; overflow: hidden; white-space: nowrap; border-top: 2px solid #3b82f6; }
    .marquee { display: flex; animation: scroll 30s linear infinite; padding-left: 100%; }
    .mq-item { display: flex; align-items: center; gap: 12px; margin-right: 48px; }
    .mq-k { font-size: 24px; font-weight: 800; color: #93c5fd; }
    .mq-v { font-size: 24px; font-weight: 800; color: #fff; }
    .mq-p { font-size: 20px; font-weight: 700; }
    .dash { color: #3b82f6; opacity: 0.5; font-size: 24px; font-weight: 300; margin-left: 24px; }

    @keyframes scroll { 100% { transform: translateX(-100%); } }
</style>
