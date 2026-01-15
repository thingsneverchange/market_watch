import type { RequestHandler } from "./$types";
import { FINNHUB_API_KEY } from "$env/static/private";

// Helper: ET display
const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true
});

function toET(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return etFmt.format(d).replace(" ", "");
}

// NOTE:
// Finnhub economic calendar endpoints can vary by plan.
// We'll try a best-effort approach and gracefully fallback.
async function tryFinnhubNextEvent() {
  if (!FINNHUB_API_KEY) return null;

  // A conservative "next 7 days" range
  const now = new Date();
  const to = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

  const fromStr = now.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  // Common endpoint pattern (may 403 depending on plan)
  const url = `https://finnhub.io/api/v1/calendar/economic?from=${fromStr}&to=${toStr}&token=${FINNHUB_API_KEY}`;

  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return { error: `finnhub_${r.status}` };

  const j = await r.json();

  // Finnhub returns: { economicCalendar: [...] } (often)
  const list = (j.economicCalendar ?? j.economic ?? j.data ?? []) as any[];
  if (!Array.isArray(list) || list.length === 0) return null;

  // Find next future event
  const nowMs = Date.now();
  const future = list
    .map((e) => {
      // different shapes exist: date/time may be in "time" or "datetime" or "date"
      const iso =
        e.datetime ??
        e.time ??
        (e.date && e.hour ? `${e.date}T${String(e.hour).padStart(2, "0")}:00:00Z` : null) ??
        (e.date ? `${e.date}T13:30:00Z` : null); // fallback guess

      if (!iso) return null;

      const ms = new Date(iso).getTime();
      return {
        iso,
        ms,
        title: e.event ?? e.name ?? e.indicator ?? "Macro event",
        importance: Number(e.importance ?? e.impact ?? 3)
      };
    })
    .filter(Boolean)
    .filter((x: any) => x.ms > nowMs)
    .sort((a: any, b: any) => a.ms - b.ms);

  if (!future.length) return null;

  const n = future[0];
  return {
    title: String(n.title).slice(0, 60),
    iso: n.iso,
    timeET: toET(n.iso),
    importance: Math.min(5, Math.max(1, n.importance)),
    sentimentHint: "" // optional: you can fill later via digest if you want
  };
}

export const GET: RequestHandler = async () => {
  const next = await tryFinnhubNextEvent();

  if (next && !(next as any).error) {
    return new Response(JSON.stringify({ status: "ok", next }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }

  // If finnhub fails, we don’t break overlay.
  const status =
    (next as any)?.error === "finnhub_403"
      ? "Macro calendar unavailable (403)"
      : "Macro calendar unavailable";

  return new Response(JSON.stringify({ status, next: null }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
