import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { latestVideos, risingVideos, videoDetail, videoCard, parseVideoId } from './src/youtube.js';
import { draftComment, aiInfo } from './src/ai.js';
import { validateComment } from './src/rules.js';
import { log, todayCount, profileTodayCount, videoClaim, checkPostAllowed, previousComments, lastUsedAt, drafts, profileState, SHOTS } from './src/store.js';
import { postComment, openForLogin, openYouTube, checkLogin, chromePath, logoutProfile, profileDir } from './src/poster.js';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
// 리허설 모드: 타이핑까지만 하고 게시하지 않음 (기록·상한에 포함되지 않음)
// 실행 모드: 켤 때는 항상 리허설. 리허설이 성공하면 화면에서 리얼로 게시할지 묻고 바꾼다.
let MODE = process.argv.includes('--real') ? 'real' : 'rehearsal';
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
    loggedIn: fs.existsSync(profileDir(name)) ? st[name]?.loggedIn ?? null : st[name] ? false : null, // null = 아직 확인 안 함
    hasProfile: fs.existsSync(profileDir(name)),
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
  chrome: !!chromePath(), job, mode: MODE, dryRun: MODE === 'rehearsal', comment: cfg.comment, rising: cfg.rising,
  personas: (cfg.personas || []).map(({ id, name, short }) => ({ id, name, short })),
})));

// 영상 상세(자막·인기 댓글)는 30분간 재사용 - 말투만 바꿔 다시 쓸 때 빠르게
const detailCache = new Map();
async function cachedDetail(id) {
  const hit = detailCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.v;
  const v = await videoDetail(id);
  detailCache.set(id, { v, at: Date.now() });
  return v;
}
const personaIds = () => (cfg.personas || []).map((p) => p.id);
const recentPersonas = () => log.all().filter((e) => e.persona).slice(-3).map((e) => e.persona);

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
  const persona = personaIds().includes(req.body?.persona) ? req.body.persona : 'auto';
  if (!parseVideoId(videoId)) throw fail(400, '영상 ID가 올바르지 않아요');
  const key = `${videoId}:${persona}`;
  const cached = drafts.get(key);
  if (cached && !regenerate) {
    drafts.set(videoId, cached); // 마지막으로 본 초안 (검사·게시 때 장면 참고)
    return { ...cached, cached: true, validation: validateComment(cached.comment, { cfg, scene: cached.scene, previous: previousComments() }) };
  }
  const t0 = Date.now();
  const v = await cachedDetail(videoId);
  const base = {
    video: { id: v.id, title: v.title, channel: v.channel, views: v.views, publishedText: v.publishedText, thumbnail: v.thumbnail, commentsDisabled: v.commentsDisabled },
    sources: { transcript: v.transcript.segments.length ? v.transcript.kind : null, comments: v.comments.length, description: !!v.description },
  };
  let d;
  try { d = await draftComment(v, { cfg, previous: previousComments(), persona, recentPersonas: recentPersonas() }); }
  catch (e) { if (e.code === 'NO_AI') return { ...base, error: e.message, code: e.code }; throw e; }
  const result = { ...base, requestedPersona: persona, persona: d.persona, worry: d.worry, scene: d.scene, comment: d.comment, attempts: d.attempts, ms: Date.now() - t0, model: aiInfo(), createdAt: new Date().toISOString() };
  drafts.set(key, result);
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
// 자동 배정은 [로그인 확인]을 통과한 계정만 쓴다 (확인 전 계정을 골라 실패하는 일 방지)
function pickProfile(requested) {
  const ps = profilesView().filter((p) => p.loggedIn === true);
  if (requested && requested !== 'auto') {
    if (!cfg.profiles.includes(requested)) throw fail(400, '없는 프로필이에요');
    if (!fs.existsSync(path.resolve('profiles', requested))) throw fail(400, `${requested} 프로필은 아직 로그인한 적이 없어요. [계정 설정]에서 먼저 로그인해 주세요`);
    return requested;
  }
  if (!ps.length) throw fail(400, '로그인이 확인된 계정이 없어요. [계정 설정]에서 로그인 후 [로그인 확인]을 눌러 주세요');
  ps.sort((a, b) => a.today - b.today || String(a.lastUsed).localeCompare(String(b.lastUsed)));
  return ps[0].name;
}

