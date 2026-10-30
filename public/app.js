// 대시보드 화면 로직 (프레임워크 없이)
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '만' : n.toLocaleString('ko-KR'));

const S = {
  mode: 'latest', videos: [], selected: null, analysis: null, text: '', validation: null,
  profile: 'auto', state: null, job: null, analyzing: false,
};

async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `오류 ${r.status}`);
  return j;
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast'), 3500);
}

/* ---------- 상단 · 계정 ---------- */
async function loadState() {
  S.state = await api('/api/state');
  const { today, max, ai, youtube } = S.state;
  $('#today').textContent = `${today} / ${max}`;
  $('#today').className = today >= max ? 'warn' : '';
  $('#meter').style.width = Math.min(100, (today / max) * 100) + '%';
  $('#aiName').textContent = ai ? { gemini: 'Gemini', anthropic: 'Claude', openai: 'GPT' }[ai.provider] : '키 없음';
  $('#aiName').className = ai ? '' : 'warn';
  $('#ytMode').textContent = youtube;
  $('#dryBadge').hidden = !S.state.dryRun;
  $('#postBtn').textContent = S.state.dryRun ? '댓글 달기 (리허설)' : '댓글 달기';
  $('#ruleText').innerHTML = `영상 하나에 댓글 하나 · 하루 최대 ${max}개 · 한 영상엔 계정 하나<br>실패하면 이유와 화면 캡처가 기록에 남아요`;
  if (!S.job && S.state.job) S.job = S.state.job;
  renderAccounts(); renderPost(); renderProfilesDialog();
}

function autoTarget() {
  const ps = S.state.profiles.filter((p) => p.loggedIn === true);
  ps.sort((a, b) => a.today - b.today || String(a.lastUsed).localeCompare(String(b.lastUsed)));
  return ps[0]?.name;
}

function renderAccounts() {
  const ps = S.state.profiles;
  if (S.profile !== 'auto' && ps.find((p) => p.name === S.profile)?.loggedIn !== true) S.profile = 'auto';
  const dot = (p) => `<span class="dot ${p.loggedIn ? 'ok' : p.loggedIn === false ? 'no' : ''}"></span>`;
  const sub = (p) => (p.loggedIn === false ? '로그인 필요' : p.loggedIn == null ? '로그인 확인 전' : `오늘 ${p.today}개`);
  $('#acct').innerHTML =
    `<button data-p="auto" class="${S.profile === 'auto' ? 'on' : ''}"><b>자동 배정</b><small>→ ${esc(autoTarget() || '없음')}</small></button>` +
    ps.map((p) => `<button data-p="${esc(p.name)}" class="${S.profile === p.name ? 'on' : ''}" ${p.loggedIn !== true ? 'disabled' : ''} title="${p.loggedIn !== true ? '[계정 설정]에서 로그인 후 [로그인 확인]을 눌러 주세요' : ''}"><b>${dot(p)}${esc(p.name)}</b><small>${sub(p)}</small></button>`).join('');
}
$('#acct').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]'); if (!b || b.disabled) return;
  S.profile = b.dataset.p; renderAccounts();
});

/* ---------- ① 영상 불러오기 ---------- */
$('#modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.mode = b.dataset.mode;
  [...$('#modeSeg').children].forEach((x) => x.classList.toggle('on', x === b));
  const r = S.state?.rising;
  $('#modeHint').textContent = S.mode === 'rising'
    ? `'연애' 영상 중 조회수 ${r ? r.min_views.toLocaleString() : '1,000'}~${r ? r.max_views.toLocaleString() : '5,000'} · 시간당 ${r ? r.min_views_per_hour : 150}회 이상인 영상`
    : '이번 주 올라온 연애 영상을 최신순으로 보여줘요';
  loadVideos();
});
$('#loadBtn').addEventListener('click', loadVideos);

async function loadVideos() {
  const btn = $('#loadBtn');
  btn.classList.add('loading'); btn.textContent = '불러오는 중...';
  $('#list').innerHTML = Array.from({ length: 5 }, () => '<div class="skel"></div>').join('');
  try {
    const r = await api('/api/videos?mode=' + S.mode);
    S.videos = r.videos;
    $('#listHint').textContent = `${r.videos.length}개`;
    renderList();
  } catch (e) {
    $('#list').innerHTML = `<div class="empty">불러오지 못했어요<br>${esc(e.message)}</div>`;
  } finally { btn.classList.remove('loading'); btn.textContent = '영상 불러오기'; }
}

