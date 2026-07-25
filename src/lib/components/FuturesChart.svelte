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

  type Payload = {
    ok: boolean; label?: string; price?: number; changePct?: number;
    base?: number | null; points?: number[]; marks?: { at: number; label: string }[];
    reason?: string;
  };

  let box: HTMLDivElement;
  let W = 0, H = 0;
  let data: Payload | null = null;
  let err = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let ro: ResizeObserver | null = null;
  let token = 0;   // 심볼/주기를 바꿔도 옛 응답이 새 상태를 덮지 않게

  const PAD = { t: 14, r: 66, b: 24, l: 10 };

  async function load() {
    const mine = ++token;
    try {
      const r = await fetch(`/api/futchart?key=${encodeURIComponent(symbol)}&tf=${tf}`);
      const j: Payload = await r.json();
      if (mine !== token) return;           // 늦게 온 옛 응답은 버린다
      if (!j.ok) { err = j.reason || "no data"; data = null; return; }
      err = ""; data = j;
    } catch (e: any) {
      if (mine !== token) return;
      err = "unreachable";
    }
  }

  // 심볼이나 타임프레임이 바뀌면 즉시 다시 받는다
  $: symbol, tf, load();

  onMount(() => {
    ro = new ResizeObserver(([e]) => {
      W = Math.round(e.contentRect.width);
      H = Math.round(e.contentRect.height);
    });
    ro.observe(box);
    timer = setInterval(load, refreshMs);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
    ro?.disconnect();
  });

  // ── 스케일 ────────────────────────────────
  $: pts = (data?.points ?? []).filter((n) => Number.isFinite(n));
  $: base = typeof data?.base === "number" && Number.isFinite(data.base) ? data.base : null;
  $: up = (data?.changePct ?? 0) >= 0;
  $: stroke = up ? "#39d98a" : "#ff5c5c";

  // 보합선도 범위에 넣어야 한다. 값이 종일 정산가 위에 있으면 선이 화면 밖으로 밀린다.
  $: pool = base !== null ? [...pts, base] : pts;
  $: lo = pool.length ? Math.min(...pool) : 0;
  $: hi = pool.length ? Math.max(...pool) : 1;
  // 위아래 6% 여백 — 곡선이 테두리에 붙으면 답답하다
  $: padV = (hi - lo || 1) * 0.06;
  $: min = lo - padV;
  $: max = hi + padV;

  $: plotW = Math.max(0, W - PAD.l - PAD.r);
  $: plotH = Math.max(0, H - PAD.t - PAD.b);
  $: X = (i: number) => PAD.l + (pts.length > 1 ? (i / (pts.length - 1)) * plotW : 0);
  $: Y = (v: number) => PAD.t + (1 - (v - min) / (max - min || 1)) * plotH;

  $: line = pts.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  $: area = pts.length
    ? `${line} L${X(pts.length - 1).toFixed(1)},${(PAD.t + plotH).toFixed(1)} L${PAD.l},${(PAD.t + plotH).toFixed(1)} Z`
    : "";

  // 가격 눈금 5개 — 우측에 붙인다 (트레이딩 화면 관례)
  $: ticks = plotH > 0
    ? Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4)
    : [];

  function fmtPx(n: number) {
    const d = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 10 ? 2 : 4;
    return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  $: lastX = pts.length ? X(pts.length - 1) : 0;
  $: lastY = pts.length ? Y(pts[pts.length - 1]) : 0;

  // 눈금 라벨이 보합선 라벨·현재가 태그와 세로로 겹치는지 (겹치면 눈금을 숨긴다)
  const GAP = 13;
  $: collides = (y: number) =>
    Math.abs(y - lastY) < GAP || (base !== null && Math.abs(y - Y(base)) < GAP);
  $: ready = pts.length > 1 && W > 0 && H > 0;
</script>

<div class="fc" bind:this={box}>
  {#if ready}
    <svg width={W} height={H} role="img" aria-label={`${data?.label ?? symbol} chart`}>
      <defs>
        <linearGradient id="fc-fill" x1="0" y1="0" x2="0" y2="1">
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

      <!-- 세로 격자 + 시간 눈금 -->
      {#each data?.marks ?? [] as m}
        {#if m.at > 0 && m.at < pts.length - 1}
          <line x1={X(m.at)} y1={PAD.t} x2={X(m.at)} y2={PAD.t + plotH}
                stroke="#1b2029" stroke-width="1" />
          <text x={X(m.at)} y={PAD.t + plotH + 16} class="ax mid">{m.label}</text>
        {/if}
      {/each}

      <path d={area} fill="url(#fc-fill)" />

      <!-- 보합선(전일 정산가): 곡선이 이 위면 오늘 상승 -->
      {#if base !== null}
        <line x1={PAD.l} y1={Y(base)} x2={PAD.l + plotW} y2={Y(base)}
              stroke="#7b8494" stroke-width="1" stroke-dasharray="5 5" opacity="0.85" />
        <text x={PAD.l + plotW + 8} y={Y(base) + 4} class="ax base">{fmtPx(base)}</text>
      {/if}

      <path d={line} fill="none" stroke={stroke} stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round" />

      <!-- 현재가 태그 -->
      <line x1={PAD.l} y1={lastY} x2={lastX} y2={lastY} stroke={stroke}
            stroke-width="1" stroke-dasharray="3 3" opacity="0.45" />
      <circle cx={lastX} cy={lastY} r="3.5" fill={stroke} />
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
  .ax { fill: #6b7280; font-size: 11px; font-weight: 700;
    font-variant-numeric: tabular-nums; }
  .ax.mid { text-anchor: middle; }
  .ax.base { fill: #98a1b0; }
  .ax.now { fill: #06121a; font-weight: 800; }
  .fc-msg { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
    color: #4b5563; font-size: 14px; font-weight: 700; }
</style>
