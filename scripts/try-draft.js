// 게시 없이 초안만 만들어 보기: node scripts/try-draft.js [영상ID ...]
import 'dotenv/config';
import fs from 'node:fs';
import { latestVideos, videoDetail } from '../src/youtube.js';
import { draftComment, aiInfo } from '../src/ai.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
let ids = process.argv.slice(2);
if (!ids.length) ids = (await latestVideos(cfg)).slice(0, 3).map((v) => v.id);
const previous = [];
for (const id of ids) {
  const t0 = Date.now();
  try {
    const v = await videoDetail(id);
    console.log(`  (영상 정보 ${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    const d = await draftComment(v, { cfg, previous, persona: process.env.PERSONA || 'auto' });
    previous.push(d.comment);
    const bad = d.validation.checks.filter((c) => !c.ok).map((c) => c.label);
    console.log(`\n■ [${(cfg.personas || []).find((p) => p.id === d.persona)?.name || '-'}] ${v.title}\n  자막 ${v.transcript.segments.length}줄 · 댓글 ${v.comments.length}개 · ${aiInfo().lastUsed} · ${((Date.now() - t0) / 1000).toFixed(0)}초 · 시도 ${d.attempts}회`);
    console.log(`  고민: ${d.worry}\n  장면: (${d.scene?.time || '-'}) ${d.scene?.quote}\n  댓글(${d.validation.count}자): ${d.comment}\n  검사: ${bad.length ? '실패 → ' + bad.join(', ') : '모두 통과'}`);
  } catch (e) { console.log(`\n■ ${id} 실패: ${e.message}`); }
}
