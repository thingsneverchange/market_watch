<script context="module" lang="ts">
  // 인스턴스마다 고유한 SVG id 를 만들기 위한 카운터 (문서 전역 id 충돌 방지)
  let SEQ = 0;
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  // ============================================================
  //  메인 선물 차트 — 자체 SVG 렌더
  //
  //  TradingView 무료 임베드를 메인에서 뺀 이유는 /api/futchart 주석 참고.
  //  요약: 주말에 빈 화면이 되고, 애초에 선물을 못 그린다.
  //
  //  viewBox 로 늘리지 않고 **실제 픽셀 크기로 그린다**. preserveAspectRatio="none"
  //  로 늘리면 글자와 선 두께까지 같이 찌그러져서 1920 송출에서 티가 난다.
  // ============================================================

  export let symbol = "NQ";
  export let tf: "m5" | "h1" | "d1" = "m5";
  export let refreshMs = 60_000;
  /** 화면에 크게 박을 이름 (프리셋 라벨). 없으면 소스가 준 이름을 쓴다. */
  export let name = "";
  /** 4분할처럼 좁을 때 글자·여백을 줄인다 */
  export let compact = false;
  export let style: "line" | "candle" = "line";
  /** "finviz" = 선물(종가 기반) / "naver" = 지수 원본(거래소 진짜 OHLC) */
  export let src: "finviz" | "naver" = "finviz";
  /** Auto-Sniper 가 물어온 슬롯이면 이유를 표시한다 */
  export let why = "";
  /**
   * 이 종목이 **지금 거래되고 있는가**. 이름 옆 점이 깜빡인다.
   *  화면에 큰 숫자가 떠 있으면 시청자는 당연히 실시간이라고 읽는다.
   *  실제로는 야간·주말엔 얼어 있는 값일 수 있으므로, "지금 움직이는 중"을
   *  숫자 자체가 아니라 **별도 신호**로 말한다.
   *  판단은 화면(부모)이 한다 — 소스마다 세션 시계가 다르다(Globex / NYSE / 거래소).
   */
  export let live = false;
  /** 그 세션이 무엇인지 ("PRE" / "REGULAR" / "AFTER" …). 비면 점만 찍는다. */
  export let session = "";
  /**
   * 지금 그리고 있는 게 **무슨 상품인가** ("FUT" / "ETF" / "INDEX" / "SPOT").
   *  같은 "NASDAQ" 이라도 장 밖엔 NQ 선물(28,704), 정규장엔 QQQ ETF 다.
   *  값의 자릿수부터 다른데 라벨이 둘 다 "NASDAQ" 이면 같은 걸로 읽힌다.
   */
  export let instrument = "";

  type Payload = {
    ok: boolean; label?: string; price?: number; changePct?: number;
    changeAbs?: number | null;
    base?: number | null; points?: number[]; marks?: { at: number; label: string }[];
    candles?: { o: number; h: number; l: number; c: number }[];
    candleMin?: number | null;
    realOhlc?: boolean;
    delayMin?: number; tradedAt?: string | null; status?: string;
    reason?: string;
  };

  let box: HTMLDivElement;
  let W = 0, H = 0;
  let data: Payload | null = null;
  let err = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let ro: ResizeObserver | null = null;
  let sizeTimer: ReturnType<typeof setInterval> | null = null;
  let raf = 0;
  let token = 0;   // 심볼/주기를 바꿔도 옛 응답이 새 상태를 덮지 않게

  // 상단 여백은 큰 시세 표기가 차지하는 높이만큼 비워 둔다 (곡선이 글자에 가리지 않게)
  $: PAD = { t: compact ? 52 : 74, r: compact ? 54 : 66, b: 24, l: 10 };

  // ★ SVG 의 id 는 **문서 전역**이다. 차트를 2~4개 띄우면 같은 "fc-fill" 이 여러 번
  //   정의되고 먼저 정의된 것이 나머지를 덮는다 → 상승(초록) 금 차트에 하락(빨강)
  //   그라디언트가 칠해졌다(실측). 인스턴스마다 고유 id 를 준다.
  const uid = `fcg${++SEQ}`;

  async function load() {
    const mine = ++token;
    try {
      const r = await fetch(
        `/api/futchart?src=${src}&key=${encodeURIComponent(symbol)}&tf=${tf}&style=${style}`);
      const j: Payload = await r.json();
      if (mine !== token) return;           // 늦게 온 옛 응답은 버린다
      if (!j.ok) { err = j.reason || "no data"; data = null; return; }
      err = ""; data = j;
    } catch (e: any) {
      if (mine !== token) return;
      err = "unreachable";
    }
  }

  // 심볼·주기·표시방식이 바뀌면 즉시 다시 받는다
  $: symbol, tf, style, src, load();

  /**
   * 크기 측정.
   * ※ offsetWidth/Height 를 쓴다 — 이 화면은 부모에 transform: scale() 이 걸려 있어서
   *   getBoundingClientRect() 는 **축소된 시각 크기**를 준다. SVG 는 레이아웃 픽셀 기준으로
   *   그려야 글자·선 두께가 맞는다.
   */
  function measure() {
    if (!box) return;
    const w = box.offsetWidth, h = box.offsetHeight;
    if (w > 0 && h > 0 && (w !== W || h !== H)) { W = w; H = h; }
  }

  onMount(() => {
    // ★ ResizeObserver 의 **초기 콜백에 의존하면 안 된다**.
    //   실측: 프로덕션 빌드에서 콜백이 한 번도 안 울려 W/H 가 0 으로 남았고,
    //   차트가 "Loading chart…" 에서 영원히 멈췄다 (데이터는 정상 수신 중인데도).
    //   방송 화면 한가운데가 그대로 멈춘다는 뜻이라 반드시 직접 재야 한다.
    measure();
    // 레이아웃이 아직 안 끝났을 수 있으니 다음 프레임에 한 번 더
    raf = requestAnimationFrame(() => { measure(); raf = requestAnimationFrame(measure); });
    try {
      ro = new ResizeObserver(measure);   // 이후 변화 대응 (초기값은 위에서 이미 잡았다)
      ro.observe(box);
    } catch { /* ResizeObserver 가 없어도 아래 폴백으로 버틴다 */ }
    window.addEventListener("resize", measure);
    // 마지막 안전망 — 어떤 이유로든 0 이면 계속 재시도한다 (화면이 비는 것보다 낫다)
    sizeTimer = setInterval(() => { if (!(W > 0 && H > 0)) measure(); }, 1000);
    timer = setInterval(load, refreshMs);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (sizeTimer) clearInterval(sizeTimer);
    if (raf) cancelAnimationFrame(raf);
    ro?.disconnect();
    if (typeof window !== "undefined") window.removeEventListener("resize", measure);
  });

  // ── 스케일 ────────────────────────────────
  $: pts = (data?.points ?? []).filter((n) => Number.isFinite(n));
  $: base = typeof data?.base === "number" && Number.isFinite(data.base) ? data.base : null;
  $: up = (data?.changePct ?? 0) >= 0;
  $: stroke = up ? "#39d98a" : "#ff5c5c";

  $: candles = data?.candles ?? [];
  $: isCandle = style === "candle" && candles.length > 1;
  // 거래소 진짜 OHLC 면 "5분 종가로 만든 봉" 고지를 붙이면 안 된다
  $: realOhlc = data?.realOhlc === true;

  // 보합선도 범위에 넣어야 한다. 값이 종일 정산가 위에 있으면 선이 화면 밖으로 밀린다.
  //  캔들이면 꼬리(고가·저가)까지 넣어야 위아래가 잘리지 않는다.
  $: pool = [
    ...(isCandle ? candles.flatMap((c) => [c.h, c.l]) : pts),
    ...(base !== null ? [base] : [])
  ];
  $: lo = pool.length ? Math.min(...pool) : 0;
  $: hi = pool.length ? Math.max(...pool) : 1;
  // 위아래 6% 여백 — 곡선이 테두리에 붙으면 답답하다
  $: padV = (hi - lo || 1) * 0.06;
  $: min = lo - padV;
  $: max = hi + padV;

  $: plotW = Math.max(0, W - PAD.l - PAD.r);
  $: plotH = Math.max(0, H - PAD.t - PAD.b);
  $: N = isCandle ? candles.length : pts.length;
  $: X = (i: number) => PAD.l + (N > 1 ? (i / (N - 1)) * plotW : 0);
  // 봉 폭 — 사이 간격을 조금 남긴다
  $: cw = isCandle ? Math.max(1.5, (plotW / N) * 0.68) : 0;
  $: Y = (v: number) => PAD.t + (1 - (v - min) / (max - min || 1)) * plotH;

  $: line = pts.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  $: area = pts.length
    ? `${line} L${X(pts.length - 1).toFixed(1)},${(PAD.t + plotH).toFixed(1)} L${PAD.l},${(PAD.t + plotH).toFixed(1)} Z`
    : "";

  // 가격 눈금 5개 — 우측에 붙인다 (트레이딩 화면 관례)
  $: ticks = plotH > 0
    ? Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4)
    : [];

  /** 값의 크기에 맞는 소수 자릿수 (28,306 → 0자리 / 90.47 → 2자리 / 0.6975 → 4자리) */
  function digitsFor(n: number) {
    const a = Math.abs(n);
    return a >= 1000 ? 0 : a >= 10 ? 2 : 4;
  }
  function fmtPx(n: number) {
    const d = digitsFor(n);
    return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  /**
   * 큰 시세 표기용. **하단 미니차트(/api/boards)와 반올림 규칙이 같아야 한다** —
   * 같은 NQ 를 위에선 28,307, 아래선 28,306.5 로 찍으면 시청자에겐 버그로 보인다.
   * 축 눈금(fmtPx)은 촘촘하면 지저분하니 따로 둔다.
   *
   * 등락폭도 **가격의 자릿수**를 따른다. 자기 크기로 정하면 원유 −2.88 이
   * −2.8800 으로 찍힌다 (가격은 90.47 인데).
   */
  function fmtQuote(n: number, ref = n) {
    const a = Math.abs(ref);
    const max = a >= 10 ? 2 : 4;
    return Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: max });
  }

  $: lastVal = isCandle
    ? (candles.length ? candles[candles.length - 1].c : 0)
    : (pts.length ? pts[pts.length - 1] : 0);
  $: lastX = N ? X(N - 1) : 0;
  $: lastY = lastVal ? Y(lastVal) : 0;

  // ── 큰 시세 표기 ───────────────────────────
  //  %만 보면 "몇 포인트 빠졌나"가 안 잡힌다. 포인트 등락을 같은 크기로 나란히 둔다.
  $: title = name || data?.label || symbol;
  $: abs = typeof data?.changeAbs === "number" && Number.isFinite(data.changeAbs)
    ? data.changeAbs : null;
  $: sign = (data?.changePct ?? 0) >= 0 ? "+" : "−";  // 진짜 마이너스 기호(−)가 방송에서 또렷하다
  $: absTxt = abs === null || !lastVal ? "" : sign + fmtQuote(abs, lastVal);
  $: pctTxt = sign + Math.abs(data?.changePct ?? 0).toFixed(2) + "%";
  $: priceTxt = lastVal ? fmtQuote(lastVal) : "—";

  // 눈금 라벨이 보합선 라벨·현재가 태그와 세로로 겹치는지 (겹치면 눈금을 숨긴다)
  const GAP = 13;
  $: collides = (y: number) =>
    Math.abs(y - lastY) < GAP || (base !== null && Math.abs(y - Y(base)) < GAP);
  $: visibleMarks = (data?.marks ?? []).filter(
    (m, i, arr) => i === 0 || m.label !== arr[i - 1].label);
  $: ready = (isCandle ? candles.length > 1 : pts.length > 1) && W > 0 && H > 0;
