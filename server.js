import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { latestVideos, risingVideos, videoDetail, videoCard, parseVideoId } from './src/youtube.js';
import { draftComment, aiInfo } from './src/ai.js';
import { validateComment } from './src/rules.js';
import { log, todayCount, profileTodayCount, videoClaim, checkPostAllowed, previousComments, lastUsedAt, drafts, profileState, SHOTS } from './src/store.js';
import { postComment, openForLogin, checkLogin, chromePath } from './src/poster.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
// 리허설 모드: 타이핑까지만 하고 게시하지 않음 (기록·상한에 포함되지 않음)
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--rehearsal');
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/shots', express.static(SHOTS));
log.recoverStale();

// ---------- 실시간 진행 상황 (Server-Sent Events) ----------
const clients = new Set();
let job = null; // 동시에 하나만 게시
const broadcast = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
app.get('/api/events', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  if (job) res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
  req.on('close', () => clients.delete(res));
});

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code }); }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

function profilesView() {
  const st = profileState.all();
  return cfg.profiles.map((name) => ({
    name,
    loggedIn: st[name]?.loggedIn ?? null, // null = 아직 확인 안 함
    checkedAt: st[name]?.checkedAt || null,
    today: profileTodayCount(name),
    lastUsed: lastUsedAt(name),
    busy: job?.profile === name && !['done', 'failed'].includes(job.step),
  }));
}

function decorate(list) {
  return list.map((v) => { const c = videoClaim(v.id); return { ...v, commented: c ? { profile: c.profile, status: c.status } : null }; });
}

app.get('/api/state', wrap(() => ({
  today: todayCount(), max: cfg.limits.daily_max_comments,
  profiles: profilesView(), ai: aiInfo(), youtube: process.env.YOUTUBE_API_KEY ? 'Data API' : '키 없이',
  chrome: !!chromePath(), job, dryRun: DRY_RUN, comment: cfg.comment, rising: cfg.rising,
})));

// ① 영상 불러오기
app.get('/api/videos', wrap(async (req) => {
  const mode = req.query.mode === 'rising' ? 'rising' : 'latest';
  const list = mode === 'rising' ? await risingVideos(cfg) : await latestVideos(cfg);
  return { mode, videos: decorate(list), at: new Date().toISOString() };
}));

// 가점: 링크 직접 입력
app.post('/api/videos/link', wrap(async (req) => {
  const id = parseVideoId(req.body?.url);
  if (!id) throw fail(400, '유튜브 영상 링크가 아니에요');
  return { video: decorate([await videoCard(id)])[0] };
}));

// ② 영상 선택 → 분석 + 초안 (한 번 만든 초안은 저장해 두고, [다시 쓰기]일 때만 새로 생성)
app.post('/api/analyze', wrap(async (req) => {
  const { videoId, regenerate } = req.body || {};
  if (!parseVideoId(videoId)) throw fail(400, '영상 ID가 올바르지 않아요');
  const cached = drafts.get(videoId);
  if (cached && !regenerate) return { ...cached, cached: true, validation: validateComment(cached.comment, { cfg, scene: cached.scene, previous: previousComments() }) };
  const t0 = Date.now();
  const v = await videoDetail(videoId);
  const base = {
    video: { id: v.id, title: v.title, channel: v.channel, views: v.views, publishedText: v.publishedText, thumbnail: v.thumbnail, commentsDisabled: v.commentsDisabled },
    sources: { transcript: v.transcript.segments.length ? v.transcript.kind : null, comments: v.comments.length, description: !!v.description },
  };
  let d;
  try { d = await draftComment(v, { cfg, previous: previousComments() }); }
  catch (e) { if (e.code === 'NO_AI') return { ...base, error: e.message, code: e.code }; throw e; }
  const result = { ...base, worry: d.worry, scene: d.scene, comment: d.comment, attempts: d.attempts, ms: Date.now() - t0, model: aiInfo(), createdAt: new Date().toISOString() };
  drafts.set(videoId, result);
  return { ...result, validation: d.validation };
}));

// 직접 고친 초안 검사
app.post('/api/validate', wrap((req) => {
  const { text, videoId } = req.body || {};
  const scene = drafts.get(videoId)?.scene;
  return validateComment(text, { cfg, scene, previous: previousComments() });
}));

