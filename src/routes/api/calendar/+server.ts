import type { RequestHandler } from "./$types";
import { FINNHUB_API_KEY } from "$env/static/private";

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit", minute: "2-digit", hour12: true
});

function toET(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return etFmt.format(d);
}

export const GET: RequestHandler = async () => {
  // 더미 데이터 (API 키 없거나 실패 시 보여줄 데이터)
  const dummy = {
    title: "FOMC Meeting Minutes",
    timeET: "02:00 PM",
    importance: 5,
    sentiment: "High Volatility Expected"
  };

  if (!FINNHUB_API_KEY) {
    return new Response(JSON.stringify({ next: dummy }), { headers: { "content-type": "application/json" }});
  }

  try {
    const now = new Date();
    const to = new Date(now.getTime() + 3 * 24 * 3600 * 1000); // 3일치
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${now.toISOString().slice(0,10)}&to=${to.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`;

    const r = await fetch(url);
    const j = await r.json();
    const list = j.economicCalendar ?? [];

    // 현재 이후 가장 중요한 이벤트 찾기
    const future = list
      .filter((e: any) => new Date(e.time || e.datetime).getTime() > Date.now())
      .sort((a: any, b: any) => (b.importance ?? 0) - (a.importance ?? 0)); // 중요도 순

    const next = future[0] ? {
      title: future[0].event,
      timeET: toET(future[0].time || future[0].datetime),
      importance: future[0].importance,
      sentiment: "Macro Event"
    } : dummy;

    return new Response(JSON.stringify({ next }), { headers: { "content-type": "application/json" }});
  } catch {
    return new Response(JSON.stringify({ next: dummy }), { headers: { "content-type": "application/json" }});
  }
};
