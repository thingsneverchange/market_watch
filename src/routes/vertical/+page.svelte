<script lang="ts">
  // ============================================================
  //  세로 송출 화면 (1080×1920)
  //
  //  왜 별도 페이지인가:
  //   유튜브는 라이브에서 가로 스트림을 세로로 **자동 크롭해 주지 않는다**.
  //   세로 피드에 걸리려면 9:16 스트림을 따로 송출해야 한다 → OBS 씬을 하나 더 만들고
  //   이 페이지를 브라우저 소스로 잡으면 된다. 데이터는 가로 화면과 같은 API 를 쓴다.
  //
  //  세로에선 폭이 절반 이하다. 가로 레이아웃을 줄이면 아무것도 안 읽힌다 →
  //  **정보를 덜어내고 글자를 키웠다.** 시세 → 차트 → 무엇이 움직였나 → 헤드라인 순서.
  // ============================================================
  import "$lib/css/global.css";
  import FuturesChart from "$lib/components/FuturesChart.svelte";
  import { marketStatus, futuresSession, type MarketStatus, type FuturesSession } from "$lib/market-hours";
  import { onMount } from "svelte";

  let boards = { top: [] as any[], tape: [] as any[] };
  let digest = { driver: { text: "…", sentiment: "neu", noData: true }, news: [] as any[] };
  let reactions: any[] = [];
  let pastMacro: any[] = [];
  let slots: any[] = [];
  let mkt: MarketStatus = { open: false, session: "CLOSED", label: "…", reason: "", msToOpen: null };
  let futSess: FuturesSession = { open: false, label: "…" };
  let etNow = "";
  let nowMs = Date.now();
  let scale = 1;

  const jget = async (u: string) => { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch { return null; } };

  function stars(n: number) {
    // 별 5개를 다 그리지 않고 "5★" 로 압축한다 (세로 화면은 폭이 더 귀하다)
    const k = Math.max(1, Math.min(5, Math.round(n || 3)));
    return `${k}★`;
  }
  function ago(epoch: number, now: number) {
    const m = Math.max(0, Math.round((now / 1000 - epoch) / 60));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
  }
  function sent(s: string) {
    if (s === "bull" || s === "pos") return "pos";
    if (s === "bear" || s === "neg") return "neg";
    return "neu";
  }

  async function loadAll() {
    const [b, d, c, ctl] = await Promise.all([
      jget("/api/boards"), jget("/api/digest"), jget("/api/calendar"), jget("/api/control")
    ]);
    if (b) boards = { top: b.top ?? [], tape: b.tape ?? [] };
    if (d) digest = { driver: d.driver, news: d.news ?? [] };
    if (c) { reactions = c.reactions ?? []; pastMacro = c.pastMacro ?? []; }
    if (ctl && Array.isArray(ctl.slots) && ctl.slots.length) slots = ctl.slots;
  }

  function tick() {
    const now = new Date();
    nowMs = now.getTime();
    mkt = marketStatus(now);
    futSess = futuresSession(now);
    etNow = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true
    }).format(now);
  }

  // OBS 브라우저 소스는 1080×1920 로 잡는다. 그 외 창에서 열면 맞춰 축소해 미리보기 한다.
  function resize() {
    const inOBS = typeof window !== "undefined" && !!(window as any).obsstudio;
    scale = inOBS ? 1 : Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
  }

  onMount(() => {
    tick(); resize(); loadAll();
    const t1 = setInterval(tick, 1000);
    const t2 = setInterval(loadAll, 15000);
    window.addEventListener("resize", resize);
    return () => { clearInterval(t1); clearInterval(t2); window.removeEventListener("resize", resize); };
  });

  // 세로에선 차트 하나만 — 4분할은 판독이 안 된다
  $: mainSlot = slots[0] ?? null;
</script>

<svelte:head><title>MARKETWATCH · VERTICAL</title></svelte:head>