function itemHtml(v) {
  const chips = [];
  if (v.viewsPerHour) chips.push(`<span class="chip hot">시간당 ${v.viewsPerHour.toLocaleString()}회</span>`);
  if (v.commented) chips.push(`<span class="chip ${v.commented.status === 'posted' ? 'ok' : 'err'}">${v.commented.status === 'posted' ? '댓글 완료' : v.commented.status === 'running' ? '게시 중' : '확인 필요'} · ${esc(v.commented.profile)}</span>`);
  return `<button class="item ${S.selected?.id === v.id ? 'sel' : ''} ${v.commented ? 'done' : ''}" data-id="${v.id}">
    <div class="thumb"><img loading="lazy" src="${esc(v.thumbnail)}" alt=""><em>${esc(v.duration || '')}</em></div>
    <div><div class="it">${esc(v.title)}</div><div class="im">${esc(v.channel)} · ${esc(v.publishedText || '')}${v.views ? ` · 조회수 ${fmtNum(v.views)}` : ''}</div>${chips.join('')}</div></button>`;
}
function renderList() {
  $('#list').innerHTML = S.videos.length ? S.videos.map(itemHtml).join('')
    : `<div class="empty">${S.mode === 'rising' ? '지금은 조건에 맞는 영상이 없어요.<br>조금 뒤에 다시 불러와 보세요' : '영상을 찾지 못했어요'}</div>`;
}
$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('.item'); if (!b) return;
  const v = S.videos.find((x) => x.id === b.dataset.id);
  if (v) selectVideo(v);
});

$('#linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#linkInput').value.trim(); if (!url) return;
  try {
    const { video } = await api('/api/videos/link', { method: 'POST', body: { url } });
    S.videos = [video, ...S.videos.filter((v) => v.id !== video.id)];
    $('#linkInput').value = '';
    renderList(); selectVideo(video);
  } catch (err) { toast(err.message, true); }
});

/* ---------- ② 영상 선택 · 분석 ---------- */
async function selectVideo(v, regenerate = false) {
  S.selected = v; S.analysis = null; S.text = ''; S.validation = null; S.analyzing = true;
  if (!S.job || ['done', 'failed'].includes(S.job.step)) { S.job = null; renderJob(); }
  renderList(); renderPost();
  const steps = ['자막 읽는 중', '인기 댓글 읽는 중', '영상 속 고민 정리 중', '댓글 초안 쓰는 중'];
  $('#detail').innerHTML = `<div class="vhead"><div class="vthumb"><img src="${esc(v.thumbnail)}"></div><div><div class="vt">${esc(v.title)}</div><div class="vm">${esc(v.channel)}</div></div></div>
    <div class="loadingbox" id="lbox">${steps.map((s, i) => `<div class="lstep" data-i="${i}"><span class="dotw">·</span>${s}</div>`).join('')}</div>`;
  $('#analyzeHint').textContent = 'AI 분석 중...';
  let i = 0;
  const tick = () => {
    document.querySelectorAll('.lstep').forEach((el) => {
      const k = +el.dataset.i;
      el.className = 'lstep' + (k < i ? ' ok' : k === i ? ' on' : '');
      el.querySelector('.dotw').outerHTML = k < i ? '<span class="dotw">✓</span>' : k === i ? '<span class="spin dotw"></span>' : '<span class="dotw">·</span>';
    });
    if (i < steps.length - 1) i++;
  };
  tick(); const timer = setInterval(tick, 1600);
  try {
    const a = await api('/api/analyze', { method: 'POST', body: { videoId: v.id, regenerate } });
    if (S.selected?.id !== v.id) return;
    S.analysis = a; S.text = a.comment || ''; S.validation = a.validation || null;
    $('#analyzeHint').textContent = a.error ? '' : a.cached ? '저장된 초안' : `AI 분석 완료 · ${(a.ms / 1000).toFixed(0)}초`;
    renderDetail();
  } catch (e) {
    if (S.selected?.id !== v.id) return;
    $('#analyzeHint').textContent = '';
    $('#detail').innerHTML = `<div class="notice err">분석하지 못했어요: ${esc(e.message)}</div><button class="btn-ghost" id="retryA">다시 시도</button>`;
    $('#retryA').onclick = () => selectVideo(v);
  } finally { clearInterval(timer); S.analyzing = false; renderPost(); }
}

