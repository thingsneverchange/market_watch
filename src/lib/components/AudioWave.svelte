<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  export let src: string | null = null; // 예: "/audio/lofi.mp3"
  export let height = 120;

  let canvas: HTMLCanvasElement;
  let audioEl: HTMLAudioElement;

  let ctx: CanvasRenderingContext2D | null = null;
  let raf = 0;

  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let dataArray: Uint8Array | null = null;
  let sourceNode: MediaElementAudioSourceNode | null = null;

  function draw() {
    if (!ctx || !analyser || !dataArray || !canvas) return;

    const w = canvas.width;
    const h = canvas.height;

    analyser.getByteTimeDomainData(dataArray);

    ctx.clearRect(0, 0, w, h);

    // 배경 글로우 느낌(너무 과하지 않게)
    ctx.globalAlpha = 1;

    // 파형
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();

    const sliceWidth = w / dataArray.length;
    let x = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] / 128.0; // 0~2
      const y = (v * h) / 2;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);

      x += sliceWidth;
    }
    ctx.stroke();

    // 중앙 라인(미니멀)
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    raf = requestAnimationFrame(draw);
  }

  function resizeCanvas() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(dpr, dpr);
  }

  async function initAudio() {
    if (!audioEl) return;

    // iOS/브라우저 정책 때문에 사용자 제스처 이후 resume 필요할 수 있음
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;

    dataArray = new Uint8Array(analyser.fftSize);

    sourceNode = audioCtx.createMediaElementSource(audioEl);
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    resizeCanvas();
    raf = requestAnimationFrame(draw);
  }

  async function ensureRunning() {
    if (audioCtx && audioCtx.state !== "running") {
      try { await audioCtx.resume(); } catch {}
    }
  }

  onMount(async () => {
    // 첫 클릭/키 입력 시 오디오 컨텍스트 resume 되도록
    const unlock = () => ensureRunning();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);

    await initAudio();

    const onResize = () => resizeCanvas();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  });

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    try { sourceNode?.disconnect(); } catch {}
    try { analyser?.disconnect(); } catch {}
    try { audioCtx?.close(); } catch {}
  });
</script>

<div class="waveCard">
  <div class="waveHead">
    <div class="waveTitle">Audio</div>
    <div class="waveHint">visual</div>
  </div>

  <div class="waveBody" style={`height:${height}px`}>
    <canvas bind:this={canvas} class="waveCanvas"></canvas>
  </div>

  <!-- 오디오 플레이어: 방송용이면 컨트롤 숨겨도 되는데, 테스트 편하게 일단 둠 -->
  <audio bind:this={audioEl} src={src ?? undefined} autoplay loop crossorigin="anonymous" />
</div>

<style>
  .waveCard{
    border-radius:22px;
    background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.10);
    overflow:hidden;
  }
  .waveHead{
    padding: 14px 16px 12px 16px;
    border-bottom: 1px solid rgba(255,255,255,.10);
    display:flex;
    justify-content:space-between;
    align-items:baseline;
  }
  .waveTitle{ font-size:18px; font-weight:900; letter-spacing:-0.02em; }
  .waveHint{ font-size:14px; font-weight:800; opacity:.75; }

  .waveBody{
    padding: 12px;
  }
  .waveCanvas{
    width:100%;
    height:100%;
    display:block;
  }

  audio{
    width: 100%;
    opacity: 0.12; /* 방송에서 안 거슬리게 */
    height: 24px;
  }
</style>
