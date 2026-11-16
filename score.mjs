// 이슈 레이더 v2 — 1단계: 점수 계산 + 기존 레이더(mbcdy)와 비교 (발행 없음, 읽기만)
// 사용: node score.mjs            → 지금 시점의 "써야 할 주제" 상위 순위
//       node score.mjs --at ISO   → 그 시점 기준으로 계산(과거 재현)
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./data/', import.meta.url);
const snaps = readdirSync(dir).filter((f) => /^snap-.*\.jsonl$/.test(f)).sort()
  .flatMap((f) => readFileSync(new URL(f, dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .sort((a, b) => a.t.localeCompare(b.t));
const atArg = process.argv.indexOf('--at');
const NOW = atArg > 0 ? Date.parse(process.argv[atArg + 1]) : Date.parse(snaps.at(-1).t);
const use = snaps.filter((s) => Date.parse(s.t) <= NOW);

const SUPPLY = ['yna_society', 'yna_entertain', 'yna_all', 'newsis', 'donga', 'khan', 'hani', 'nocut', 'sbs', 'mk', 'hankyung', 'gnews_top', 'gnews_nation', 'gnews_entertain'];
const DEMAND = ['gtrends', 'daum_trend', 'nate_issue', 'naver_popular'];
const STOP = new Set(['기자', '속보', '단독', '종합', '사진', '영상', '오늘', '관련', '이후', '대한', '위해', '통해', '대해', '발표', '정부', '한국', '서울', '논란', '의혹', '사건', '확인', '예정', '진행', '지난', '최근', '우리', '모든', '이번']);
const JOSA = /(은|는|이|가|을|를|의|에|에서|와|과|도|로|으로|만|까지|부터|에게|께)$/;

const toks = (s) => [...new Set((s.replace(/ - [^-]+$/, '').match(/[가-힣A-Za-z0-9]{2,}/g) || [])
  .map((w) => (w.length > 2 ? w.replace(JOSA, '') : w)).filter((w) => w.length >= 2 && !STOP.has(w)))];
const korean = (s) => /[가-힣]/.test(s);
const t0 = (x) => { const v = Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(x || '') ? x.replace(' ', 'T') + '+09:00' : x); return Number.isFinite(v) ? v : null; }; // 시간대 표시 없는 값은 KST로 간주

// 현재 창(최근 6시간)의 항목
const WIN = 6 * 3600e3;
const items = [];
for (const s of use.filter((s) => NOW - Date.parse(s.t) <= WIN)) {
  for (const [src, arr] of Object.entries(s.src)) {
    for (const it of arr || []) {
      if (!it.title || (src === 'gtrends' && !korean(it.title)) || src === 'wiki_ko_top') continue;
      const kind = DEMAND.includes(src) ? 'demand' : src === 'mbcdy' ? 'base' : 'supply'; // 새로 추가한 신호원은 기본적으로 공급(뉴스)로 본다
      if (!kind) continue;
      const at = (kind !== 'demand' ? t0(src === 'nocut' ? String(it.at).replace(' GMT', ' +0900') : it.at) : null) ?? Date.parse(s.t); // 노컷뉴스는 한국 시각을 GMT로 잘못 표기
      if (NOW - at > 48 * 3600e3) continue;
      items.push({ src, kind, title: it.title, rank: it.rank || null, at, seen: Date.parse(s.t), tk: toks(it.title), outlet: (it.title.match(/ - ([^-]+)$/) || [])[1] || (src.startsWith('yna') ? '연합뉴스' : src) });
    }
  }
}
// 같은 (출처,제목) 중복 제거 — 가장 이른 관측 유지
const uniq = new Map();
for (const it of items) { const k = it.src + '|' + it.title; if (!uniq.has(k) || it.seen < uniq.get(k).seen) uniq.set(k, it); }
const all = [...uniq.values()];

// IDF — 흔한 단어로 엉뚱하게 묶이는 걸 막는다
const df = new Map(); for (const it of all) for (const w of it.tk) df.set(w, (df.get(w) || 0) + 1);
const idf = (w) => Math.log(all.length / (df.get(w) || 1));
// 대표 제목(씨앗) 하나를 기준으로만 묶는다 — 연쇄 병합(A~B, B~C → A~C)을 막기 위함
const match = (seed, it) => {
  const sh = seed.tk.filter((w) => it.tk.includes(w));
  const small = Math.min(seed.tk.length, it.tk.length);
  if (sh.length >= 2 && sh.length / small >= 0.5) return true;
  return sh.length === 1 && small <= 4 && sh[0].length >= 3 && idf(sh[0]) > 4.2; // 짧은 키워드(예: 사람 이름)는 희귀한 단어 하나로도 연결
};
const order = [...all].sort((a, b) => (a.kind === 'demand' ? 0 : 1) - (b.kind === 'demand' ? 0 : 1) || b.tk.length - a.tk.length);
const seeds = []; // { seed, g }
for (const it of order) {
  const c = seeds.find((c) => match(c.seed, it));
  if (c) c.g.push(it); else seeds.push({ seed: it, g: [it] });
}
const groups = new Map(seeds.map((c, i) => [i, c.g]));

const wiki = new Set((use.at(-1).src.wiki_ko_top || []).flatMap((a) => toks(a.title)).filter((w) => w.length >= 3));
const mins = (ms) => Math.round(ms / 60000);

const clusters = [...groups.values()].map((g) => {
  const sup = g.filter((x) => x.kind === 'supply'), dem = g.filter((x) => x.kind === 'demand'), base = g.filter((x) => x.kind === 'base');
  const outlets = new Set(sup.map((x) => x.outlet)).size;
  const demandSrc = new Set(dem.map((x) => x.src)).size;
  const bestRank = Math.min(...dem.map((x) => x.rank || 99), 99);
  const newest = sup.length ? Math.max(...sup.map((x) => x.at)) : null;
  const age = newest ? Math.max(0, mins(NOW - newest)) : null;
  const firstReal = Math.min(...g.filter((x) => x.kind !== 'base').map((x) => x.at), Infinity); // 새 신호원이 처음 본 시각
  const firstBase = base.length ? Math.min(...base.map((x) => x.at)) : null;
  const firstSeenObs = Math.min(...g.filter((x) => x.kind === 'demand').map((x) => x.seen), Infinity);
  const wikiHit = g.some((x) => x.tk.some((w) => wiki.has(w)));
  const fresh = age == null ? 0 : age < 30 ? 3 : age < 90 ? 2 : age < 240 ? 1 : 0;
  const score = Math.min(outlets, 6) * 1.0 + demandSrc * 3 + (bestRank <= 3 ? 2 : bestRank <= 10 ? 1 : 0) + fresh + (wikiHit ? 2 : 0);
  const rep = (sup.sort((a, b) => b.at - a.at)[0] || dem[0] || base[0]);
  return { title: rep.title.replace(/ - [^-]+$/, ''), score, outlets, demandSrc, bestRank, age, wikiHit, inBase: base.length > 0,
    lead: firstBase && Number.isFinite(firstReal) && Math.abs(firstBase - firstReal) < 24 * 3600e3 ? mins(firstBase - firstReal) : null, members: g, srcs: [...new Set(g.map((x) => x.src))], n: g.length, firstSeenObs };
}).filter((c) => c.outlets + c.demandSrc >= 2).sort((a, b) => b.score - a.score);

if (process.argv.includes('--json')) { // 자동 기록용: 한 줄 JSON(상위 15개)
  console.log(JSON.stringify({ t: new Date(NOW).toISOString(), top: clusters.slice(0, 15).map(({ members, firstSeenObs, ...c }) => c) }));
  process.exit(0);
}
console.log(`기준 ${new Date(NOW).toISOString()} · 스냅샷 ${use.length}개 · 항목 ${all.length}개 · 후보 ${clusters.length}개\n`);
console.log('순위 점수  매체 수요 순위 신선도 위키 mbcdy  주제');
clusters.slice(0, 15).forEach((c, i) => {
  const base = c.inBase ? (c.lead != null ? `${c.lead >= 0 ? '+' : ''}${c.lead}분` : '있음') : '없음';
  console.log(`${String(i + 1).padStart(2)}   ${c.score.toFixed(1).padStart(5)}  ${String(c.outlets).padStart(3)}  ${String(c.demandSrc).padStart(3)}  ${String(c.bestRank === 99 ? '-' : c.bestRank).padStart(3)}  ${String(c.age == null ? '-' : c.age + '분').padStart(5)}  ${c.wikiHit ? 'O' : '-'}   ${base.padStart(6)}  ${c.title.slice(0, 44)}`);
});
const withBase = clusters.slice(0, 15).filter((c) => c.inBase && c.lead != null);
const mi = process.argv.indexOf('--members');
if (mi > 0) { const c = clusters[+process.argv[mi + 1] - 1]; console.log('\n[묶음 내용]'); c.members.sort((a, b) => a.at - b.at).forEach((x) => console.log(' ', x.src.padEnd(14), new Date(x.at).toISOString().slice(5, 16), x.title.slice(0, 60))); }
console.log(`\n상위 15개 중 mbcdy에도 있는 주제 ${withBase.length}개 · 없는 주제 ${15 - withBase.length}개(새 방식만 잡음 또는 mbcdy 미게재)`);
if (withBase.length) console.log(`mbcdy 대비 새 신호 선행 시간(분) 중앙값: ${withBase.map((c) => c.lead).sort((a, b) => a - b)[Math.floor(withBase.length / 2)]}`);
