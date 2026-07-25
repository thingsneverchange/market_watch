<script lang="ts">
  import { onMount } from "svelte";
  import ImpactBar from "$lib/components/ImpactBar.svelte";

  export let headline = "";
  export let level = 4;
  /** 45분 초과 기사 = UPDATE. 무음 + 회색 배지 */
  export let silent = false;
  export let ageSec = 0;

  export let soundSrc = "/sfx/breaking.mp3";
  export let soundVolume = 0.16;

  // ※ 수명(visible / durationMs / 자체 setTimeout)을 여기서 관리하지 않는다.
  //   부모(+page.svelte)가 유일한 소유자다. 예전에는 부모 12초 · 자식 28초가 공존했고,
  //   자식 타이머는 도달 불가 죽은 코드였다가 부모 로직이 바뀌는 순간
  //   "28초 뒤 토스트가 영구히 사라지는" 버그로 바뀔 폭탄이었다.

  function ageLabel(s: number): string {
    if (!s || s < 60) return "";
    const m = s / 60;
    if (m < 60) return `${Math.round(m)}분 전`;
    return `${Math.round(m / 60)}시간 전`;
  }

  onMount(() => {
    if (soundSrc && !silent) {
      const sfx = new Audio(soundSrc);
      sfx.volume = soundVolume;
      // autoplay 정책에 막히면 조용히 무음이 된다 — 최소한 로그는 남긴다.
      sfx.play().catch((e) => console.warn("[BreakingToast] 사운드 재생 차단됨:", e?.name ?? e));
    }
  });
</script>

<div class="toast" class:upd={silent}>
  <div class="bar"></div>
  <div class="row">
    <div class="badge">{silent ? "소식" : "속보"}</div>
    <div class="msg">{headline}</div>
    <div class="imp">
      {#if ageLabel(ageSec)}<span class="age">{ageLabel(ageSec)}</span>{/if}
      <ImpactBar level={level} />
    </div>
  </div>
</div>

<style>
.toast{
  position:absolute;
  left:50%;
  bottom: 118px; /* tape 위 */
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
.toast.upd .bar{background: linear-gradient(90deg,#f5a623,#f5c518);}
.row{
  display:grid;
  /* auto 로 두면 HIGH/MAJOR 글자수에 따라 메시지 폭이 흔들린다 → 고정폭 */
  grid-template-columns: 130px 1fr 190px;
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
.toast.upd .badge{background: rgba(245,166,35,.95); color:#1a1206;}
/* ※ 예전에는 white-space:nowrap + ellipsis 라 실제 헤드라인이 42~48자에서 잘려
   방송 자막이 문장 중간에 끊겼다. 2줄까지 허용한다. */
.msg{
  font-size:22px; font-weight:950; letter-spacing:-.02em; line-height:1.15;
  overflow:hidden;
  display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical;
}
.imp{display:flex;align-items:center;justify-content:flex-end;gap:10px}
.age{font-size:12px;font-weight:800;color:#9aa3ad;white-space:nowrap}
@keyframes rise{
  from{ transform: translate(-50%, 14px); opacity:0; }
  to{ transform: translate(-50%, 0px); opacity:1; }
}
</style>