// 계정 고르기: 자동 배정이면 오늘 적게 쓴 계정 → 가장 오래 전에 쓴 계정 순
function pickProfile(requested) {
  const ps = profilesView().filter((p) => p.loggedIn !== false);
  if (requested && requested !== 'auto') {
    if (!cfg.profiles.includes(requested)) throw fail(400, '없는 프로필이에요');
    return requested;
  }
  if (!ps.length) throw fail(400, '로그인된 프로필이 없어요. [계정 설정]에서 로그인해 주세요');
  ps.sort((a, b) => a.today - b.today || String(a.lastUsed).localeCompare(String(b.lastUsed)));
  return ps[0].name;
}

// ③ 댓글 달기 - 운영 규칙은 여기서 강제
app.post('/api/post', wrap(async (req) => {
  const { videoId, text, profile: requested, title } = req.body || {};
  if (job && !['done', 'failed'].includes(job.step)) throw fail(409, '다른 댓글을 게시하는 중이에요. 끝난 뒤 다시 눌러 주세요');
  if (!parseVideoId(videoId)) throw fail(400, '영상을 먼저 골라 주세요');
  const blocked = DRY_RUN ? null : checkPostAllowed({ videoId, cfg });
  if (blocked) throw fail(409, blocked);
  const draft = drafts.get(videoId);
  const v = validateComment(text, { cfg, scene: draft?.scene, previous: previousComments() });
  if (!v.ok) throw fail(400, '댓글 규칙을 통과하지 못했어요: ' + v.checks.filter((c) => c.hard && !c.ok).map((c) => c.label).join(', '));
  const profile = pickProfile(requested);

  const entry = log.add({ videoId, title: title || draft?.video?.title || videoId, profile, text: text.trim(), ...(DRY_RUN ? { status: 'rehearsal' } : {}) });
  job = { id: entry.id, videoId, profile, text: text.trim(), step: 'open', total: [...text.trim()].length, typed: 0, laps: {}, startedAt: Date.now() };
  broadcast('job', job);

  postComment({
    profile, videoId, text: text.trim(), cfg, shotName: `${entry.id}`, dryRun: DRY_RUN,
    onStep: (step, extra = {}) => {
      if (extra.ms != null) job.laps[job.step] = extra.ms;
      Object.assign(job, { step }, extra);
      broadcast('job', job);
    },
  }).then(({ commentUrl, shot, dryRun }) => {
    log.update(entry.id, dryRun ? { status: 'rehearsal', shot } : { status: 'posted', commentUrl, shot });
    profileState.set(profile, { loggedIn: true, checkedAt: new Date().toISOString() });
    broadcast('log', {});
  }).catch((e) => {
    const status = e.posted ? 'unverified' : DRY_RUN ? 'rehearsal-failed' : 'failed';
    log.update(entry.id, { status, reason: e.message, shot: e.shot });
    if (/로그인돼 있지 않아요/.test(e.message)) profileState.set(profile, { loggedIn: false, checkedAt: new Date().toISOString() });
    Object.assign(job, { failedAt: job.step, step: 'failed', reason: e.message, shot: e.shot, posted: e.posted });
    broadcast('job', job);
    broadcast('log', {});
  });
  return { ok: true, jobId: entry.id, profile };
}));

app.get('/api/log', wrap(() => ({ entries: log.all().slice().reverse() })));
app.get('/api/log.csv', (req, res) => {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['시간', '영상ID', '영상 제목', '계정', '댓글', '결과', '사유', '댓글 링크']]
    .concat(log.all().map((e) => [new Date(e.time).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), e.videoId, e.title, e.profile, e.text, e.status, e.reason, e.commentUrl]));
  res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="comment-log.csv"' });
  res.send('\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n'));
});

// 계정 설정
app.post('/api/profiles/:name/login', wrap((req) => {
  if (!cfg.profiles.includes(req.params.name)) throw fail(404, '없는 프로필이에요');
  openForLogin(req.params.name);
  return { ok: true };
}));
app.post('/api/profiles/:name/check', wrap(async (req) => {
  const name = req.params.name;
  if (!cfg.profiles.includes(name)) throw fail(404, '없는 프로필이에요');
  try {
    const r = await checkLogin(name);
    profileState.set(name, { loggedIn: r.loggedIn, checkedAt: new Date().toISOString() });
    return r;
  } catch (e) { throw fail(409, e.message); }
}));

const port = +process.env.PORT || cfg.port;
app.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  운명원 댓글 에이전트 실행 중 → ${url}\n  AI: ${aiInfo() ? `${aiInfo().provider} (${aiInfo().model})` : '키 없음 (.env 확인)'} · YouTube: ${process.env.YOUTUBE_API_KEY ? 'Data API' : '키 없이'}${DRY_RUN ? '\n  ※ 리허설 모드: 타이핑까지만 하고 게시하지 않아요' : ''}\n`);
  if (!process.argv.includes('--no-open') && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
