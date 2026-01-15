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

  function pick() {
    if (!sources?.length) return null;
    return sources[Math.floor(Math.random() * sources.length)];
  }

  function playNext() {
    const src = pick();
    if (!src) return;
    audioEl.src = src;
    audioEl.volume = Math.max(0, Math.min(1, volume));
    audioEl.play().catch(() => {});
  }

  function ensureGraph() {
    if (ctx) return;
    ctx = new AudioContext();
    const srcNode = ctx.createMediaElementSource(audioEl);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    data = new Uint8Array(analyser.frequencyBinCount);
    srcNode.connect(analyser);
    analyser.connect(ctx.destination);
  }

  function draw() {
    if (!canvasEl || !analyser || !data) return;
    const g = canvasEl.getContext("2d");
    if (!g) return;

    const w = canvasEl.width;
    const h = canvasEl.height;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      analyser!.getByteFrequencyData(data!);

      g.clearRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,.85)";

      const bars = 36;
      const step = Math.floor(data!.length / bars);
      const bw = w / bars;

      for (let i = 0; i < bars; i++) {
        const v = data![i * step] / 255;
        const bh = Math.max(2, v * h);
        g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      }
    };
    loop();
  }

  onMount(() => {
    // Start muted-ish visual even before audio is unlocked
    // (We only need AudioContext after interaction)
    const unlock = () => {
      try {
        ensureGraph();
        ctx?.resume?.().catch(() => {});
        draw();
        if (!audioEl.src) playNext();
        else audioEl.play().catch(() => {});
      } catch {}
    };

    audioEl.volume = Math.max(0, Math.min(1, volume));

    audioEl.addEventListener("ended", playNext);

    // Autoplay policies: unlock on first interaction
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    // If sources already exist, preload first track (but don’t force play)
    const first = pick();
    if (first) audioEl.src = first;

    return () => {
      audioEl.removeEventListener("ended", playNext);
      cancelAnimationFrame(raf);
      ctx?.close?.().catch(() => {});
    };
  });
</script>

<div class="wrap" title="Click once to enable audio">
  <canvas bind:this={canvasEl} width="260" height="26"></canvas>
  <audio bind:this={audioEl} crossorigin="anonymous"></audio>
</div>

<style>
  .wrap{
    display:flex;align-items:center;justify-content:center;
    width:260px;height:26px;
    border-radius:999px;
    background:rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.10);
    overflow:hidden;
  }
  canvas{width:260px;height:26px}
</style>
