// 유튜브 데이터 가져오기
// - YOUTUBE_API_KEY 가 있으면 공식 Data API v3 로 검색
// - 없으면 유튜브 웹이 쓰는 내부 API(youtubei)로 키 없이 동작
// - 자막은 공식 API로 받을 수 없어서(소유자 OAuth 필요) 항상 player 응답의 자막 트랙을 사용

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const API_KEY = () => process.env.YOUTUBE_API_KEY?.trim();

// 검색 필터 (유튜브 검색 화면의 "필터"와 같은 값)
const SP = {
  week: 'CAISBAgDEAE=', // 업로드 날짜순 · 이번 주 · 동영상
  today: 'CAISBAgCEAE=', // 업로드 날짜순 · 오늘 · 동영상
};

let webVersion = '2.20261029.11.00';

function walk(o, key, out = []) {
  if (o && typeof o === 'object') {
    if (o[key] !== undefined) out.push(o[key]);
    for (const v of Object.values(o)) walk(v, key, out);
  }
  return out;
}

async function innertube(endpoint, body, client = { clientName: 'WEB', clientVersion: webVersion }) {
  const r = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' },
    body: JSON.stringify({ context: { client: { ...client, hl: 'ko', gl: 'KR' } }, ...body }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`YouTube ${endpoint} 응답 ${r.status}`);
  return r.json();
}

const text = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? '';

// "조회수 2,854회" → 2854, "1.2만회" → 12000
export function parseCount(s) {
  if (s == null) return 0;
  if (typeof s === 'number') return s;
  const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*(천|만|억|K|M|B)?/i);
  if (!m) return 0;
  const mul = { 천: 1e3, 만: 1e4, 억: 1e8, k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mul);
}

// "10시간 전" → 10 (시간 단위)
export function parseAgoHours(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)\s*(초|분|시간|일|주|개월|년)/);
  if (!m) return null;
  const n = +m[1];
  return { 초: n / 3600, 분: n / 60, 시간: n, 일: n * 24, 주: n * 24 * 7, 개월: n * 24 * 30, 년: n * 24 * 365 }[m[2]];
}

