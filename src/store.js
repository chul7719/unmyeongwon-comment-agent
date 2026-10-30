// 기록 저장소 (data/log.json) + 운영 규칙 강제
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA = path.resolve('data');
const LOG = path.join(DATA, 'log.json');
const DRAFTS = path.join(DATA, 'drafts.json');
export const SHOTS = path.join(DATA, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };

// 한국 시간 기준 날짜 (하루 상한은 자정 KST에 초기화)
export const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 36e5).toISOString().slice(0, 10);

// 상한·중복 계산에 포함되는 상태: 게시됨 / 게시했지만 확인 실패 / 진행 중
const COUNTED = new Set(['posted', 'unverified', 'running']);

export const log = {
  all: () => readJson(LOG, []),
  add(entry) {
    const list = log.all();
    const e = { id: randomUUID().slice(0, 8), time: new Date().toISOString(), date: kstDate(), status: 'running', ...entry };
    list.push(e);
    writeJson(LOG, list);
    return e;
  },
  update(id, patch) {
    const list = log.all();
    const e = list.find((x) => x.id === id);
    if (e) Object.assign(e, patch, { updated: new Date().toISOString() });
    writeJson(LOG, list);
    return e;
  },
  // 서버가 꺼지면서 '진행 중'으로 남은 기록 정리 (게시 여부를 알 수 없으므로 확인 실패로 남겨 중복 게시를 막는다)
  recoverStale() {
    const list = log.all();
    let changed = false;
    for (const e of list) if (e.status === 'running') { e.status = 'unverified'; e.reason = '진행 중 프로그램이 종료됨 (게시 여부 확인 필요)'; changed = true; }
    if (changed) writeJson(LOG, list);
  },
};

export function todayCount() {
  const d = kstDate();
  return log.all().filter((e) => e.date === d && COUNTED.has(e.status)).length;
}

export function profileTodayCount(profile) {
  const d = kstDate();
  return log.all().filter((e) => e.date === d && e.profile === profile && COUNTED.has(e.status)).length;
}

/** 영상에 이미 댓글이 있거나 진행 중이면 그 기록을 돌려준다 */
export function videoClaim(videoId) {
  return log.all().find((e) => e.videoId === videoId && COUNTED.has(e.status)) || null;
}

export function lastUsedAt(profile) {
  const list = log.all().filter((e) => e.profile === profile);
  return list.length ? list[list.length - 1].time : '';
}

export function previousComments(limit = 30) {
  return log.all().filter((e) => e.text && COUNTED.has(e.status)).slice(-limit).map((e) => e.text);
}

/** 운영 규칙 검사 - 서버에서 게시 전에 반드시 통과해야 함 */
export function checkPostAllowed({ videoId, cfg }) {
  const claim = videoClaim(videoId);
  if (claim) return `이 영상에는 이미 ${claim.profile} 계정으로 댓글을 달았어요 (영상당 1개)`;
  const max = cfg.limits.daily_max_comments;
  if (todayCount() >= max) return `오늘 게시 상한 ${max}개에 도달했어요. 내일 다시 할 수 있어요`;
  return null;
}

export const drafts = {
  get: (id) => readJson(DRAFTS, {})[id] || null,
  set(id, v) { const all = readJson(DRAFTS, {}); all[id] = v; writeJson(DRAFTS, all); },
};

export const profileState = {
  file: path.join(DATA, 'profiles.json'),
  all() { return readJson(this.file, {}); },
  set(name, patch) { const all = this.all(); all[name] = { ...(all[name] || {}), ...patch }; writeJson(this.file, all); },
};
