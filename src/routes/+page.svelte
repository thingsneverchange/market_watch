<script lang="ts">
  import "$lib/css/global.css";
  import MinimalChart from "$lib/components/chart.svelte";
  import BreakingToast from "$lib/components/BreakingToast.svelte";
  import MiniViz from "$lib/components/MiniViz.svelte";
  import ImpactBar from "$lib/components/ImpactBar.svelte";
  import { onMount } from "svelte";

  const audioMods = import.meta.glob("$lib/audio/*.{mp3,wav,ogg}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
  const audioSources = Object.values(audioMods);

  // --- 상태 ---
  let etNow = "";
  let marketMsg = "LOADING";
  let isMarketOpen = false;

  let boards = {
    top: [] as any[],
    tape: [] as any[],
    gainers: [] as any[],
    losers: [] as any[]
  };

  let digest = {
    driver: { text: "Analyzing market data...", sentiment: "neutral" },
    news: [] as any[]
  };

  let macro = { title: "FOMC Meeting", time: new Date(Date.now() + 3600*1000*24), imp: 5 }; // 기본값
  let macroText = "--:--";

  let breakingData = null;
  let moverMode: "gainers" | "losers" = "gainers";
  let scale = 1;

  // --- 로직 ---
  function updateTimers() {
    const now = new Date();
    etNow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(now);

    // 마켓 오픈 체크
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const min = et.getHours()*60 + et.getMinutes();
    const day = et.getDay();
    // 09:30 ~ 16:00
    if (day===0 || day===6) { isMarketOpen=false; marketMsg="WEEKEND"; }
    else if (min>=570 && min<960) { isMarketOpen=true; marketMsg="MARKET OPEN"; }
    else { isMarketOpen=false; marketMsg = min<570 ? "PRE-MARKET" : "MARKET CLOSED"; }

    // 매크로 카운트다운
    if(macro.time) {
        const diff = macro.time.getTime() - now.getTime();
        if(diff <= 0) macroText = "RELEASED";
        else {
            const h = Math.floor(diff/3600000);
            const m = Math.floor((diff%3600000)/60000);
            macroText = `IN ${h}h ${m}m`;
        }
    }
  }

  async function refresh() {
    // Boards
    try {
        const r = await fetch("/api/boards");
        if(r.ok) {
            const j = await r.json();
            if(j.top) boards = j;
        }
    } catch {}

    // Digest
    try {
        const r = await fetch("/api/digest");
        if(r.ok) {
            const j = await r.json();
            if(j.driver) digest = j;
            // 토스트 트리거 (랜덤)
            if(j.news && j.news.length>0 && Math.random()>0.85) {
                breakingData = { headline: j.news[0].title, level: j.news[0].level };
            }
        }
    } catch {}

    // Calendar
    try {
        const r = await fetch("/api/calendar");
        if(r.ok) {
            const j = await r.json();
            if(j.next) {
                macro.title = j.next.title;
                macro.imp = j.next.imp;
                macro.time = new Date(j.next.time);
            }
        }
    } catch {}
  }

  function resize() {
      const sx = window.innerWidth / 1920;
      const sy = window.innerHeight / 1080;
      scale = Math.min(sx, sy);
  }

  onMount(() => {
    resize();
    window.addEventListener("resize", resize);
    refresh();
    setInterval(updateTimers, 1000);
    setInterval(refresh, 15000);
    setInterval(() => { moverMode = moverMode==="gainers"?"losers":"gainers"; }, 5000);
    return () => window.removeEventListener("resize", resize);
  });

  function getSent(s:string) {
      if(s==='bull'||s==='pos') return 'pos';
      if(s==='bear'||s==='neg') return 'neg';
      return 'neu';
  }
</script>

<div class="wrap" style="transform: scale({scale});">
    {#if breakingData}
        <BreakingToast headline={breakingData.headline} level={breakingData.level} />
    {/if}

    <header class="hd">
        <div class="hd-l">
            <div class="logo">FIRMNOTE</div>
            <div class="badge" class:active={isMarketOpen}>{marketMsg}</div>
        </div>
        <div class="top-strip">
            {#each boards.top as t}
                <div class="idx">
                    <span class="k">{t.k}</span>
                    <span class="v" class:u={t.pct>=0} class:d={t.pct<0}>
                        {t.pct>0?"+":""}{Number(t.pct).toFixed(2)}%
                    </span>
                </div>
            {/each}
        </div>
        <div class="hd-r">
            <div class="clock">{etNow} ET</div>
            <MiniViz sources={audioSources} volume={0.4}/>
        </div>
    </header>

    <main class="grid">

        <div class="col left">
            <div class="card driver {getSent(digest.driver.sentiment)}">
                <div class="lbl">MARKET DRIVER</div>
                <div class="driver-txt">{digest.driver.text}</div>
            </div>

            <div class="card macro">
                <div class="m-row">
                    <span class="lbl-y">UPCOMING</span>
                    <span class="timer">{macroText}</span>
                </div>
                <div class="m-tit">{macro.title}</div>
            </div>

            <div class="card news">
                <div class="lbl">IMPACT NEWS</div>
                <div class="news-list">
                    {#each digest.news as n}
                        <div class="news-item {getSent(n.sentiment)}">
                            <div class="n-meta">
                                <span class="n-time">{n.timeET}</span>
                                <ImpactBar level={n.level}/>
                            </div>
                            <div class="n-tit">{n.title}</div>
                        </div>
                    {/each}
                </div>
            </div>
        </div>

        <div class="col center">
            <div class="charts-wrap">
                <div class="c-row h-top">
                    <div class="c-box">
                        <MinimalChart symbol="CME_MINI:NQ1!" interval="5" height={560}/>
                        <div class="c-ovl">NASDAQ</div>
                    </div>
                    <div class="c-box">
                        <MinimalChart symbol="CME_MINI:ES1!" interval="5" height={560}/>
                        <div class="c-ovl">S&P 500</div>
                    </div>
                    <div class="c-box">
                        <MinimalChart symbol="CBOT_MINI:YM1!" interval="5" height={560}/>
                        <div class="c-ovl">DOW JONES</div>
                    </div>
                </div>
                <div class="c-row h-bot">
                    <div class="c-box">
                        <MinimalChart symbol="OANDA:XAUUSD" interval="15" height={380}/>
                        <div class="c-ovl">GOLD</div>
                    </div>
                    <div class="c-box">
                        <MinimalChart symbol="BITSTAMP:BTCUSD" interval="15" height={380}/>
                        <div class="c-ovl">BITCOIN</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="col right">
            <div class="card movers">
                <div class="m-head">
                    {moverMode==='gainers' ? "🚀 TOP GAINERS" : "🩸 TOP LOSERS"}
                </div>
                <div class="m-list">
                    {#each (moverMode==='gainers'?boards.gainers:boards.losers) as m}
                        <div class="m-row">
                            <span class="mt">{m.t}</span>
                            <span class="mp" class:u={m.pct>=0} class:d={m.pct<0}>
                                {m.pct>0?"+":""}{Number(m.pct).toFixed(2)}%
                            </span>
                        </div>
                    {/each}
                </div>
            </div>
            <div class="card chat">
                <div class="lbl">CHAT</div>
                <div class="chat-area">Chat Embed Area</div>
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
    /* BASE */
    :global(body) { margin:0; background:#000; overflow:hidden; font-family:'Inter', sans-serif; }
    .wrap { width:1920px; height:1080px; background:#050505; color:#fff; display:flex; flex-direction:column; transform-origin:top left; overflow:hidden; }

    /* UTILS */
    .u{color:#4ade80} .d{color:#f87171}
    .pos{background:#064e3b; border-left:5px solid #34d399}
    .neg{background:#7f1d1d; border-left:5px solid #ef4444}
    .neu{background:#1f2937; border-left:5px solid #9ca3af}

    /* HEAD */
    .hd { height:60px; display:flex; align-items:center; justify-content:space-between; padding:0 24px; background:#0a0a0a; border-bottom:1px solid #333; }
    .hd-l, .hd-r { display:flex; align-items:center; gap:20px; }
    .logo { font-size:24px; font-weight:900; letter-spacing:-1px; }
    .badge { font-size:14px; font-weight:800; background:#333; padding:4px 8px; border-radius:4px; color:#aaa; }
    .badge.active { background:#dc2626; color:#fff; }
    .clock { font-size:24px; font-weight:800; font-variant-numeric:tabular-nums; }

    .top-strip { display:flex; gap:20px; }
    .idx { display:flex; gap:8px; font-size:18px; font-weight:700; }
    .idx .k { color:#9ca3af; }

    /* GRID */
    .grid { flex:1; display:grid; grid-template-columns:400px 1fr 360px; gap:10px; padding:10px; overflow:hidden; }
    .col { display:flex; flex-direction:column; gap:10px; height:100%; overflow:hidden; }

    /* LEFT */
    .card { background:#111; border:1px solid #333; border-radius:6px; overflow:hidden; }
    .lbl { padding:10px; font-size:14px; font-weight:900; color:#888; background:rgba(255,255,255,0.05); }

    .driver { min-height:140px; justify-content:center; }
    .driver-txt { padding:16px; font-size:26px; font-weight:800; line-height:1.2; }

    .macro { padding:14px; }
    .m-row { display:flex; justify-content:space-between; margin-bottom:4px; }
    .lbl-y { color:#facc15; font-weight:800; }
    .timer { font-size:22px; font-weight:800; font-variant-numeric:tabular-nums; }
    .m-tit { font-size:20px; font-weight:700; }

    .news { flex:1; display:flex; flex-direction:column; }
    .news-list { flex:1; overflow:hidden; padding:10px; display:flex; flex-direction:column; gap:8px; }
    .news-item { padding:12px; border-radius:4px; }
    .n-meta { display:flex; justify-content:space-between; margin-bottom:4px; }
    .n-time { font-size:13px; font-weight:700; color:#aaa; }
    .n-tit { font-size:18px; font-weight:700; line-height:1.2; }

    /* CENTER */
    .charts-wrap { display:flex; flex-direction:column; gap:10px; height:100%; }
    .c-row { display:grid; gap:10px; }
    .h-top { height:560px; grid-template-columns:1fr 1fr 1fr; } /* Pixel Perfect Height */
    .h-bot { height:380px; grid-template-columns:1fr 1fr; }   /* Pixel Perfect Height */
    .c-box { background:#000; border:1px solid #333; position:relative; }
    .c-ovl { position:absolute; top:10px; left:10px; font-size:16px; font-weight:900; background:rgba(0,0,0,0.6); padding:4px 8px; border-radius:4px; pointer-events:none; }

    /* RIGHT */
    .movers { min-height:400px; display:flex; flex-direction:column; }
    .m-head { padding:14px; text-align:center; font-size:20px; font-weight:900; background:rgba(255,255,255,0.05); }
    .m-list { padding:10px; }
    .m-row { display:flex; justify-content:space-between; padding:10px; font-size:20px; font-weight:800; border-bottom:1px solid #222; }
    .mp { text-align:right; }

    .chat { flex:1; display:flex; flex-direction:column; }
    .chat-area { flex:1; background:#000; display:flex; align-items:center; justify-content:center; color:#333; font-weight:900; font-size:24px; }

    /* FOOTER */
    .ft { height:40px; background:#000; border-top:1px solid #333; display:flex; align-items:center; overflow:hidden; }
    .track { display:flex; padding-left:20px; animation:scroll 40s linear infinite; }
    .mq-item { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:700; color:#fff; }
    .mq-k { color:#aaa; }
    .mq-sep { margin:0 30px; color:#555; }

    @keyframes scroll { 100% { transform: translateX(-50%); } }
</style>