// 초안에서 운명원 강조, 장면과 겹치는 가장 긴 구간에 밑줄
function longestCommon(a, b) {
  let best = { i: -1, len: 0 };
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let k = 0; while (a[i + k] && a[i + k] === b[j + k]) k++;
    if (k > best.len) best = { i, len: k };
  }
  return best.len >= 3 ? best : null;
}
function draftHtml(text) {
  const brand = S.state?.comment?.brand || '운명원';
  const quote = S.analysis?.scene?.quote || '';
  const lc = longestCommon(text, quote);
  let html = '';
  for (let i = 0; i < text.length;) {
    if (lc && i === lc.i) { html += `<u>${esc(text.slice(i, i + lc.len))}</u>`; i += lc.len; continue; }
    if (text.startsWith(brand, i)) { html += `<mark>${esc(brand)}</mark>`; i += brand.length; continue; }
    html += esc(text[i]); i++;
  }
  return html;
}

function renderDetail() {
  const a = S.analysis, v = a.video;
  const src = [`자막 <b>${a.sources.transcript || '없음'}</b>`, `인기 댓글 <b>${a.sources.comments}개</b>`];
  if (!a.sources.transcript) src.push('<b>제목·설명</b>으로 분석');
  if (a.model) src.push(`<b>${esc(a.model.lastUsed || a.model.model)}</b>`);
  const head = `<div class="vhead"><div class="vthumb"><img src="${esc(v.thumbnail)}"></div><div>
      <div class="vt"><a href="https://www.youtube.com/watch?v=${v.id}" target="_blank">${esc(v.title)}</a></div>
      <div class="vm">${esc(v.channel)} · 조회수 ${(v.views || 0).toLocaleString('ko-KR')}회 · ${esc(v.publishedText || '')}</div>
      <div class="src">${src.map((s) => `<span>${s}</span>`).join('')}</div></div></div>`;
  const disabledNote = v.commentsDisabled ? '<div class="notice err">이 영상은 댓글 사용이 중지돼 있어요. 다른 영상을 골라 주세요</div>' : '';
  if (a.error) {
    $('#detail').innerHTML = head + disabledNote + `<div class="notice">${esc(a.error)}<br>아래 칸에 직접 써서 게시할 수도 있어요.</div>
      <div><div class="label">댓글 초안</div><div class="draft" id="draft" contenteditable="plaintext-only"></div><div class="dfoot" id="dfoot"></div></div>`;
  } else {
    const time = a.scene?.time ? `(${esc(a.scene.time)}) ` : '';
    $('#detail').innerHTML = head + disabledNote + `
      <div><div class="label">영상 속 고민</div><div class="worry">${esc(a.worry)}</div>
      <div class="scene">짚은 장면 ${time}<b>${esc(a.scene?.quote || '')}</b></div></div>
      <div><div class="label">댓글 초안 <span style="font-weight:400">· 클릭해서 직접 고칠 수 있어요</span></div>
      <div class="draft" id="draft" contenteditable="plaintext-only">${draftHtml(S.text)}</div>
      <div class="dfoot" id="dfoot"></div></div>`;
  }
  const d = $('#draft');
  d.addEventListener('focus', () => { d.textContent = S.text; });
  d.addEventListener('blur', () => { d.innerHTML = draftHtml(S.text); });
  d.addEventListener('input', () => { S.text = d.innerText.replace(/\n/g, ' '); renderFoot(true); clearTimeout(d.t); d.t = setTimeout(revalidate, 350); });
  renderFoot();
}

async function revalidate() {
  if (!S.selected) return;
  S.validation = await api('/api/validate', { method: 'POST', body: { text: S.text, videoId: S.selected.id } }).catch(() => null);
  renderFoot(); renderPost();
}

function renderFoot(countOnly) {
  const f = $('#dfoot'); if (!f) return;
  const n = [...S.text.trim()].length;
  const { min_chars: min, max_chars: max } = S.state?.comment || { min_chars: 40, max_chars: 120 };
  const countHtml = `<span class="count ${n < min || n > max ? 'bad' : ''}">${n}자</span>`;
  if (countOnly && f.firstElementChild) { f.firstElementChild.outerHTML = countHtml; return; }
  const checks = (S.validation?.checks || []).map((c) => `<span class="check ${c.ok ? '' : c.hard ? 'bad' : 'soft'}" title="${esc(c.detail || '')}">${c.ok ? '' : '✕ '}${esc(c.label)}</span>`).join('');
  f.innerHTML = countHtml + checks + `<div class="r">${S.analysis?.error ? '' : '<button class="btn-ghost" id="regen">다시 쓰기</button>'}</div>`;
  const rg = $('#regen'); if (rg) rg.onclick = () => selectVideo(S.selected, true);
}