<div class="stage">
<div class="v" style={`transform: scale(${scale});`}>
  <!-- 헤더 -->
  <header class="vh">
    <div class="vh-l">MARKET<span>WATCH</span></div>
    <div class="vh-r">
      <span class="vh-st" class:open={mkt.open}>
        <span class="dot" class:on={mkt.open}></span>{mkt.label}
      </span>
      <span class="vh-cl">{etNow} ET</span>
    </div>
  </header>

  <!-- 시세 6개 — 세로에선 2줄 그리드가 가장 크게 읽힌다 -->
  <div class="vq">
    {#each boards.top.slice(0, 6) as t}
      <div class="vq-c">
        <div class="vq-k">{t.k}</div>
        <div class="vq-v">{t.v}</div>
        <div class="vq-p" class:u={t.pct >= 0} class:d={t.pct < 0}>
          {t.pct >= 0 ? "+" : "−"}{Math.abs(t.pct).toFixed(2)}%
        </div>
      </div>
    {/each}
  </div>

  <!-- 메인 차트 하나 -->
  <div class="vc">
    {#if mainSlot && mainSlot.mode === "nv"}
      <FuturesChart src="naver" symbol={mainSlot.nvCode} tf="m5" name={mainSlot.label} />
    {:else if mainSlot && mainSlot.mode === "fut"}
      <FuturesChart symbol={mainSlot.futKey} tf="m5"
                    name={mainSlot.key?.startsWith("fv:") ? "" : mainSlot.label} />
    {:else}
      <FuturesChart symbol="NQ" tf="m5" name="NASDAQ" />
    {/if}
  </div>

  <!-- 무엇이 움직였나 -->
  {#if reactions.length || pastMacro.length}
    <div class="vp">
      <div class="vp-h">⚡ WHAT MOVED</div>
      {#each pastMacro.slice(0, 2) as ev}
        <div class="vr">
          <div class="vr-l">
            <div class="vr-t">{ev.title}
              {#if ev.surprise === "hot"}<span class="chip miss">HOT</span>
              {:else if ev.surprise === "cool"}<span class="chip beat">COOL</span>
              {:else if ev.surprise === "inline"}<span class="chip inline">IN LINE</span>{/if}
            </div>
            <div class="vr-s">{ev.actual ? `${ev.actual}${ev.consensus ? ` vs ${ev.consensus}` : ""} · ` : ""}{ev.note || stars(ev.imp)}</div>
          </div>
        </div>
      {/each}
      {#each reactions.slice(0, 3) as r}
        <div class="vr">
          <div class="vr-l">
            <div class="vr-t">{r.ticker}
              {#if r.result === "beat"}<span class="chip beat">BEAT</span>
              {:else if r.result === "miss"}<span class="chip miss">MISS</span>
              {:else if r.result === "inline"}<span class="chip inline">IN LINE</span>{/if}
            </div>
            {#if r.tag}<div class="vr-s">{r.tag}</div>{/if}
          </div>
          <div class="vr-p" class:u={r.pct >= 0} class:d={r.pct < 0}>
            {r.pct >= 0 ? "+" : "−"}{Math.abs(r.pct).toFixed(1)}%
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- 헤드라인 -->
  <div class="vp vn">
    <div class="vp-h">MARKET HEADLINES</div>
    {#each digest.news.slice(0, 4) as n}
      <div class="vnw {sent(n.sentiment)}">
        <span class="vnw-s">{stars(n.level)}</span>
        <span class="vnw-t">{n.short ?? n.title}</span>
        {#if n.epoch}<span class="vnw-a">{ago(n.epoch, nowMs)}</span>{/if}
      </div>
    {/each}
    {#if digest.news.length === 0}<div class="vnw"><span class="vnw-t dim">No headlines</span></div>{/if}
  </div>

  <!-- 고지 + 흐르는 테이프 -->
  <footer class="vf">
    <div class="vf-d">DELAYED / PREV CLOSE · Not investment advice · Finnhub · Finviz · Naver · CoinGecko</div>
    <div class="vf-vp">
      <div class="vf-tr">
        {#each [...boards.tape, ...boards.tape] as t}
          <span class="vf-i"><b>{t.k}</b> {t.v}
            <i class:u={t.pct >= 0} class:d={t.pct < 0}>{t.pct >= 0 ? "+" : "−"}{Math.abs(t.pct).toFixed(2)}%</i>
          </span>
        {/each}
      </div>
    </div>
  </footer>
</div>
</div>

<style>
  .stage { width: 100vw; height: 100vh; overflow: hidden; background: #05070a;
    display: flex; align-items: center; justify-content: center; }
  /* 송출 캔버스 — 1080×1920 고정. OBS 는 scale 1 로 그대로 잡는다. */
  .v { width: 1080px; height: 1920px; transform-origin: center center; flex: none;
    background: #05070a; color: #e8edf4; display: flex; flex-direction: column;
    gap: 14px; padding: 18px; font-variant-numeric: tabular-nums; }

  .vh { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; }
  .vh-l { font-size: 34px; font-weight: 800; letter-spacing: -0.02em; }
  .vh-l span { color: #6b7280; }
  .vh-r { display: flex; align-items: center; gap: 14px; }
  .vh-st { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 800;
    color: #8a919b; letter-spacing: 0.06em; background: #12151b; border: 1px solid #23272f;
    padding: 7px 14px; border-radius: 999px; }
  .vh-st.open { color: #39d98a; background: #0d1712; border-color: #16281d; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; }
  .dot.on { background: #39d98a; }
  .vh-cl { font-size: 24px; font-weight: 800; }

  /* 시세 2×3 */
  .vq { flex: 0 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .vq-c { background: #0d0f13; border: 1px solid #191c22; border-radius: 12px; padding: 12px 14px; }
  .vq-k { font-size: 15px; font-weight: 800; color: #8a919b; letter-spacing: 0.05em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vq-v { font-size: 30px; font-weight: 800; margin-top: 2px; }
  .vq-p { font-size: 20px; font-weight: 800; }
  .vq-p.u { color: #39d98a; } .vq-p.d { color: #ff5c5c; }

  /* 차트 — 세로에서 가장 넓게 */
  .vc { flex: 0 0 620px; background: #08090c; border: 1px solid #191c22; border-radius: 14px;
    overflow: hidden; }

  .vp { flex: 0 0 auto; background: #0d0f13; border: 1px solid #191c22; border-radius: 14px;
    padding: 12px 14px; }
  .vp-h { font-size: 15px; font-weight: 800; letter-spacing: 0.12em; color: #8a919b;
    margin-bottom: 8px; }
  .vr { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 9px 0; border-top: 1px solid #161a20; }
  .vr:first-of-type { border-top: none; }
  .vr-l { min-width: 0; }
  .vr-t { font-size: 24px; font-weight: 800; display: flex; align-items: center; gap: 8px; }
  .vr-s { font-size: 15px; color: #8a919b; font-weight: 600; margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vr-p { font-size: 28px; font-weight: 800; flex: none; }
  .vr-p.u { color: #39d98a; } .vr-p.d { color: #ff5c5c; }
  .chip { font-size: 12px; font-weight: 800; padding: 3px 8px; border-radius: 5px; letter-spacing: 0.04em; }
  .chip.beat { color: #39d98a; background: #0d1712; border: 1px solid #16281d; }
  .chip.miss { color: #ff5c5c; background: #170d0d; border: 1px solid #2a1616; }
  .chip.inline { color: #8a919b; background: #12151b; border: 1px solid #23272f; }

  .vn { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .vnw { display: flex; align-items: baseline; gap: 10px; padding: 9px 0;
    border-top: 1px solid #161a20; }
  .vnw:first-of-type { border-top: none; }
  .vnw-s { font-size: 15px; color: #ff5c5c; letter-spacing: -1px; flex: none; }
  .vnw.pos .vnw-s { color: #39d98a; }
  .vnw.neu .vnw-s { color: #8a919b; }
  .vnw-t { font-size: 22px; font-weight: 700; line-height: 1.25; flex: 1;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden; }
  .vnw-t.dim { color: #4b5563; font-weight: 600; }
  .vnw-a { font-size: 15px; color: #6b7280; font-weight: 700; flex: none; }

  .vf { flex: 0 0 auto; }
  .vf-d { font-size: 13px; color: #4b5563; font-weight: 600; margin-bottom: 6px; }
  .vf-vp { overflow: hidden; border-top: 1px solid #191c22; padding-top: 8px; }
  .vf-tr { display: flex; gap: 30px; white-space: nowrap; animation: vmarq 60s linear infinite; }
  .vf-i { font-size: 19px; font-weight: 700; color: #8a919b; }
  .vf-i b { color: #e8edf4; font-weight: 800; margin-right: 6px; }
  .vf-i i { font-style: normal; font-weight: 800; margin-left: 6px; }
  .vf-i i.u { color: #39d98a; } .vf-i i.d { color: #ff5c5c; }
  @keyframes vmarq { from { transform: translateX(0); } to { transform: translateX(-50%); } }
</style>
