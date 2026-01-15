import type { RequestHandler } from "./$types";
import { FINNHUB_API_KEY } from "$env/static/private";

export const GET: RequestHandler = async () => {
    const now = new Date();

    // 백업: 무조건 3일 4시간 뒤에 이벤트가 있는 것으로 설정
    const backupDate = new Date(now.getTime() + (3 * 24 * 60 * 60 * 1000) + (4 * 60 * 60 * 1000));
    const MOCK_EVENT = {
        title: "FOMC Rate Decision",
        time: backupDate.toISOString(), // ISO String으로 전달
        imp: 5
    };

    if (!FINNHUB_API_KEY) {
        return new Response(JSON.stringify({ next: MOCK_EVENT }));
    }

    try {
        const to = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
        const url = `https://finnhub.io/api/v1/calendar/economic?from=${now.toISOString().slice(0,10)}&to=${to.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`;

        const r = await fetch(url);
        if (!r.ok) throw new Error();
        const j = await r.json();
        const list = j.economicCalendar;

        if (!list || list.length === 0) throw new Error();

        // 중요도 높고 + 미래인 것 찾기
        const future = list
            .filter((e:any) => e.importance >= 4 && new Date(e.time).getTime() > now.getTime())
            .sort((a:any,b:any) => new Date(a.time).getTime() - new Date(b.time).getTime());

        if (future.length === 0) throw new Error();

        return new Response(JSON.stringify({
            next: {
                title: future[0].event,
                time: future[0].time, // "2024-01-20 14:00:00"
                imp: future[0].importance
            }
        }));

    } catch {
        return new Response(JSON.stringify({ next: MOCK_EVENT }));
    }
};
