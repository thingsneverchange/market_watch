import type { RequestHandler } from "./$types";
import { OPENAI_SECRET } from "$env/static/private";

const NYT_RSS = "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml";

// [핵심] 더 똑똑해진 키워드 분석기
function heuristicAnalysis(title: string) {
    const t = title.toLowerCase();
    let level = 3; // 기본 MID
    let sentiment = "neu";

    // Level 5 (MAJOR) 키워드
    if (t.match(/fed|fomc|rate|cpi|inflation|war|crisis|panic|tariff|sanction|ban|trump|biden|earnings/)) level = 5;
    else if (t.match(/soar|plunge|surge|record|hike|cut|break/)) level = 4;

    // 감성 분석 (색상 결정)
    if (t.match(/up|rise|gain|bull|profit|settle|jump|record|beat|rally/)) sentiment = "pos";
    else if (t.match(/down|fall|drop|loss|bear|worry|crash|sue|fine|tariff|ban|sanction|warn|miss/)) sentiment = "neg";

    return { level, sentiment };
}

async function fetchRSS() {
  try {
    const r = await fetch(NYT_RSS);
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const blocks = xml.split("<item>").slice(1);

    for (const b of blocks) {
      // CDATA 파싱 강화
      const titleRaw = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ?? b.match(/<title>(.*?)<\/title>/)?.[1])?.trim();

      // HTML 태그 제거 및 디코딩 등 간단 정제
      const title = titleRaw?.replace(/&quot;/g, '"')?.replace(/&amp;/g, '&');

      const pub = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1];
      let timeET = "NOW";

      if (pub) {
         const d = new Date(pub);
         if(!Number.isNaN(d.getTime())){
             timeET = new Intl.DateTimeFormat("en-US", {
                timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true
              }).format(d);
         }
      }

      if (title) items.push({ title, timeET });
      if (items.length >= 15) break;
    }
    return items;
  } catch { return []; }
}

export const GET: RequestHandler = async () => {
  const items = await fetchRSS();

  // 1. Driver Text: 최신 뉴스 그대로 사용 (글자수 제한 해제)
  // 너무 길면 UI에서 CSS로 ... 처리하는 게 낫습니다.
  let driverText = "Market awaits key catalysts.";
  let driverSent = "neutral";

  if (items.length > 0) {
      const top = items[0];
      const ana = heuristicAnalysis(top.title);
      // "Focus on: " 같은 접두어 제거하여 깔끔하게
      driverText = top.title;
      driverSent = ana.sentiment;
  }

  // 2. News List 분석
  const analyzedNews = items.slice(0, 5).map((x, i) => {
      const h = heuristicAnalysis(x.title);
      return {
          ...x,
          idx: i,
          sentiment: h.sentiment,
          level: h.level
      };
  });

  // 중요도 순 정렬
  analyzedNews.sort((a,b) => b.level - a.level);

  return new Response(JSON.stringify({
      driver: { text: driverText, sentiment: driverSent },
      news: analyzedNews
  }));
};
