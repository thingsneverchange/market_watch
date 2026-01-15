<script lang="ts">
  import { onMount } from "svelte";
  import ImpactBar from "$lib/components/ImpactBar.svelte";

  export let headline = "";
  export let level = 4;
  export let durationMs = 28000;

  export let soundSrc = "/sfx/breaking.mp3";
  export let soundVolume = 0.16;

  let visible = true;

  onMount(() => {
    if (soundSrc) {
      const sfx = new Audio(soundSrc);
      sfx.volume = soundVolume;
      sfx.play().catch(() => {});
    }
    const t = setTimeout(() => (visible = false), durationMs);
    return () => clearTimeout(t);
  });
</script>

{#if visible}
  <div class="toast">
    <div class="bar"></div>
    <div class="row">
      <div class="badge">BREAKING</div>
      <div class="msg">{headline}</div>
      <div class="imp"><ImpactBar level={level}/></div>
    </div>
  </div>
{/if}

<style>
.toast{
  position:absolute;
  left:50%;
  bottom: 118px; /* tapes 위 */
  transform: translateX(-50%);
  width: min(980px, calc(100% - 44px));
  z-index: 999;
  background: rgba(15,17,21,.92);
  border:1px solid rgba(255,255,255,.14);
  border-radius: 20px;
  box-shadow: 0 30px 120px rgba(0,0,0,.65);
  overflow:hidden;
  animation: rise .28s cubic-bezier(.2,.8,.2,1);
}
.bar{height:6px;background: linear-gradient(90deg,#ff3b30,#ff6b6b);}
.row{
  display:grid;
  grid-template-columns: 150px 1fr 220px;
  gap:14px;
  align-items:center;
  padding: 14px 16px;
}
.badge{
  font-size:14px;font-weight:950;letter-spacing:.14em;
  padding:10px 12px;border-radius:999px;
  background: rgba(255,59,48,.95); color:#fff;
  text-align:center;
}
.msg{
  font-size:22px; font-weight:950; letter-spacing:-.02em; line-height:1.15;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.imp{display:flex;justify-content:flex-end}
@keyframes rise{
  from{ transform: translate(-50%, 14px); opacity:0; }
  to{ transform: translate(-50%, 0px); opacity:1; }
}
</style>