/* ---------- ③ 댓글 달기 ---------- */
function postBlocker() {
  if (S.job && !['done', 'failed'].includes(S.job.step)) return '게시 진행 중이에요';
  if (!S.selected) return '영상을 고르면 누를 수 있어요';
  if (S.analyzing) return 'AI가 초안을 쓰는 중이에요';
  if (S.selected.commented && !S.state?.dryRun) return `이미 ${S.selected.commented.profile} 계정으로 댓글을 단 영상이에요 (영상당 1개)`;
  if (S.analysis?.video?.commentsDisabled) return '댓글 사용이 중지된 영상이에요';
  if (S.state && !S.state.dryRun && S.state.today >= S.state.max) return `오늘 게시 상한 ${S.state.max}개에 도달했어요`;
  if (!S.text.trim()) return '댓글 초안이 비어 있어요';
  const bad = (S.validation?.checks || []).filter((c) => c.hard && !c.ok);
  if (bad.length) return '규칙 확인: ' + bad.map((c) => c.label).join(', ');
  if (!S.state?.profiles.some((p) => p.loggedIn === true)) return '로그인이 확인된 계정이 없어요. [계정 설정]에서 로그인 후 [로그인 확인]을 눌러 주세요';
  return null;
}
function renderPost() {
  const why = postBlocker();
  $('#postBtn').disabled = !!why;
  $('#why').textContent = why || `${S.profile === 'auto' ? autoTarget() : S.profile} 크롬 프로필이 열리고 한 글자씩 입력돼요`;
  $('#why').className = 'why' + (why && /규칙|상한|이미|중지/.test(why) ? ' err' : '');
}

$('#postBtn').addEventListener('click', async () => {
  if (postBlocker()) return;
  $('#postBtn').disabled = true;
  try {
    const r = await api('/api/post', { method: 'POST', body: { videoId: S.selected.id, text: S.text.trim(), profile: S.profile, title: S.selected.title } });
    toast(`${r.profile} 프로필로 게시를 시작해요`);
  } catch (e) { toast(e.message, true); renderPost(); }
});

const STEPS = [
  ['open', '크롬 프로필 여는 중'],
  ['navigate', '영상 열고 댓글 창 찾기'],
  ['typing', '한 글자씩 입력 중'],
  ['post', '게시'],
  ['verify', '내 댓글 확인'],
];
function renderJob() {
  const j = S.job;
  if (!j) { $('#steps').innerHTML = ''; $('#jobBox').innerHTML = ''; return; }
  const order = STEPS.map((s) => s[0]);
  const cur = j.step === 'done' ? order.length : j.step === 'failed' ? order.indexOf(j.failedAt ?? 'open') : order.indexOf(j.step);
  $('#steps').innerHTML = STEPS.map(([k, label], i) => {
    let cls = i < cur ? 'done' : i === cur ? (j.step === 'failed' ? 'fail' : 'now') : 'wait';
    const sec = j.laps?.[k] != null ? `${(j.laps[k] / 1000).toFixed(1)}초` : '';
    const right = k === 'typing' && i === cur && j.step === 'typing' ? `${j.typed} / ${j.total}` : sec;
    return `<div class="s ${cls}"><i>${cls === 'done' ? '✓' : cls === 'fail' ? '!' : i + 1}</i>${label}${k === 'open' ? ` · ${esc(j.profile)}` : ''}<em>${right}</em></div>`;
  }).join('');
  if (j.step === 'typing' || j.step === 'post' || j.step === 'verify') {
    const full = [...(S.job.text || S.text)];
    const typed = j.step === 'typing' ? j.typed : full.length;
    $('#jobBox').innerHTML = `<div class="typing">${esc(full.slice(0, typed).join(''))}<span class="cur"></span><span class="rest">${esc(full.slice(typed).join(''))}</span>
      <div class="bar"><span style="width:${(typed / Math.max(1, full.length)) * 100}%"></span></div></div>`;
  } else if (j.step === 'done' && j.dryRun) {
    $('#jobBox').innerHTML = `<div class="result ok"><div><b>리허설 완료</b> · 끝까지 입력한 뒤 게시하지 않고 지웠어요</div>${j.shot ? `<a href="/shots/${esc(j.shot)}" target="_blank"><img src="/shots/${esc(j.shot)}"></a>` : ''}</div>`;
  } else if (j.step === 'done') {
    $('#jobBox').innerHTML = `<div class="result ok"><div><b>게시 완료</b> · 내 댓글이 보이는 것까지 확인했어요 (${((j.totalMs || 0) / 1000).toFixed(0)}초)</div>
      <a href="${esc(j.commentUrl)}" target="_blank">댓글 보기 →</a>${j.shot ? `<a href="/shots/${esc(j.shot)}" target="_blank"><img src="/shots/${esc(j.shot)}"></a>` : ''}</div>`;
  } else if (j.step === 'failed') {
    $('#jobBox').innerHTML = `<div class="result err"><div><b>${j.posted ? '게시 확인 실패' : '실패'}</b> · ${esc(j.reason)}</div>
      ${j.posted ? '<div>게시 버튼은 눌렸을 수 있어 이 영상은 다시 달지 않도록 잠가 뒀어요</div>' : ''}
      ${j.shot ? `<a href="/shots/${esc(j.shot)}" target="_blank"><img src="/shots/${esc(j.shot)}"></a>` : ''}</div>`;
  } else $('#jobBox').innerHTML = '';
}

