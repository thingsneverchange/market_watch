// ============================================================
//  RSS 파싱 — 순수 함수. 의존성이 없어 테스트에서 그대로 불러 쓴다.
//
//  왜 따로 뺐나: 매체마다 XML 이 미묘하게 다르고(CDATA 유무, <source> 유무,
//  제목에 매체명 접미사), 파싱이 어긋나면 **조용히 0건**이 된다. 화면은 그냥
//  "뉴스가 없네"로 보여서 사고를 알아채는 데 오래 걸린다.
//  실제 피드 XML 을 고정 자료로 놓고 테스트한다.
// ============================================================

export type RawItem = {
  title: string;
  source: string;
  url: string;
  epoch: number; // 초
};

/** <tag>값</tag> 또는 <tag><![CDATA[값]]></tag> */
export function tagText(xml: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, "i").exec(xml);
  return m ? m[1].trim() : "";
}

function decodeOnce(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");   // 반드시 마지막 — 그래야 다음 패스가 &#39; 를 볼 수 있다
}

/**
 * HTML 엔티티 복원 + 태그 제거 — 방송 자막에 &#39; 가 그대로 나가면 안 된다.
 *
 * ★ 두 번 돌린다. 실제 피드에 **이중 이스케이프**(`&amp;#39;`)가 흔하다.
 *   한 번만 풀면 `&#39;` 가 화면에 그대로 찍힌다.
 *   상한을 2로 둔 이유: 무한 반복하면 "&amp; 기호에 관한 기사" 같은 정상 제목까지
 *   계속 벗겨진다. 실무에서 이중까지가 전부다.
 */
export function unescapeXml(s: string): string {
  let out = String(s || "").replace(/<[^>]+>/g, "");
  for (let i = 0; i < 2; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * RSS 2.0 <item> 목록을 뽑는다.
 *
 * @param feedName <source> 가 없는 피드(CNBC·MarketWatch)에서 쓸 매체명
 * @returns 발행시각을 아는 항목만. 시각을 모르면 버린다 — 나이를 못 밝히면 방송하지 않는다.
 */
export function parseRss(xml: string, feedName: string): RawItem[] {
  const out: RawItem[] = [];
  const chunks = String(xml || "").split(/<item[\s>]/i).slice(1);

  for (const raw of chunks) {
    const end = raw.search(/<\/item>/i);
    const block = end >= 0 ? raw.slice(0, end) : raw;

    const when = Date.parse(tagText(block, "pubDate"));
    if (!Number.isFinite(when)) continue;

    let title = unescapeXml(tagText(block, "title"));
    if (!title) continue;

    // 구글 뉴스: <source url="…">CNBC</source> 로 원 매체를 주고 제목 끝에 " - CNBC" 를 붙인다.
    // 매체명을 뽑고 제목에서는 지운다 (자막에 "… - The Times" 가 붙어 나가지 않게).
    const srcTag = /<source[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/i.exec(block);
    let source = srcTag ? unescapeXml(srcTag[1]) : "";
    if (source) {
      const esc = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      title = title.replace(new RegExp(`\\s+[-–—]\\s+${esc}\\s*$`, "i"), "").trim();
    } else {
      source = feedName;
    }
    if (!title) continue;

    const url = unescapeXml(tagText(block, "link")) || unescapeXml(tagText(block, "guid"));
    if (!url) continue;

    out.push({ title, source, url, epoch: Math.floor(when / 1000) });
  }
  return out;
}
