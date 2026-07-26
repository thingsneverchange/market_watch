<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";

  // 렌더 실패를 부모에게 알린다 — 방송 화면은 빈 채로 두느니 다른 소스로 갈아타야 한다
  const dispatch = createEventDispatcher<{ fail: { symbol: string } }>();

  export let symbol = "TVC:IXIC";
  export let interval = "1";
  export let theme: "dark" | "light" = "dark";
  export let mini = false;
  /** "advanced" = 풀 캔들차트 / "mini" = 경량 스파크라인 위젯 (좁은 슬롯용) */
  export let variant: "advanced" | "mini" = "advanced";

  const SRC = {
    advanced: "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js",
    mini: "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js"
  };

  // 4000ms(원본)는 콜드 캐시에서 오탐, 12000ms 는 방화벽 환경에서 안내 없는 12초 스피너.
  const RENDER_DEADLINE = 6000;
  const POLL_MS = 250;

  let container: HTMLDivElement;
  let mounted = false;
  let status: "loading" | "ok" | "error" = "loading";
  let failedSymbol = "";

  // 세대 토큰: build() 마다 +1. 이전 세대의 onerror/폴링 콜백을 전부 무효화한다.
  // 원본은 setTimeout 핸들이 없어, 심볼을 바꾸면 옛 4초 타이머가 발화해
  // 정상적으로 로딩 중인 새 차트를 "불러올 수 없어요" 오버레이로 덮었다.
  let token = 0;
  let builtSig = "";
  let pollId: ReturnType<typeof setInterval> | null = null;
  let activeScript: HTMLScriptElement | null = null;

  function stopPoll() {
    if (pollId !== null) { clearInterval(pollId); pollId = null; }
  }

  function dispose() {
    stopPoll();
    if (activeScript) {
      // DOM 에서 떼어내도 이미 시작된 다운로드는 취소되지 않는다.
      // 핸들러를 명시적으로 끊어야 죽은 스크립트의 콜백이 새 세대 상태를 건드리지 못한다.
      activeScript.onload = null;
      activeScript.onerror = null;
      activeScript.remove();
      activeScript = null;
    }
    if (container) container.innerHTML = "";
  }

  function config() {
    if (variant === "mini") {
      // ※ mini-symbol-overview 는 키 이름이 advanced-chart 와 완전히 다르다.
      //   interval / hide_* / backgroundColor 는 여기서 전부 무효(조용히 무시)다.
      return {
        symbol,
        width: "100%",
        height: "100%",
        locale: "en",
        dateRange: "1D",
        colorTheme: theme,
        isTransparent: true,
        autosize: true,   // 기본값이 false 라 반드시 명시
        chartOnly: true,
        noTimeScale: true
      };
    }
    return {
      autosize: true,
      symbol,
      interval,
      timezone: "America/New_York",
      theme,
      style: "1",
      locale: "en",
      allow_symbol_change: false,
      save_image: false,
      hide_top_toolbar: mini,
      hide_side_toolbar: true,
      hide_legend: mini,
      hide_volume: mini,
      details: false,
      withdateranges: false,
      // calendar:false 는 로더 allowlist 에 없는 죽은 키였다. 유효 키는 hotlist.
      hotlist: false,
      backgroundColor: "rgba(8,9,12,1)",
      gridColor: "rgba(255,255,255,0.03)"
    };
  }

  function build(sig: string) {
    // 가드를 통과한 뒤에 builtSig 를 세팅해야 "빌드 못 한 sig 를 빌드됨으로 기록"하는 사고가 없다.
    if (!mounted || !container) return;
    const my = ++token;
    builtSig = sig;
    dispose();

    status = "loading";
    failedSymbol = "";

    // TradingView 공식 스니펫 구조: div.container > [ div.__widget , script ]
    const slot = document.createElement("div");
    slot.className = "tradingview-widget-container__widget";
    container.appendChild(slot);

    const script = document.createElement("script");
    script.src = SRC[variant];
    script.type = "text/javascript";
    script.async = true;
    script.text = JSON.stringify(config());

    // ★ script.onload 로 status="ok" 를 세우지 않는다.
    //   onload 는 "JS 파일 다운로드 성공"일 뿐 차트 렌더 성공과 무관한데,
    //   원본에서는 이것이 아래 iframe 검사를 사문화시켜 실패 감지 자체를 죽였다.
    //   (심볼이 무료 임베드 미제공이라 에러 모달만 떠도 UI 는 "정상"이라고 주장했다)
    script.onerror = () => fail();
    container.appendChild(script);
    activeScript = script;

    const t0 = Date.now();
    pollId = setInterval(() => {
      if (my !== token) return; // 낡은 세대는 아무것도 하지 않는다
      if (container && container.querySelector("iframe")) { stopPoll(); status = "ok"; }
      else if (Date.now() - t0 >= RENDER_DEADLINE) fail();
    }, POLL_MS);

    function fail() {
      if (my !== token) return;
      stopPoll();
      failedSymbol = symbol;
      status = "error";
      // 오퍼레이터가 원인을 찾을 수 있는 유일한 흔적
      console.error("[TVChart] render failed:", symbol, interval, variant);
      dispatch("fail", { symbol });
    }
  }

  /** 수동 복구용 */
  export function retry() { build(sig); }

  $: sig = `${symbol}|${interval}|${theme}|${mini}|${variant}`; // mini/variant 누락은 잠복 버그였다
  $: if (mounted && sig !== builtSig) build(sig);

  // onMount 는 mounted 만 세운다.
  // 원본의 `mounted = true; build();` 는 mounted 대입이 위 반응 블록을 재실행시켜
  // 마운트당 build() 가 2회 돌았고, 첫 스크립트는 parentNode=null 상태로 실행돼
  // TradingView 로더 내부에서 TypeError 로 죽었다. (인스턴스 4개 → 로더 8회 실행)
  onMount(() => { mounted = true; });

  onDestroy(() => {
    mounted = false;
    token++; // 예약된 콜백 전부 무효화
    dispose();
  });
