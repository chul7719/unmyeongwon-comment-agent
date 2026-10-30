// AI 댓글 초안: 고민 정리 → 장면 고르기 → 시청자 페르소나 댓글
import { validateComment } from './rules.js';

const DEFAULT_MODEL = { gemini: 'gemini-2.5-flash', anthropic: 'claude-sonnet-4-5', openai: 'gpt-4.1-mini' };
const KEY_ENV = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

export function aiInfo() {
  const want = process.env.AI_PROVIDER?.trim();
  const order = want ? [want] : ['gemini', 'anthropic', 'openai'];
  const provider = order.find((p) => process.env[KEY_ENV[p]]?.trim());
  if (!provider) return null;
  return { provider, model: process.env.AI_MODEL?.trim() || DEFAULT_MODEL[provider] };
}

async function callModel(system, user, temperature = 0.9) {
  const info = aiInfo();
  if (!info) throw Object.assign(new Error('AI 키가 없어요. .env 에 GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY 중 하나를 넣고 다시 실행해 주세요.'), { code: 'NO_AI' });
  const key = process.env[KEY_ENV[info.provider]].trim();
  let r, j;
  if (info.provider === 'gemini') {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${info.model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature, responseMimeType: 'application/json' } }),
    });
    j = await r.json();
    if (!r.ok) throw new Error(`Gemini 오류: ${j.error?.message || r.status}`);
    return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  }
  if (info.provider === 'anthropic') {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: info.model, max_tokens: 1000, temperature, system, messages: [{ role: 'user', content: user }] }),
    });
    j = await r.json();
    if (!r.ok) throw new Error(`Claude 오류: ${j.error?.message || r.status}`);
    return j.content?.map((c) => c.text || '').join('') || '';
  }
  r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: info.model, temperature, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  j = await r.json();
  if (!r.ok) throw new Error(`OpenAI 오류: ${j.error?.message || r.status}`);
  return j.choices?.[0]?.message?.content || '';
}

function parseJson(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 응답을 읽지 못했어요');
  return JSON.parse(m[0]);
}

const mmss = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

// 자막을 [분:초] 줄로 묶고, 길면 앞·중간·끝을 고르게 남긴다
function transcriptText(segments, limit = 9000) {
  if (!segments?.length) return '';
  const lines = [];
  let cur = null;
  for (const s of segments) {
    if (!cur || s.t - cur.t >= 12) { cur = { t: s.t, text: s.text }; lines.push(cur); } else cur.text += ' ' + s.text;
  }
  let out = lines.map((l) => `[${mmss(l.t)}] ${l.text}`);
  let joined = out.join('\n');
  if (joined.length <= limit) return joined;
  const part = Math.floor(out.length / 3);
  const budget = Math.floor(limit / 3);
  const take = (arr) => { let acc = '', i = 0; while (i < arr.length && acc.length + arr[i].length < budget) acc += arr[i++] + '\n'; return acc; };
  return take(out.slice(0, part)) + '...\n' + take(out.slice(part, part * 2)) + '...\n' + take(out.slice(part * 2));
}

