// npm run check : 게시 없이 규칙 검사와 유튜브 데이터 읽기만 점검
import fs from 'node:fs';
import { validateComment } from '../src/rules.js';
import { latestVideos, risingVideos, videoDetail } from '../src/youtube.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const scene = { time: '4:12', quote: '남자는 바쁠 때 연락을 줄이는 게 아니라 우선순위를 정하는 거예요' };
const cases = [
  ['정상', '4분쯤에 바쁜 게 아니라 우선순위라는 말 듣고 뜨끔했어요ㅠ 저도 답장 하루씩 기다리면서 혼자 앓았는데.. 운명원 연애사주 한번 보고 싶어지네요', true],
  ['짧음', '운명원 가보고 싶다', false],
  ['링크', '4분쯤 우선순위라는 말 공감돼요.. 운명원 연애사주 궁금하다 www.example.com 여기 보니까 잘 본다던데 한번 가봐야지', false],
  ['해시태그', '4분쯤 우선순위라는 말 진짜 공감돼요ㅠ 결국 인연인가 싶어서 운명원 연애사주 한번 보고 싶네요 #연애사주', false],
  ['지어낸 후기', '4분쯤 우선순위라는 말 공감돼요ㅠ 저 운명원에서 사주 봤는데 진짜 소름 돋게 맞더라고요 다들 꼭 가보세요 진짜로요', false],
  ['반복 스팸', '운명원처럼.'.repeat(19), false],
  ['브랜드 2번', '4분쨯 우선순위라는 말 공감돼요ㅠ 운명원 연애사주 잘 본다던데 운명원 가서 내 짝은 언제 오는지 보고 싶네요', false],
  ['ㅋㅋㅋ 허용', '4분쨯 우선순위라는 말에 빵터졌네ㅋㅋㅋㅋㅋㅋㅋㅋ 저도 답장 기다리다 지친 1인.. 인연은 따로 있는지 운명원 연애사주 한번 보고 싶다', true],
  ['브랜드 없음', '4분쯤에 바쁜 게 아니라 우선순위라는 말 듣고 뜨끔했어요ㅠ 저도 답장 하루씩 기다리면서 혼자 앓았는데.. 사주라도 보고 싶네요', false],
];
let fail = 0;
for (const [name, text, expect] of cases) {
  const r = validateComment(text, { cfg, scene, previous: [] });
  const ok = r.ok === expect;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  규칙/${name}  →  ${r.ok ? '통과' : '차단'} (${r.checks.filter((c) => !c.ok).map((c) => c.label).join(', ') || '-'})`);
}
const dup = validateComment(cases[0][1], { cfg, scene, previous: [cases[0][1]] });
console.log(`${dup.ok ? 'FAIL' : 'PASS'}  규칙/중복 댓글  →  ${dup.ok ? '통과' : '차단'}`); if (dup.ok) fail++;

try {
  const list = await latestVideos(cfg);
  console.log(`${list.length ? 'PASS' : 'FAIL'}  최신 영상 ${list.length}개  예) ${list[0]?.title} · ${list[0]?.publishedText}`); if (!list.length) fail++;
  const rising = await risingVideos(cfg);
  console.log(`INFO  뜨기 직전 ${rising.length}개${rising[0] ? `  예) ${rising[0].title} · 조회 ${rising[0].views} · 시간당 ${rising[0].viewsPerHour}` : ''}`);
  if (list[0]) {
    const d = await videoDetail(list[0].id);
    console.log(`${d.title ? 'PASS' : 'FAIL'}  영상 상세: 자막 ${d.transcript.segments.length}줄(${d.transcript.kind || '없음'}) · 인기 댓글 ${d.comments.length}개 · 설명 ${d.description.length}자 · 댓글 중지 ${d.commentsDisabled}`);
    if (!d.title) fail++;
  }
} catch (e) { fail++; console.log('FAIL  유튜브 읽기 오류', e.message); }
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