</script>

<div class="fc" bind:this={box}>
  {#if ready}
    <!-- 큰 시세 오버레이 — 멀리서·폰에서도 "뭐가 몇 포인트 빠졌나"가 바로 읽혀야 한다 -->
    <div class="fc-read" class:sm={compact}>
      <div class="fc-name">
        {title}
        <!-- ★ 무슨 상품인지 — 이름만으론 구분이 안 된다.
             장 밖 "NASDAQ" = NQ 선물(28,704), 정규장 "NASDAQ" = QQQ ETF.
             자릿수부터 다른 값을 같은 이름으로 띄우면 시청자는 같은 걸로 읽는다. -->
        {#if instrument}<span class="fc-inst">{instrument}</span>{/if}
        <!-- ★ 깜빡이는 점 = "이 숫자는 지금 움직이고 있다".
             큰 숫자가 떠 있으면 시청자는 무조건 실시간으로 읽는데, 야간·주말엔
             얼어 있는 값일 수 있다. 정지 상태에서는 점을 아예 안 그린다 —
             회색 점은 "꺼짐"이 아니라 "장식"으로 읽혀서 구분이 안 된다. -->
        {#if live}
          <span class="fc-live"><span class="fc-dot"></span>{session}</span>
        {/if}
      </div>
      <div class="fc-row" class:up class:dn={!up}>
        <span class="fc-price">{priceTxt}</span>
        {#if absTxt}<span class="fc-abs">{absTxt}</span>{/if}
        <span class="fc-pct">{pctTxt}</span>
      </div>
      {#if why}
        <!-- 차트가 왜 이걸로 바뀌었는지 밝힌다 (근거 없이 바뀌면 시청자가 못 따라온다) -->
        <div class="fc-why">{why}</div>
      {/if}
      {#if isCandle && !realOhlc && data?.candleMin}
        <!-- 진짜 틱 캔들이 아니라 5분 종가를 묶은 봉이다. 숨기지 않는다.
             (하단에 두면 시간축 라벨과 겹친다) -->
        <div class="fc-src">{data.candleMin}m bars · from 5m closes</div>
      {:else if realOhlc}
        <!-- 지연 여부를 그대로 밝힌다 (해외 지수는 15분 지연) -->
        <div class="fc-src">
          exchange OHLC{data?.delayMin ? ` · ${data.delayMin}m delayed` : ""}
        </div>
      {/if}
    </div>
  {/if}
  {#if ready}
    <svg width={W} height={H} role="img" aria-label={`${data?.label ?? symbol} chart`}>
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color={stroke} stop-opacity="0.26" />
          <stop offset="100%" stop-color={stroke} stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- 가로 격자 + 우측 가격 눈금.
           격자선은 항상 그리되 **라벨은 보합선/현재가 태그와 겹치면 숨긴다**.
           안 그러면 두 숫자가 같은 자리에 겹쳐 찍혀 둘 다 못 읽는다. -->
      {#each ticks as t}
        <line x1={PAD.l} y1={Y(t)} x2={PAD.l + plotW} y2={Y(t)} stroke="#1b2029" stroke-width="1" />
        {#if !collides(Y(t))}
          <text x={PAD.l + plotW + 8} y={Y(t) + 4} class="ax">{fmtPx(t)}</text>
        {/if}
      {/each}

      <!-- 세로 격자 + 시간 눈금.
           거래시간이 짧은 종목(목재 등)은 Finviz 눈금이 "2PM 2PM 2PM" 처럼 겹쳐 온다.
           연속 중복 라벨은 접어서 고장난 것처럼 보이지 않게 한다. -->
      {#each visibleMarks as m}
        {#if m.at > 0 && m.at < N - 1}
          <line x1={X(m.at)} y1={PAD.t} x2={X(m.at)} y2={PAD.t + plotH}
                stroke="#1b2029" stroke-width="1" />
          <text x={X(m.at)} y={PAD.t + plotH + 16} class="ax mid">{m.label}</text>
        {/if}
      {/each}

      {#if !isCandle}
        <path d={area} fill={`url(#${uid})`} />
      {/if}

      <!-- 보합선(전일 정산가): 곡선이 이 위면 오늘 상승 -->
      {#if base !== null}
        <line x1={PAD.l} y1={Y(base)} x2={PAD.l + plotW} y2={Y(base)}
              stroke="#7b8494" stroke-width="1" stroke-dasharray="5 5" opacity="0.85" />
        <text x={PAD.l + plotW + 8} y={Y(base) + 4} class="ax base">{fmtPx(base)}</text>
      {/if}

      {#if isCandle}
        <!-- 봉: 심지(고가-저가) + 몸통(시가-종가). 종가≥시가면 초록. -->
        {#each candles as c, i}
          {@const up2 = c.c >= c.o}
          {@const col = up2 ? "#39d98a" : "#ff5c5c"}
          {@const yo = Y(c.o)}
          {@const yc = Y(c.c)}
          <line x1={X(i)} y1={Y(c.h)} x2={X(i)} y2={Y(c.l)} stroke={col} stroke-width="1" />
          <rect x={X(i) - cw / 2} y={Math.min(yo, yc)} width={cw}
                height={Math.max(1, Math.abs(yc - yo))} fill={col} />
        {/each}
      {:else}
        <path d={line} fill="none" stroke={stroke} stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" />
      {/if}

      <!-- 현재가 태그 -->
      <line x1={PAD.l} y1={lastY} x2={lastX} y2={lastY} stroke={stroke}
            stroke-width="1" stroke-dasharray="3 3" opacity="0.45" />
      {#if !isCandle}<circle cx={lastX} cy={lastY} r="3.5" fill={stroke} />{/if}
      <rect x={PAD.l + plotW + 3} y={lastY - 10} width={PAD.r - 6} height="20" rx="3" fill={stroke} />
      <text x={PAD.l + plotW + 8} y={lastY + 4} class="ax now">{fmtPx(pts[pts.length - 1])}</text>
    </svg>
  {:else}
    <div class="fc-msg">{err ? `Chart unavailable — ${err}` : "Loading chart…"}</div>
  {/if}
</div>

<style>
  .fc { width: 100%; height: 100%; position: relative; }
  .fc svg { display: block; }

  /* 큰 시세 표기 — 이 방송의 첫 번째 정보. 폰으로 축소돼도 읽혀야 한다. */
  .fc-read { position: absolute; top: 6px; left: 12px; pointer-events: none; z-index: 2; }
  .fc-name { font-size: 15px; font-weight: 800; letter-spacing: 0.06em;
    color: #8a919b; text-transform: uppercase; margin-bottom: 2px;
    display: flex; align-items: center; gap: 7px; }
  /* 상품 표기 — 이름 옆 작은 배지. 값이 무엇인지 헷갈리면 안 된다. */
  .fc-inst { font-size: 10px; font-weight: 800; letter-spacing: 0.06em; color: #7d94b8;
    background: #12181f; border: 1px solid #1c2430; border-radius: 4px;
    padding: 1px 5px; line-height: 1.5; }
  /* 라이브 표시 — 방송의 REC 램프와 같은 뜻이다 */
  .fc-live { display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-weight: 800; letter-spacing: 0.08em; color: #ff5c5c; }
  .fc-dot { width: 7px; height: 7px; border-radius: 50%; background: #ff3b30;
    box-shadow: 0 0 6px rgba(255, 59, 48, 0.9); animation: fcpulse 1.6s ease-in-out infinite; }
  /* 완전히 사라지게 하지 않는다 — 24시간 방송에서 깜빡임이 세면 눈이 피로하다 */
  @keyframes fcpulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.35; transform: scale(0.82); }
  }
  /* 접근성/저사양: 모션을 끄면 점은 그대로 켜 둔다 (정보가 사라지면 안 된다) */
  @media (prefers-reduced-motion: reduce) {
    .fc-dot { animation: none; }
  }
  .fc-row { display: flex; align-items: baseline; gap: 14px;
    font-variant-numeric: tabular-nums; line-height: 1.05; }
  .fc-price { font-size: 40px; font-weight: 800; color: #e8edf4; letter-spacing: -0.01em; }
  .fc-abs, .fc-pct { font-size: 27px; font-weight: 800; }
  .fc-row.up .fc-abs, .fc-row.up .fc-pct { color: #39d98a; }
  .fc-row.dn .fc-abs, .fc-row.dn .fc-pct { color: #ff5c5c; }

  /* 4분할처럼 좁을 때 */
  .fc-read.sm .fc-name { font-size: 12px; }
  .fc-read.sm .fc-price { font-size: 26px; }
  .fc-read.sm .fc-abs, .fc-read.sm .fc-pct { font-size: 18px; }
  .fc-read.sm .fc-row { gap: 9px; }
  /* Auto-Sniper 사유 */
  .fc-why { margin-top: 3px; font-size: 11px; font-weight: 800; letter-spacing: 0.04em;
    color: #f0b429; }
  .fc-read.sm .fc-why { font-size: 9px; }
  /* 봉 출처 고지 */
  .fc-src { margin-top: 2px; font-size: 9px; font-weight: 700;
    color: #4b5563; letter-spacing: 0.03em; }
  .ax { fill: #6b7280; font-size: 11px; font-weight: 700;
    font-variant-numeric: tabular-nums; }
  .ax.mid { text-anchor: middle; }
  .ax.base { fill: #98a1b0; }
  .ax.now { fill: #06121a; font-weight: 800; }
  .fc-msg { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
    color: #4b5563; font-size: 14px; font-weight: 700; }
</style>