// ③ 댓글 달기 - 운영 규칙은 여기서 강제
app.post('/api/post', wrap(async (req) => {
  const { videoId, text, profile: requested, title } = req.body || {};
  const DRY_RUN = MODE === 'rehearsal'; // 이 요청 시점의 모드
  const persona = personaIds().includes(req.body?.persona) ? req.body.persona : null;
  if (job && !['done', 'failed'].includes(job.step)) throw fail(409, '다른 댓글을 게시하는 중이에요. 끝난 뒤 다시 눌러 주세요');
  if (!parseVideoId(videoId)) throw fail(400, '영상을 먼저 골라 주세요');
  const blocked = DRY_RUN ? null : checkPostAllowed({ videoId, cfg });
  if (blocked) throw fail(409, blocked);
  const draft = drafts.get(videoId);
  const v = validateComment(text, { cfg, scene: draft?.scene, previous: previousComments() });
  if (!v.ok) throw fail(400, '댓글 규칙을 통과하지 못했어요: ' + v.checks.filter((c) => c.hard && !c.ok).map((c) => c.label).join(', '));
  const profile = pickProfile(requested);

  const entry = log.add({ videoId, title: title || draft?.video?.title || videoId, profile, persona, text: text.trim(), ...(DRY_RUN ? { status: 'rehearsal' } : {}) });
  job = { id: entry.id, videoId, title: entry.title, profile, persona, dryRun: DRY_RUN, text: text.trim(), step: 'open', total: [...text.trim()].length, typed: 0, laps: {}, startedAt: Date.now() };
  broadcast('job', job);

  postComment({
    profile, videoId, text: text.trim(), cfg, shotName: `${entry.id}`, dryRun: DRY_RUN,
    onStep: (step, extra = {}) => {
      if (extra.ms != null) job.laps[job.step] = extra.ms;
      Object.assign(job, { step }, extra);
      broadcast('job', job);
    },
  }).then(({ commentUrl, shot }) => {
    log.update(entry.id, DRY_RUN ? { status: 'rehearsal', shot } : { status: 'posted', commentUrl, shot });
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
  const pname = (id) => (cfg.personas || []).find((p) => p.id === id)?.name || '';
  const rows = [['시간', '영상ID', '영상 제목', '계정', '말투', '댓글', '결과', '사유', '댓글 링크']]
    .concat(log.all().map((e) => [new Date(e.time).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), e.videoId, e.title, e.profile, pname(e.persona), e.text, e.status, e.reason, e.commentUrl]));
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

// 로그아웃 (개별 / 일괄). 게시 중인 계정은 로그아웃하지 않는다
const jobRunning = () => job && !['done', 'failed'].includes(job.step);
async function doLogout(name) {
  if (jobRunning() && job.profile === name) throw fail(409, `${name}으로 게시 중이에요. 끝난 뒤 로그아웃해 주세요`);
  try {
    const r = await logoutProfile(name);
    profileState.set(name, { loggedIn: false, checkedAt: new Date().toISOString(), loggedOutAt: new Date().toISOString() });
    return { name, ok: true, removed: r.removed };
  } catch (e) { throw fail(e.status || 409, e.message); }
}
app.post('/api/profiles/logout-all', wrap(async () => {
  if (jobRunning()) throw fail(409, '게시 중이에요. 끝난 뒤 다시 눌러 주세요');
  const results = [];
  for (const name of cfg.profiles) {
    try { results.push(await doLogout(name)); } catch (e) { results.push({ name, ok: false, error: e.message }); }
  }
  return { results };
}));
app.post('/api/profiles/:name/logout', wrap(async (req) => {
  if (!cfg.profiles.includes(req.params.name)) throw fail(404, '없는 프로필이에요');
  return doLogout(req.params.name);
}));

// 계정 클릭 → 그 크롬 프로필로 유튜브를 별도 창으로 열기 (사용자가 직접 보는 일반 크롬)
app.post('/api/profiles/:name/open', wrap(async (req) => {
  const name = req.params.name;
  if (!cfg.profiles.includes(name)) throw fail(404, '없는 프로필이에요');
  if (jobRunning() && job.profile === name) throw fail(409, `${name}으로 게시 중이에요. 끝난 뒤 열어 주세요`);
  try { await openYouTube(name); } catch (e) { throw fail(409, e.message); }
  return { ok: true };
}));

// 실행 모드 바꾸기 (리허설 ↔ 리얼)
app.post('/api/mode', wrap((req) => {
  const m = req.body?.mode;
  if (!['rehearsal', 'real'].includes(m)) throw fail(400, '모드가 올바르지 않아요');
  if (jobRunning()) throw fail(409, '게시 중에는 모드를 바꿀 수 없어요');
  MODE = m;
  broadcast('mode', { mode: MODE });
  return { mode: MODE };
}));

const port = +process.env.PORT || cfg.port;
app.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  운명원 댓글 에이전트 실행 중 → ${url}\n  AI: ${aiInfo() ? `${aiInfo().provider} (${aiInfo().model})` : '키 없음 (.env 확인)'} · YouTube: ${process.env.YOUTUBE_API_KEY ? 'Data API' : '키 없이'}\n  ※ 리허설 모드로 시작해요 (타이핑까지만). 리허설이 성공하면 화면에서 리얼 게시 여부를 물어요\n`);
  if (!process.argv.includes('--no-open') && process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
