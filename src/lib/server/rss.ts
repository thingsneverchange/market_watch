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
  /** 원 매체의 호스트명. 구글 뉴스는 <source url="…"> 로 준다. 없으면 "" */
  sourceHost: string;
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
    // ★ 미래 시각을 버린다. 상한이 없으면 **조작된 타임스탬프가 순위를 무제한으로 산다.**
    //   digest 의 점수는 `등급 + 가점 − 나이/6시간` 인데, 나이가 음수면 감점이 가점이 되어
    //   어떤 진짜 기사도 이길 수 없다. 와이어 5개 중 2개가 구글 뉴스 **검색** 질의라
    //   아무 사이트나 들어올 수 있으므로 실제로 도달 가능한 경로다.
    //   2분은 발행 서버와 우리 서버의 시계 오차 여유다.
    if (when > Date.now() + 120_000) continue;

    let title = unescapeXml(tagText(block, "title"));
    if (!title) continue;

    // 구글 뉴스: <source url="…">CNBC</source> 로 원 매체를 주고 제목 끝에 " - CNBC" 를 붙인다.
    // 매체명을 뽑고 제목에서는 지운다 (자막에 "… - The Times" 가 붙어 나가지 않게).
    // ★ url 속성까지 캡처한다. 예전엔 `[^>]*` 로 버렸는데, **표시명은 공격자가 정한다.**
    //   "CNBC Markets Daily" 라고 이름 붙이면 매체 가점을 그냥 가져간다.
    //   도메인은 등록해야 하므로 훨씬 위조하기 어렵다.
    const srcTag = /<source([^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/i.exec(block);
    let sourceHost = "";
    if (srcTag) {
      const u = /\burl\s*=\s*["']([^"']+)["']/i.exec(srcTag[1]);
      if (u) { try { sourceHost = new URL(u[1]).hostname.replace(/^www\./i, "").toLowerCase(); } catch { /* 무시 */ } }
    }
    let source = srcTag ? unescapeXml(srcTag[2]) : "";
    if (source) {
      const esc = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      title = title.replace(new RegExp(`\\s+[-–—]\\s+${esc}\\s*$`, "i"), "").trim();
    } else {
      source = feedName;
    }
    if (!title) continue;

    const url = unescapeXml(tagText(block, "link")) || unescapeXml(tagText(block, "guid"));
    if (!url) continue;

    out.push({ title, source, sourceHost, url, epoch: Math.floor(when / 1000) });
  }
  return out;
}
