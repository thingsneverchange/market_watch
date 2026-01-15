<script lang="ts">
  export let level = 3; // 1~5
  const labels = ["LOW", "LOW+", "MID", "HIGH", "MAJOR"];
  $: L = Math.max(1, Math.min(5, level));
  $: label = labels[L - 1];
</script>

<div class="wrap" aria-label={`Impact ${L}/5`}>
  <div class="bars">
    {#each Array(5) as _, i}
      <div class:fill={i < L} class="bar"></div>
    {/each}
  </div>
  <div class="txt">{label}</div>
</div>

<style>
.wrap{display:flex;align-items:center;gap:10px}
.bars{display:flex;gap:6px}
.bar{
  width:18px;height:18px;border-radius:7px;
  background: rgba(255,255,255,.10);
  border:1px solid rgba(255,255,255,.12);
}
.fill{background: rgba(255,59,48,.95); border-color: rgba(255,59,48,.55);}
.txt{font-size:14px;font-weight:950;letter-spacing:.10em;opacity:.9}
</style>
