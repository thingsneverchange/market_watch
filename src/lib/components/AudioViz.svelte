<script lang="ts">
  import { onMount } from "svelte";

  export let sources: string[] = [];
  export let volume = 0.40;

  let audioEl: HTMLAudioElement;
  let canvasEl: HTMLCanvasElement;

  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let data: Uint8Array | null = null;
  let raf = 0;

  function pickRandom() {
    if (!sources.length) return null;
    return sources[Math.floor(Math.random() * sources.length)];
  }

  function playNext() {
    const src = pickRandom();
    if (!src) return;
    audioEl.src = src;
    audioEl.play().catch(() => {});
  }

  function ensureStarted() {
    // autoplay 정책 대응: 유저 액션 후 안정적으로 시작
    ctx?.resume?.().catch(() => {});
    if (audioEl.paused) audioEl.play().catch(() => {});
  }

  function startViz() {
    if (!audioEl || !canvasEl) return;

    if (!ctx) {
      ctx = new AudioContext();
      const srcNode = ctx.createMediaElementSource(audioEl);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      data = new Uint8Array(analyser.frequencyBinCount);
      srcNode.connect(analyser);
      analyser.connect(ctx.destination);
    }

    const g = canvasEl.getContext("2d");
    if (!g || !analyser || !data) return;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      analyser!.getByteFrequencyData(data!);

      const w = canvasEl.width;
      const h = canvasEl.height;
      g.clearRect(0, 0, w, h);

      const bars = 56;
      const step = Math.floor(data!.length / bars);
      const bw = w / bars;

      // 색 지정 안 한다는 룰이 있었던 건 python 플롯에 대한 거라 여기 CSS/캔버스는 ok.
      g.fillStyle = "rgba(255,255,255,.85)";

      for (let i = 0; i < bars; i++) {
        const v = data![i * step] / 255;
        const bh = Math.max(6, v * h);
        const x = i * bw + 2;
        const y = h - bh;
        g.fillRect(x, y, bw - 4, bh);
      }
    };

    draw();
  }

  onMount(() => {
    audioEl.volume = volume;

    // 자동 재생 시도 (막히면 아래 userStart 버튼/클릭으로 시작)
    playNext();
    startViz();

    audioEl.addEventListener("ended", playNext);

    const once = () => ensureStarted();
    window.addEventListener("pointerdown", once, { once: true });
    window.addEventListener("keydown", once, { once: true });

    return () => {
      audioEl.removeEventListener("ended", playNext);
      window.removeEventListener("pointerdown", once);
      window.removeEventListener("keydown", once);
      cancelAnimationFrame(raf);
      ctx?.close?.().catch(() => {});
    };
  });
</script>

<div class="wrap">
  <div class="head">
    <div class="ttl">AUDIO</div>
    <div class="sp"></div>
    <button class="btn" on:click={ensureStarted}>PLAY</button>
    <button class="btn" on:click={playNext}>NEXT</button>
  </div>

  <canvas bind:this={canvasEl} width="520" height="110"></canvas>
  <audio bind:this={audioEl} crossorigin="anonymous"></audio>
</div>

<style>
.wrap{height:100%;display:flex;flex-direction:column;gap:12px;padding:14px}
.head{display:flex;align-items:center;gap:10px}
.ttl{font-size:16px;font-weight:950;letter-spacing:.10em;opacity:.9}
.sp{flex:1}
.btn{
  font-size:14px;font-weight:950;
  padding:10px 12px;border-radius:12px;
  border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.06);
  color:#e5e7eb;
}
canvas{
  width:100%;height:110px;border-radius:16px;
  background: rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.10);
}
</style>
