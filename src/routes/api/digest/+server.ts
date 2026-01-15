import type { RequestHandler } from "./$types";
import { OPENAI_SECRET } from "$env/static/private";

const NYT_RSS = "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml";

const etTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit", minute: "2-digit", hour12: true
});

function toET(pubDate?: string) {
  if (!pubDate) return "NOW";
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return "NOW";
  return etTime.format(d).replace(" ", ""); // 02:00PM 형태
}

async function fetchNYT() {
  try {
    // User-Agent 추가 (차단 방지)
    const r = await fetch(NYT_RSS, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return [];
    const xml = await r.text();

    // 단순 무식하게 파싱 (XML 라이브러리 없이)
    const items = [];
    const blocks = xml.split("<item>").slice(1);
    for (const b of blocks) {
      const title = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ?? b.match(/<title>(.*?)<\/title>/)?.[1])?.trim();
      const link = b.match(/<link>(.*?)<\/link>/)?.[1]?.trim();
      const pubDate = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();

      // 제목이 너무 길면 자름
      if (title && link) {
        items.push({
          title: title.length > 60 ? title.slice(0, 60) + "..." : title,
          link,
          timeET: toET(pubDate)
        });
      }
      if (items.length >= 8) break;
    }
    return items;
  } catch (e) {
    console.error("RSS Error:", e);
    return [];
  }
}

export const GET: RequestHandler = async () => {
  // 1. 뉴스 원본 가져오기
  const items = await fetchNYT();

  // 기본 응답 (AI 실패 시 보여줄 데이터)
  const fallback = {
    driver: { text: "Monitoring global markets...", sentiment: "neutral" },
    news: items.map(x => ({ ...x, sentiment: "neu", level: 2 }))
  };

  // 2. OpenAI 키 없거나 뉴스 없으면 바로 원본 반환
  if (!OPENAI_SECRET || items.length === 0) {
    return new Response(JSON.stringify(fallback));
  }

  // 3. AI 요약 시도
  const system = `
    Summarize for a stock trading HUD.
    1. "driver": ONE short sentence (max 8 words) on why markets are moving.
       Sentiment: "bull" (green/good), "bear" (red/bad), or "neutral".
    2. "news": Rewrite titles to be max 5-6 words (impactful).
       Sentiment: "pos", "neg", "neu".
       Level: 1-5 (5=major).
    Input JSON index matching.
  `;

  // Schema for structured output
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
            idx: { type: "integer" }, // original index
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
        model: "gpt-4o-mini", // 모델명 확인
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(items.map((x,i)=>({i, t:x.title}))) }],
        response_format: { type: "json_schema", json_schema: { name: "market_digest", strict: true, schema } }
      })
    });

    if (!r.ok) throw new Error("OpenAI API Error");
    const j = await r.json();
    const parsed = JSON.parse(j.choices[0].message.content);

    // AI 결과를 원본 데이터와 병합
    const finalNews = parsed.news.map((n: any) => ({
      ...items[n.idx], // 시간, 링크 유지
      title: n.title,
      sentiment: n.sentiment,
      level: n.level
    }));

    return new Response(JSON.stringify({ driver: parsed.driver, news: finalNews }));

  } catch (e) {
    console.error("AI Error:", e);
    // AI 에러나면 그냥 원본 내보냄 (Market Unavailable 안 뜨게)
    return new Response(JSON.stringify(fallback));
  }
};
