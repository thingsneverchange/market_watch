<script lang="ts">
  // 자체 스파크라인 — TradingView 임베드를 쓰지 않는다.
  //
  //  왜: 무료 임베드는 **선물(NQ1!)·지수 원본을 렌더하지 못한다**(실측). 24시간 스트림에서
  //      정작 중요한 나스닥 선물 움직임을 못 그린다는 뜻이다.
  //      Finviz 가 심볼마다 300포인트 추이를 주므로 SVG 로 직접 그리면 제약이 사라진다.
  //      부수 효과: iframe 3개가 사라져 메모리·CPU 도 크게 준다 (24시간 방송에 중요).
  export let points: number[] = [];
  export let up = true;          // 상승/하락 → 색
  export let height = 90;

  const W = 300;                 // viewBox 기준 폭 (실제 크기는 CSS 가 결정)

  // 소수점 급등락도 보이도록 min/max 로 정규화한다 (0 기준으로 그리면 선이 평평해진다)
  $: pts = points.filter((n) => Number.isFinite(n));
  $: min = pts.length ? Math.min(...pts) : 0;
  $: max = pts.length ? Math.max(...pts) : 1;
  $: span = max - min || 1;
  $: coords = pts.map((v, i) => {
    const x = pts.length > 1 ? (i / (pts.length - 1)) * W : 0;
    const y = height - ((v - min) / span) * height;
    return [x, y] as const;
  });
  $: line = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  // 면적 채우기 — 선만 있으면 방송 화면에서 얇아 잘 안 보인다
  $: area = coords.length
    ? `${line} L${W},${height} L0,${height} Z`
    : "";
  $: stroke = up ? "#39d98a" : "#ff5c5c";
  $: fillId = up ? "spark-up" : "spark-dn";
</script>

{#if coords.length > 1}
  <svg class="spark" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color={stroke} stop-opacity="0.28" />
        <stop offset="100%" stop-color={stroke} stop-opacity="0" />
      </linearGradient>
    </defs>
    <path d={area} fill={`url(#${fillId})`} />
    <path d={line} fill="none" stroke={stroke} stroke-width="1.8"
          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    <!-- 마지막 점 강조 — "지금 어디인지"가 한눈에 -->
    <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]}
            r="2.5" fill={stroke} vector-effect="non-scaling-stroke" />
  </svg>
{:else}
  <div class="spark-empty">—</div>
{/if}

<style>
  .spark { width: 100%; height: 100%; display: block; }
  .spark-empty { width: 100%; height: 100%; display: flex; align-items: center;
    justify-content: center; color: #4b5563; font-weight: 700; font-size: 13px; }
</style>
