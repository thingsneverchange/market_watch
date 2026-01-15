import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
    const now = new Date();

    // [안전장치] 무조건 현재로부터 일정 시간 뒤로 설정 (과거 날짜 방지)
    // 예: 4시간 30분 뒤 ~ 2일 뒤 사이 랜덤
    const randomHours = 4 + Math.random() * 48;
    const futureDate = new Date(now.getTime() + (randomHours * 60 * 60 * 1000));

    // 이벤트 목록 (랜덤 선택하여 계속 바뀌는 느낌 부여)
    const EVENTS = [
        { t: "FOMC RATE DECISION", imp: 5 },
        { t: "CPI DATA RELEASE", imp: 5 },
        { t: "NVIDIA EARNINGS CALL", imp: 5 },
        { t: "JOBS REPORT (NFP)", imp: 4 },
        { t: "TESLA PRODUCT EVENT", imp: 4 }
    ];

    const pick = EVENTS[Math.floor(Math.random() * EVENTS.length)];

    return new Response(JSON.stringify({
        next: {
            title: pick.t,
            time: futureDate.toISOString(), // 항상 미래 시간
            imp: pick.imp
        }
    }));
};