const SYSTEM = (cfg) => `너는 유튜브에서 연애 영상을 방금 끝까지 본 20~30대 한국인 시청자다. 영상 내용에 진심으로 공감해서 댓글을 남긴다.
목표: 이 댓글을 읽은 다른 시청자가 "나도 ${cfg.comment.brand}에서 연애 사주 한번 보고 싶다"는 마음이 들게 하는 것. 단, 광고처럼 보이면 실패다.

순서대로 생각해라.
1) worry: 영상이 다루는 연애 고민을 한 문장(40자 안팎)으로 정리한다. 영상 속 사연·상황이 드러나게.
2) scene: 이 영상에서만 나온 구체적인 장면이나 말을 하나 고른다. 자막이 있으면 실제 대사에 가깝게 따오고 time에 [분:초]를 적는다. 자막이 없으면 제목·설명·인기 댓글에서 고르고 time은 빈 문자열.
3) comment: 그 장면에 반응 → 내 연애 경험이나 감정(평범한 시청자의 경험) → "결국 인연/타이밍/운은 따로 있나" 같은 감정 → ${cfg.comment.brand} 연애사주를 '보고 싶다/궁금하다' 로 끝낸다.

comment 규칙 (모두 지켜라):
- 공백 포함 ${cfg.comment.min_chars}~${cfg.comment.max_chars}자. 80~105자를 목표로.
- scene 의 말이나 장면을 댓글 안에서 직접 짚는다 ("~라는 말", "~하는 부분", "N분쯤" 등).
- "${cfg.comment.brand}"를 정확히 한 번 쓴다. ${cfg.comment.brand}는 '연애 사주 잘 본다고 들은 곳'으로만 말한다 ("잘 본다던데", "유명하다던데", "한번 보고 싶다").
- 절대 금지: ${cfg.comment.brand}를 이용해 본 것처럼 쓰기(봤는데/받아봤는데/다녀왔는데/진짜 맞더라 등), 링크·URL·해시태그·@멘션, "강추/추천드려요/지금 바로" 같은 광고 말투, 영상 제목 그대로 반복.
- 유튜브 댓글 말투: 짧은 문장, 말줄임(..), ㅠㅠ/ㅋㅋ는 자연스러울 때 한 번 정도. 이모지는 쓰지 않는다.
- 인기 댓글의 분위기는 참고하되 문장을 베끼지 않는다. 이전에 단 댓글과 시작 문장·구성을 다르게 한다.

출력은 JSON 하나만: {"worry":"...","scene":{"time":"m:ss 또는 빈 문자열","quote":"...","keywords":["장면 핵심어 2~3개"]},"comment":"..."}

예시) 남자 심리 분석 영상 → "근데 진짜 남자심리는 알다가도 모르겠다...ㅠㅠ 맨날 연애하면 차이기만 했던 1인. 결국 심리 알기는 개뿔 그냥 인연이면 만나는 것 같아요. ${cfg.comment.brand} 연애사주가 그렇게 잘 본다던데 나도 언제 짝 만나는지 한번 보고 싶다."`;

function userPrompt(v, previous, feedback) {
  const tr = transcriptText(v.transcript?.segments);
  const comments = (v.comments || []).slice(0, 15).map((c, i) => `${i + 1}. (좋아요 ${c.likes}) ${c.text.replace(/\s+/g, ' ').slice(0, 150)}`).join('\n');
  return [
    `[영상 제목] ${v.title}`,
    `[채널] ${v.channel}`,
    `[설명] ${(v.description || '').slice(0, 1200)}`,
    tr ? `[자막 - ${v.transcript.kind}]\n${tr}` : '[자막] 없음 (제목·설명·댓글로 판단)',
    comments ? `[인기 댓글]\n${comments}` : '[인기 댓글] 없음',
    previous.length ? `[이전에 단 댓글 - 이것들과 다르게]\n${previous.slice(-8).map((p) => '- ' + p).join('\n')}` : '',
    feedback ? `[수정 요청] 직전 초안이 규칙에 어긋났다: ${feedback}. 규칙을 지켜 다시 써라.` : '',
  ].filter(Boolean).join('\n\n');
}

/** 영상 분석 + 규칙을 통과할 때까지 최대 3번 다시 쓰기 */
export async function draftComment(video, { cfg, previous = [] }) {
  let feedback = '', last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await callModel(SYSTEM(cfg), userPrompt(video, previous, feedback), attempt === 1 ? 0.9 : 0.7);
    const out = parseJson(raw);
    out.comment = String(out.comment || '').replace(/\s*\n\s*/g, ' ').trim();
    const v = validateComment(out.comment, { cfg, scene: out.scene, previous });
    last = { ...out, validation: v, attempts: attempt };
    if (v.allOk) return last;
    feedback = v.checks.filter((c) => !c.ok).map((c) => `${c.label}${c.detail ? `(${c.detail})` : ''}`).join(', ');
  }
  return last;
}
