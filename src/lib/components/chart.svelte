<script lang="ts">
  import { onMount } from "svelte";

  export let symbol = "NASDAQ:AAPL";
  export let interval = "15";
  export let theme: "light" | "dark" = "dark";
  export let height = 360; // ✅ 카드 높이 고정 핵심

  let host: HTMLDivElement;

  function mountWidget() {
    if (!host) return;
    host.innerHTML = "";

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;

    // ✅ autosize 끄고 height/width 지정하면 blank/깨짐이 훨씬 줄어듦
    script.innerHTML = JSON.stringify({
      width: "100%",
      height,
      symbol,
      interval,
      timezone: "America/New_York", // 차트 타임존도 EST로 맞춤(원하면 유지/변경 가능)
      theme,
      style: "1",
      locale: "en",
      allow_symbol_change: false,
      save_image: false,

      // 방송용 미니멀
      hide_top_toolbar: true,
      hide_side_toolbar: true,
      details: false,
      calendar: false,
      studies: []
    });

    host.appendChild(script);
  }

  onMount(mountWidget);

  // 심볼/인터벌 바뀔 때 다시 마운트
  $: symbol, interval, height, theme, mountWidget();
</script>

<div class="tvWrap" style={`height:${height}px`}>
  <div bind:this={host} class="tvHost"></div>
</div>

<style>
  .tvWrap { width: 100%; }
  .tvHost { width: 100%; height: 100%; }
  .tvHost :global(iframe) { width: 100% !important; height: 100% !important; }
</style>