/* ---------- 기록 ---------- */
const ST = { posted: ['ok', '게시 완료'], failed: ['err', '실패'], unverified: ['warn', '확인 필요'], running: ['run', '진행 중'], rehearsal: ['run', '리허설'], 'rehearsal-failed': ['err', '리허설 실패'] };
async function loadLog() {
  const { entries } = await api('/api/log');
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  $('#logHint').textContent = `시간순 · 오늘 ${entries.filter((e) => e.date === today).length}건 · 전체 ${entries.length}건`;
  $('#logBody').innerHTML = entries.length ? entries.map((e) => {
    const [cls, label] = ST[e.status] || ['run', e.status];
    const t = new Date(e.time);
    const when = t.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) === today ? t.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }) : t.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
    return `<tr><td class="mono">${when}</td><td class="v"><a style="color:inherit;font-weight:500;white-space:normal" href="https://www.youtube.com/watch?v=${esc(e.videoId)}" target="_blank">${esc(e.title)}</a></td><td>${esc(e.profile)}</td>
      <td class="c">${esc(e.text)}${e.reason ? `<div class="reason">${esc(e.reason)}</div>` : ''}</td><td><span class="st ${cls}">${label}</span></td>
      <td>${e.commentUrl ? `<a href="${esc(e.commentUrl)}" target="_blank">댓글 보기</a>` : ''}${e.shot ? `<a href="/shots/${esc(e.shot)}" target="_blank">캡처</a>` : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="emptyrow">아직 기록이 없어요</td></tr>';
}

/* ---------- 계정 설정 ---------- */
$('#openSettings').onclick = () => $('#settings').showModal();
$('#closeSettings').onclick = () => $('#settings').close();
function renderProfilesDialog() {
  $('#profRows').innerHTML = S.state.profiles.map((p) => `<div class="prow"><b><span class="dot ${p.loggedIn ? 'ok' : p.loggedIn === false ? 'no' : ''}"></span>${esc(p.name)}<small>${p.loggedIn ? '로그인됨' : p.loggedIn === false ? '로그인 안 됨' : '확인 전'}</small></b>
    <button class="btn-ghost" data-login="${esc(p.name)}">로그인 창 열기</button><button class="btn-ghost" data-check="${esc(p.name)}">로그인 확인</button></div>`).join('');
}
$('#profRows').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.login) { await api(`/api/profiles/${encodeURIComponent(b.dataset.login)}/login`, { method: 'POST' }); toast('크롬 창에서 구글 로그인 후, 창을 닫고 [로그인 확인]을 눌러 주세요'); }
    if (b.dataset.check) { b.textContent = '확인 중...'; const r = await api(`/api/profiles/${encodeURIComponent(b.dataset.check)}/check`, { method: 'POST' }); toast(r.loggedIn ? `${b.dataset.check} 로그인 확인됨` : `${b.dataset.check} 로그인이 안 돼 있어요`, !r.loggedIn); }
  } catch (err) { toast(err.message, true); }
  await loadState();
});

/* ---------- 실시간 이벤트 ---------- */
const ev = new EventSource('/api/events');
ev.addEventListener('job', (m) => {
  const j = JSON.parse(m.data);
  const prev = S.job;
  if (j.step === 'failed' && !j.failedAt) j.failedAt = prev?.id === j.id ? prev.step : 'open';
  S.job = j;
  renderJob(); renderPost();
  if (j.step === 'done' || j.step === 'failed') {
    if (S.selected?.id === j.videoId && j.step === 'done' && !j.dryRun) S.selected.commented = { profile: j.profile, status: 'posted' };
    if (S.selected?.id === j.videoId && j.step === 'failed' && j.posted) S.selected.commented = { profile: j.profile, status: 'unverified' };
    const v = S.videos.find((x) => x.id === j.videoId); if (v && S.selected?.id === j.videoId) v.commented = S.selected.commented;
    renderList(); loadState();
  }
});
ev.addEventListener('log', () => { loadLog(); loadState(); });

loadState().then(() => { renderJob(); }).catch((e) => toast('서버에 연결하지 못했어요: ' + e.message, true));
loadLog();