</script>

<div class="tvwrap">
  <div class="tvhost tradingview-widget-container" bind:this={container}></div>
  {#if status !== "ok"}
    <div class="tv-overlay" class:err={status === "error"} class:small={mini}>
      {#if status === "loading"}
        <span class="spin"></span> Loading chart…
      {:else}
        Chart unavailable <code>{failedSymbol}</code>
        {#if !mini}
          <small>
            Allow <b>tradingview.com</b> and <b>tradingview-widget.com</b> through your
            firewall/DNS. The symbol may also be unavailable on the free embed.
          </small>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .tvwrap { position: absolute; inset: 0; width: 100%; height: 100%; }
  .tvhost { position: relative; width: 100%; height: 100%; }
  .tvhost :global(.tradingview-widget-container__widget) { height: 100%; width: 100%; }
  .tvhost :global(iframe) { width: 100% !important; height: 100% !important; border: 0; display: block; }
  .tv-overlay {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 8px;
    color: #9aa3ad; font-size: 14px; font-weight: 600; text-align: center; padding: 12px;
    /* 완전 불투명이면 뒤에 정상 차트가 있어도 통째로 가린다 → 반투명 */
    background: rgba(8, 9, 12, 0.92);
    pointer-events: none;
  }
  .tv-overlay.small { font-size: 11px; gap: 4px; padding: 6px; }
  .tv-overlay.err { color: #d8a860; }
  .tv-overlay code { font-size: 13px; color: #c7cdd6; }
  /* 데이터 실패 시 가장 읽혀야 하는 줄인데 원본은 #4b5563 = 대비 2.36:1 이었다 */
  .tv-overlay small { color: #9aa3ad; font-size: 13px; max-width: 90%; line-height: 1.4; }
  .spin {
    width: 16px; height: 16px; border: 2px solid #2a2e36; border-top-color: #39d98a;
    border-radius: 50%; display: inline-block; animation: sp 0.8s linear infinite;
  }
  @keyframes sp { to { transform: rotate(360deg); } }
</style>
