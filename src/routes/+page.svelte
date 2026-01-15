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
    movers: [] as any[]
  };

  let digest = {
    driver: { text: "Analyzing Market Data...", sentiment: "neutral" },
    news: [] as any[]
  };

  let macro = { title: "LOADING...", time: new Date(Date.now() + 3600*1000*24), imp: 5 };
  let macroText = "--:--";

  let breakingData: { headline: string, level: number } | null = null;
  let lastBreakingMsg = ""; // [중복 방지용] 마지막에 띄운 뉴스 기억

  let scale = 1;

  // --- 로직 ---
  function updateTimers() {
    const now = new Date();
    etNow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(now);

    // 마켓 오픈 체크
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const min = et.getHours()*60 + et.getMinutes();
    const day = et.getDay();

    if (day===0 || day===6) { isMarketOpen=false; marketMsg="WEEKEND"; }
    else if (min>=570 && min<960) { isMarketOpen=true; marketMsg="MARKET OPEN"; }
    else { isMarketOpen=false; marketMsg = min<570 ? "PRE-MARKET" : "MARKET CLOSED"; }

    // Key Event 카운트다운
    if(macro.time) {
        const diff = macro.time.getTime() - now.getTime();
        // [수정] 0 이하면 RELEASED 대신 LIVE NOW 처리하거나, 다음 이벤트로 넘김
        if(diff <= -60000) macroText = "RELEASED"; // 1분 지남
        else if(diff <= 0) macroText = "LIVE NOW"; // 진행중
        else {
            const totalH = Math.floor(diff / 3600000);
            const totalM = Math.floor((diff % 3600000) / 60000);
            macroText = `IN ${totalH}h ${totalM}m`;
        }
    }
  }

  async function refresh() {
    // 1. Boards
    try {
        const r = await fetch("/api/boards");
        if(r.ok) {
            const j = await r.json();
            // 데이터가 있을 때만 갱신
            if(j.top && j.top.length > 0) boards = j;
        }
    } catch {}

    // 2. Digest (News)
    try {
        const r = await fetch("/api/digest");
        if(r.ok) {
            const j = await r.json();
            if(j.driver) digest = j;

            // [수정] 뉴스 토스트 중복 방지 로직
            if(j.news && j.news.length > 0) {
                const topNews = j.news[0];
                // Level 5이상 + 이전에 띄운 뉴스가 아닐 때만
                if(topNews.level >= 5 && topNews.title !== lastBreakingMsg) {
                    // 확률 체크 (너무 자주 뜨지 않게)
                    if(Math.random() > 0.5) {
                        breakingData = { headline: topNews.title, level: topNews.level };
                        lastBreakingMsg = topNews.title;

                        // 10초 뒤에 데이터 null로 초기화 (컴포넌트가 사라져도 데이터는 지워야 함)
                        setTimeout(() => { breakingData = null; }, 10000);
                    }
                }
            }
        }
    } catch {}

    // 3. Calendar
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

    const t1 = setInterval(updateTimers, 1000);
    const t2 = setInterval(refresh, 10000); // 10초 주기

    return () => {
        window.removeEventListener("resize", resize);
        clearInterval(t1);
        clearInterval(t2);
    };
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
                        {t.pct>0?"+":""}{t.v}%
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
                    <span class="lbl-y">KEY EVENT</span>
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
                        <MinimalChart symbol="NASDAQ:NDX" interval="5" height={560}/>
                        <div class="c-ovl">NASDAQ</div>
                    </div>
                    <div class="c-box">
                        <MinimalChart symbol="AMEX:SPY" interval="5" height={560}/>
                        <div class="c-ovl">S&P 500</div>
                    </div>
                    <div class="c-box">
                        <MinimalChart symbol="DJ:DJI" interval="5" height={560}/>
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
                    ⚡ IMPACT EARNINGS
                </div>
                <div class="m-list">
                    {#each boards.movers as m}
                        <div class="m-row">
                            <div class="m-info">
                                <span class="mt">{m.t}</span>
                                <span class="m-tag"
                                      class:g={m.status==='good'}
                                      class:b={m.status==='bad'}
                                      class:f={m.status==='future'}>
                                    {m.label}
                                </span>
                            </div>
                            <span class="mp" class:u={m.pct>=0} class:d={m.pct<0}>
                                {m.pct>0?"+":""}{Number(m.pct).toFixed(2)}%
                            </span>
                        </div>
                    {/each}
                    {#if boards.movers.length === 0}
                        <div class="m-empty">No Data</div>
                    {/if}
                </div>
            </div>

            <div class="card chat">
                <div class="lbl">LIVE CHAT</div>
                <div class="chat-area">Chat Embed Area</div>
            </div>
        </div>
    </main>

    <footer class="ft">
        <div class="track">
            {#each [...boards.tape, ...boards.tape, ...boards.tape] as t}
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
    :global(body) { margin:0; background:#000; overflow:hidden; font-family:'Inter', sans-serif; }
    .wrap { width:1920px; height:1080px; background:#050505; color:#fff; display:flex; flex-direction:column; transform-origin:top left; overflow:hidden; }

    .u{color:#4ade80} .d{color:#f87171}
    .pos{background:#064e3b; border-left:5px solid #34d399}
    .neg{background:#7f1d1d; border-left:5px solid #ef4444}
    .neu{background:#1f2937; border-left:5px solid #9ca3af}

    .hd { height:60px; display:flex; align-items:center; justify-content:space-between; padding:0 24px; background:#0a0a0a; border-bottom:1px solid #333; }
    .hd-l, .hd-r { display:flex; align-items:center; gap:20px; }
    .logo { font-size:24px; font-weight:900; letter-spacing:-1px; }
    .badge { font-size:14px; font-weight:800; background:#333; padding:4px 8px; border-radius:4px; color:#aaa; }
    .badge.active { background:#dc2626; color:#fff; }
    .clock { font-size:24px; font-weight:800; font-variant-numeric:tabular-nums; }

    .top-strip { display:flex; gap:20px; }
    .idx { display:flex; gap:8px; font-size:18px; font-weight:700; }
    .idx .k { color:#9ca3af; }

    .grid { flex:1; display:grid; grid-template-columns:400px 1fr 360px; gap:10px; padding:10px; overflow:hidden; }
    .col { display:flex; flex-direction:column; gap:10px; height:100%; overflow:hidden; }

    .card { background:#111; border:1px solid #333; border-radius:6px; overflow:hidden; }
    .lbl { padding:10px; font-size:14px; font-weight:900; color:#888; background:rgba(255,255,255,0.05); }

    .driver { min-height:140px; justify-content:center; display:flex; flex-direction:column; }
    .driver-txt { padding:16px; font-size:26px; font-weight:800; line-height:1.2; }

    .macro { padding:14px; }
    .m-row { display:flex; justify-content:space-between; margin-bottom:4px; }
    .lbl-y { color:#facc15; font-weight:800; }
    .timer { font-size:22px; font-weight:800; font-variant-numeric:tabular-nums; }
    .m-tit { font-size:20px; font-weight:700; text-transform:uppercase; }

    .news { flex:1; display:flex; flex-direction:column; }
    .news-list { flex:1; overflow:hidden; padding:10px; display:flex; flex-direction:column; gap:8px; }
    .news-item { padding:12px; border-radius:4px; }
    .n-meta { display:flex; justify-content:space-between; margin-bottom:4px; }
    .n-time { font-size:13px; font-weight:700; color:#aaa; }
    .n-tit { font-size:18px; font-weight:700; line-height:1.2; }

    .charts-wrap { display:flex; flex-direction:column; gap:10px; height:100%; }
    .c-row { display:grid; gap:10px; }
    .h-top { height:560px; grid-template-columns:1fr 1fr 1fr; }
    .h-bot { height:380px; grid-template-columns:1fr 1fr; }
    .c-box { background:#000; border:1px solid #333; position:relative; }
    .c-ovl { position:absolute; top:10px; left:10px; font-size:16px; font-weight:900; background:rgba(0,0,0,0.6); padding:4px 8px; border-radius:4px; pointer-events:none; }

    .movers { min-height:400px; display:flex; flex-direction:column; }
    .m-head { padding:14px; text-align:center; font-size:18px; font-weight:900; background:rgba(255,255,255,0.05); letter-spacing: 0.05em; color:#ddd; }

    .m-list { padding:10px; flex:1; overflow:hidden; display:flex; flex-direction:column; gap:6px; }
    .m-row {
        display:flex; justify-content:space-between; align-items:center;
        padding: 12px 14px;
        background: rgba(255,255,255,0.03);
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.05);
    }
    .m-info { display:flex; align-items:center; gap:10px; }
    .mt { font-size:20px; font-weight:800; color:#fff; width: 60px; }

    .m-tag {
        font-size:12px; font-weight:800; padding:4px 8px; border-radius:4px;
        color:#000; letter-spacing:0.05em; text-transform: uppercase;
    }
    .m-tag.f { background: #444; color:#aaa; border:1px solid #555; }
    .m-tag.g { background: #4ade80; color:#000; box-shadow: 0 0 10px rgba(74,222,128,0.3); }
    .m-tag.b { background: #f87171; color:#fff; box-shadow: 0 0 10px rgba(248,113,113,0.3); }

    .mp { font-size:18px; font-weight:700; font-variant-numeric: tabular-nums; }
    .m-empty { text-align:center; padding:20px; color:#555; font-weight:700; }

    .chat { flex:1; display:flex; flex-direction:column; }
    .chat-area { flex:1; background:#000; display:flex; align-items:center; justify-content:center; color:#333; font-weight:900; font-size:24px; }

    .ft { height:40px; background:#000; border-top:1px solid #333; display:flex; align-items:center; overflow:hidden; }
    .track { display:flex; padding-left:20px; animation:scroll 40s linear infinite; }
    .mq-item { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:700; color:#fff; white-space:nowrap; }
    .mq-k { color:#aaa; }
    .mq-sep { margin:0 30px; color:#555; }

    @keyframes scroll { 100% { transform: translateX(-50%); } }
</style>