export function agoLabel(hours) {
  if (hours == null) return '';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}분 전`;
  if (hours < 24) return `${Math.round(hours)}시간 전`;
  if (hours < 24 * 7) return `${Math.round(hours / 24)}일 전`;
  if (hours < 24 * 30) return `${Math.round(hours / 24 / 7)}주 전`;
  if (hours < 24 * 365) return `${Math.round(hours / 24 / 30)}개월 전`;
  return `${Math.round(hours / 24 / 365)}년 전`;
}

export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

function fromRenderer(v) {
  const published = text(v.publishedTimeText);
  const hoursAgo = parseAgoHours(published);
  return {
    id: v.videoId,
    title: text(v.title),
    channel: text(v.ownerText || v.longBylineText),
    publishedText: published || '',
    hoursAgo,
    views: parseCount(text(v.viewCountText)),
    duration: text(v.lengthText),
    thumbnail: thumb(v.videoId),
  };
}

async function searchKeyless(query, period = 'week', pages = 1) {
  const out = [];
  let res = await innertube('search', { query, params: SP[period] });
  for (let p = 0; p < pages; p++) {
    for (const v of walk(res, 'videoRenderer')) {
      if (!v.videoId || !v.lengthText) continue; // 라이브·예정 영상 제외
      out.push(fromRenderer(v));
    }
    const token = walk(res, 'continuationCommand').map((c) => c.token).pop();
    if (!token || p === pages - 1) break;
    res = await innertube('search', { continuation: token });
  }
  return out;
}

async function searchApi(query, period = 'week') {
  const key = API_KEY();
  const after = new Date(Date.now() - (period === 'today' ? 1 : 7) * 864e5).toISOString();
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  Object.entries({ part: 'snippet', q: query, type: 'video', order: 'date', maxResults: 25, regionCode: 'KR', relevanceLanguage: 'ko', publishedAfter: after, key }).forEach(([k, v]) => u.searchParams.set(k, v));
  const s = await fetch(u).then((r) => r.json());
  if (s.error) throw new Error(`YouTube API: ${s.error.message}`);
  const ids = s.items.map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return [];
  const d = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,liveStreamingDetails&id=${ids.join(',')}&key=${key}`).then((r) => r.json());
  return d.items
    .filter((v) => !v.liveStreamingDetails || v.liveStreamingDetails.actualEndTime)
    .map((v) => {
      const hoursAgo = (Date.now() - new Date(v.snippet.publishedAt)) / 36e5;
      const dur = v.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
      const [h, m, sec] = [+dur[1] || 0, +dur[2] || 0, +dur[3] || 0];
      return {
        id: v.id,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        publishedText: agoLabel(hoursAgo),
        hoursAgo,
        views: +v.statistics.viewCount || 0,
        duration: h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`,
        thumbnail: thumb(v.id),
      };
    });
}

const search = (q, period, pages) => (API_KEY() ? searchApi(q, period) : searchKeyless(q, period, pages));

function dedupe(list) {
  const seen = new Set();
  return list.filter((v) => (seen.has(v.id) ? false : seen.add(v.id)));
}

const isShortish = (v) => {
  const parts = (v.duration || '').split(':').map(Number);
  const sec = parts.reduce((a, b) => a * 60 + b, 0);
  return sec > 0 && sec < 70; // 쇼츠는 댓글창 구조가 달라 제외
};

/** ① 최신 연애 영상: 키워드 여러 개를 이번 주 · 업로드순으로 검색해 합치고 최신순 정렬 */
export async function latestVideos(cfg) {
  const lists = await Promise.allSettled(cfg.search.keywords.map((k) => search(k, 'week', 1)));
  const all = dedupe(lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))
    .filter((v) => !isShortish(v))
    .filter((v) => /연애|남자|여자|썸|이별|재회|짝사랑|남친|여친|고백|결혼|커플|사랑|데이트|소개팅|헤어|애인|연인|바람|호감|심리/.test(v.title));
  all.sort((a, b) => (a.hoursAgo ?? 1e9) - (b.hoursAgo ?? 1e9));
  return all.slice(0, cfg.search.max_results);
}

/** 가점: 뜨기 직전 영상 (조회수 min~max, 시간당 조회수 기준 이상) */
export async function risingVideos(cfg) {
  const r = cfg.rising;
  const lists = await Promise.allSettled([search(r.keyword, 'today', 3), search(r.keyword, 'week', 2), ...cfg.search.keywords.slice(1, 4).map((k) => search(k, 'today', 1))]);
  return dedupe(lists.flatMap((x) => (x.status === 'fulfilled' ? x.value : [])))
    .filter((v) => !isShortish(v))
    .map((v) => ({ ...v, viewsPerHour: Math.round(v.views / Math.max(v.hoursAgo ?? 1e9, 0.5)) }))
    .filter((v) => v.views >= r.min_views && v.views <= r.max_views && v.viewsPerHour >= r.min_views_per_hour)
    .sort((a, b) => b.viewsPerHour - a.viewsPerHour);
}

async function watchPage(id) {
  const html = await fetch(`https://www.youtube.com/watch?v=${id}&hl=ko&gl=KR`, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' }, signal: AbortSignal.timeout(20000) }).then((r) => r.text());
  const ver = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  if (ver) webVersion = ver[1];
  const grab = (name) => {
    const i = html.indexOf(`var ${name} = `);
    if (i < 0) return null;
    const start = i + name.length + 7;
    const end = html.indexOf(';</script>', start);
    try { return JSON.parse(html.slice(start, end).replace(/;\s*var meta = .*$/s, '')); } catch { return null; }
  };
  return { player: grab('ytInitialPlayerResponse'), data: grab('ytInitialData') };
}

/** 자막: 안드로이드 클라이언트의 자막 트랙(json3) → [{t초, text}] */
export async function fetchTranscript(id) {
  const p = await innertube('player', { videoId: id }, { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 });
  const tracks = p.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return { segments: [], kind: null };
  const ko = tracks.find((t) => t.languageCode === 'ko' && t.kind !== 'asr') || tracks.find((t) => t.languageCode === 'ko') || tracks[0];
  const url = ko.baseUrl.replace(/&fmt=[^&]*/, '') + '&fmt=json3';
  const j = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) }).then((r) => r.json()).catch(() => null);
  const segments = (j?.events || [])
    .filter((e) => e.segs)
    .map((e) => ({ t: Math.floor((e.tStartMs || 0) / 1000), text: e.segs.map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text);
  return { segments, kind: ko.kind === 'asr' ? '자동 생성' : '있음', lang: ko.languageCode };
}

/** 인기 댓글 (좋아요 많은 순) */
async function topCommentsKeyless(data, limit = 20) {
  // 댓글 영역(comment-item-section)의 토큰을 먼저, 없으면 나머지 토큰을 차례로
  const section = walk(data, 'itemSectionRenderer').find((s) => s.sectionIdentifier === 'comment-item-section');
  const primary = section ? walk(section, 'continuationCommand').map((c) => c.token) : [];
  const tokens = [...new Set([...primary, ...walk(data, 'continuationCommand').map((c) => c.token).reverse()])];
  for (const token of tokens.slice(0, 8)) {
    try {
      const res = await innertube('next', { continuation: token });
      const ents = walk(res, 'commentEntityPayload');
      if (!ents.length) continue;
      return ents
        .map((e) => ({ text: e.properties?.content?.content || '', likes: parseCount(e.toolbar?.likeCountNotliked || 0) }))
        .filter((c) => c.text)
        .sort((a, b) => b.likes - a.likes)
        .slice(0, limit);
    } catch { /* 다음 토큰 시도 */ }
  }
  return [];
}

async function topCommentsApi(id, limit = 20) {
  const d = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&order=relevance&maxResults=${limit}&videoId=${id}&key=${API_KEY()}`).then((r) => r.json());
  if (d.error) return [];
  return d.items.map((i) => ({ text: i.snippet.topLevelComment.snippet.textOriginal, likes: i.snippet.topLevelComment.snippet.likeCount })).sort((a, b) => b.likes - a.likes);
}

/** ② 분석용 영상 정보 한 번에 */
export async function videoDetail(id) {
  const { player, data } = await watchPage(id);
  const vd = player?.videoDetails || {};
  const mf = player?.microformat?.playerMicroformatRenderer || {};
  const publishDate = mf.publishDate || mf.uploadDate || null;
  const hoursAgo = publishDate ? (Date.now() - new Date(publishDate)) / 36e5 : null;
  const commentsDisabled = /댓글이 사용 중지|Comments are turned off/.test(JSON.stringify(walk(data, 'messageRenderer')));
  const getComments = async () => {
    if (commentsDisabled) return [];
    if (API_KEY()) return topCommentsApi(id);
    let c = await topCommentsKeyless(data).catch(() => []);
    if (!c.length) { const again = await watchPage(id).catch(() => null); if (again?.data) c = await topCommentsKeyless(again.data).catch(() => []); }
    return c;
  };
  const [transcript, comments] = await Promise.all([
    fetchTranscript(id).catch(() => ({ segments: [], kind: null })),
    getComments(),
  ]);
  return {
    id,
    title: vd.title || text(mf.title),
    channel: vd.author || mf.ownerChannelName || '',
    description: vd.shortDescription || text(mf.description) || '',
    views: +vd.viewCount || 0,
    lengthSeconds: +vd.lengthSeconds || 0,
    publishDate,
    hoursAgo,
    publishedText: agoLabel(hoursAgo),
    thumbnail: thumb(id),
    commentsDisabled,
    transcript,
    comments,
  };
}

/** 링크 직접 입력: 목록 카드 형태로 */
export async function videoCard(id) {
  const d = await videoDetail(id);
  const m = Math.floor(d.lengthSeconds / 60), s = d.lengthSeconds % 60;
  return { id, title: d.title, channel: d.channel, publishedText: d.publishedText, hoursAgo: d.hoursAgo, views: d.views, duration: `${m}:${String(s).padStart(2, '0')}`, thumbnail: d.thumbnail };
}
