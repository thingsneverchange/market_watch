import type { RequestHandler } from "./$types";
import { OPENAI_SECRET } from "$env/static/private";

const NYT_RSS = "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml";

async function fetchRSS() {
  try {
    const r = await fetch(NYT_RSS);
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const blocks = xml.split("<item>").slice(1);
    for (const b of blocks) {
      const title = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ?? b.match(/<title>(.*?)<\/title>/)?.[1])?.trim();
      const pub = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1];

      let timeET = "NOW";
      if (pub) {
        const d = new Date(pub);
        if (!Number.isNaN(d.getTime())) {
          timeET = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true
          }).format(d);
        }
      }
      if (title) items.push({ title, timeET });
      if (items.length >= 15) break; // 필터링을 위해 넉넉히 가져옴
    }
    return items;
  } catch { return []; }
}

export const GET: RequestHandler = async () => {
  const items = await fetchRSS();

  if (!OPENAI_SECRET || items.length === 0) {
    // API 키 없을 때의 폴백 (어쩔 수 없음)
    return new Response(JSON.stringify({
      driver: { text: "API Key Required for AI Analysis", sentiment: "neutral" },
      news: items.slice(0,5).map(x=>({...x, sentiment:"neu", level:3}))
    }));
  }

  // 프롬프트 대폭 수정: 필터링 및 구체성 강화
  const system = `
    You are a professional financial news editor.

    Task 1: Market Driver
    - Write ONE specific sentence (max 10 words) explaining EXACTLY why the market is moving.
    - BAD: "Mixed market mood with concerns."
    - GOOD: "Tech stocks rally driven by strong NVIDIA earnings." or "CPI inflation data sparks sell-off in bonds."
    - Sentiment: "bull", "bear", "neutral".

    Task 2: News List
    - Select exactly 5 MOST IMPORTANT items from the list.
    - **CRITICAL**: IGNORE items with low impact. Only pick Medium to High impact news.
    - **ORDER**: Put the highest impact news (Level 5) at the top.
    - Rewrite titles to be short (max 6 words).
    - Sentiment: "pos", "neg", "neu".
    - Level: 3 (Medium), 4 (High), 5 (Major). DO NOT return Level 1 or 2.

    Output JSON format only.
  `;

  const schema = {
    type: "object",
    properties: {
      driver: {
        type: "object",
        properties: { text: { type: "string" }, sentiment: { type: "string" } },
        required: ["text", "sentiment"]
      },
      news: {
        type: "array",
        items: {
          type: "object",
          properties: {
            idx: { type: "integer" },
            title: { type: "string" },
            sentiment: { type: "string" },
            level: { type: "integer" }
          },
          required: ["idx", "title", "sentiment", "level"]
        }
      }
    },
    required: ["driver", "news"]
  };

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o", // 성능 좋은 모델 사용 권장
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(items.map((x,i)=>({i, t:x.title}))) }],
        response_format: { type: "json_schema", json_schema: { name: "digest", strict: true, schema } }
      })
    });

    if(!r.ok) throw new Error("OpenAI API Fail");

    const j = await r.json();
    const parsed = JSON.parse(j.choices[0].message.content);

    // 인덱스 매핑
    const finalNews = parsed.news.map((n:any) => ({
      ...items[n.idx],
      title: n.title,
      sentiment: n.sentiment,
      level: n.level
    }));

    return new Response(JSON.stringify({ driver: parsed.driver, news: finalNews }));

  } catch (e) {
    // 에러 발생 시 원본 반환하되 "AI Error" 표시
    return new Response(JSON.stringify({
      driver: { text: "AI Service Unavailable", sentiment: "neutral" },
      news: items.slice(0,5).map(x=>({...x, sentiment:"neu", level:3}))
    }));
  }
};
