// 이슈 레이더 v2 — 0단계: 신호원 스냅샷 수집(읽기 전용, 글 작성·발행 없음)
// 사용: node collect.mjs        → data/snap-YYYY-MM-DD.jsonl 에 한 줄 추가
import { appendFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const get = async (url, enc = 'utf-8') => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status}`);
  return new TextDecoder(enc).decode(await r.arrayBuffer());
};
const un = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const tag = (b, t) => un(b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] || '');
const items = (xml) => xml.match(/<item>[\s\S]*?<\/item>/g) || [];

const rss = (url, n = 40) => async () =>
  items(await get(url)).slice(0, n).map((b) => ({ title: tag(b, 'title'), link: tag(b, 'link'), at: tag(b, 'pubDate') }));

const SOURCES = {
  // 공급: 무슨 일이 터졌나
  yna_society: rss('https://www.yna.co.kr/rss/society.xml'),
  yna_entertain: rss('https://www.yna.co.kr/rss/entertainment.xml'),
  yna_all: rss('https://www.yna.co.kr/rss/news.xml', 60),
  gnews_top: rss('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko', 40),
  gnews_nation: rss('https://news.google.com/rss/headlines/section/topic/NATION?hl=ko&gl=KR&ceid=KR:ko', 40),
  gnews_entertain: rss('https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=ko&gl=KR&ceid=KR:ko', 40),
  // 수요: 사람들이 찾는가
  gtrends: async () =>
    items(await get('https://trends.google.com/trending/rss?geo=KR')).map((b) => ({
      title: tag(b, 'title'), traffic: tag(b, 'ht:approx_traffic'), at: tag(b, 'pubDate'),
      news: (b.match(/<ht:news_item_title>[\s\S]*?<\/ht:news_item_title>/g) || []).map((x) => un(x)).slice(0, 3),
    })),
  daum_trend: async () => {
    const h = await get('https://www.daum.net/');
    const i = h.indexOf('"keywords":[{"keyword"');
    if (i < 0) throw new Error('no daum keywords');
    const arr = [...h.slice(i, i + 20000).matchAll(/"keyword":"([^"]+)","rank":(\d+)/g)].map((m) => ({ title: m[1], rank: +m[2] }));
    return arr;
  },
  nate_issue: async () => {
    const h = await get('https://www.nate.com/');
    const i = h.indexOf('olLiveIssueKeyword');
    return [...h.slice(i, i + 12000).matchAll(/class="num_rank">(\d+)<\/span>[\s\S]*?class="txt_rank">([^<]+)</g)].map((m) => ({ title: un(m[2]), rank: +m[1] }));
  },
  naver_popular: async () => {
    const h = await get('https://news.naver.com/main/ranking/popularDay.naver', 'euc-kr');
    return [...h.matchAll(/list_ranking_num">(\d+)[\s\S]*?class="list_title[^>]*>([^<]+)<\/a>/g)].map((m) => ({ title: un(m[2]), rank: +m[1] })).slice(0, 60);
  },
  // 비교 기준: 지금 레이더가 쓰는 신호(mbcdy) — 새 신호가 얼마나 앞서는지 재려고 같이 기록
  mbcdy: rss('https://www.mbcdy.com/feed', 40),
  // 사실 확인: 위키백과 한국어 전날 상위
  wiki_ko_top: async () => {
    const d = new Date(Date.now() - 36 * 3600e3), p = (n) => String(n).padStart(2, '0');
    const j = JSON.parse(await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/ko.wikipedia/all-access/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`));
    return j.items[0].articles.filter((a) => !/^(위키백과|특수|분류|파일|틀):/.test(a.article)).slice(0, 40).map((a) => ({ title: a.article.replace(/_/g, ' '), views: a.views }));
  },
};

const snap = { t: new Date().toISOString(), src: {}, err: {} };
await Promise.all(Object.entries(SOURCES).map(async ([k, f]) => {
  try { snap.src[k] = await f(); } catch (e) { snap.err[k] = String(e.message || e); }
}));

mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST 날짜
appendFileSync(new URL(`./data/snap-${day}.jsonl`, import.meta.url), JSON.stringify(snap) + '\n');

const counts = Object.fromEntries(Object.entries(snap.src).map(([k, v]) => [k, v.length]));
console.log(snap.t, JSON.stringify(counts));
if (Object.keys(snap.err).length) console.log('오류:', JSON.stringify(snap.err));
