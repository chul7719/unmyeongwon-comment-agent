// AI 댓글 초안: 고민 정리 → 장면 고르기 → 시청자 페르소나 댓글
import dotenv from 'dotenv';
import { validateComment } from './rules.js';

const DEFAULT_MODEL = { gemini: 'gemini-3.5-flash', anthropic: 'claude-sonnet-4-5', openai: 'gpt-4.1-mini' };
// 무료 한도에서는 사용량이 몰리면 503/429 가 자주 나서, 막히면 다음 모델로 넘어간다
const GEMINI_FALLBACK = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];
const KEY_ENV = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
let lastUsedModel = null;

// .env 를 고치면 서버를 다시 켜지 않아도 바로 반영
function reloadEnv() { try { dotenv.config({ override: true, quiet: true }); } catch {} }

export function aiInfo() {
  reloadEnv();
  const want = process.env.AI_PROVIDER?.trim();
  const order = want ? [want] : ['gemini', 'anthropic', 'openai'];
  const provider = order.find((p) => process.env[KEY_ENV[p]]?.trim());
  if (!provider) return null;
  const model = process.env.AI_MODEL?.trim() || DEFAULT_MODEL[provider];
  return { provider, model, lastUsed: lastUsedModel };
}

async function callGemini(key, primary, system, user, temperature) {
  // 마지막으로 성공한 모델을 먼저 시도 (불필요한 503 대기 줄이기)
  const chain = [...new Set([lastUsedModel, primary, ...GEMINI_FALLBACK].filter(Boolean))];
  const errors = [];
  for (const model of chain) {
    const t0 = Date.now();
    const dbg = (msg) => process.env.AI_DEBUG && console.log(`  [AI] ${model} ${msg} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const isG3 = /gemini-3|latest/.test(model);
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature, responseMimeType: 'application/json', ...(isG3 ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) },
    };
    try {
      let r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
      });
      let j = await r.json();
      if (r.status === 400 && isG3 && /thinking/i.test(j.error?.message || '')) {
        delete body.generationConfig.thinkingConfig;
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
        j = await r.json();
      }
      if (r.ok) {
        const out = j.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text).join('') || '';
        dbg('ok');
        if (out) { lastUsedModel = model; return out; }
        errors.push(`${model}: 빈 응답`);
        continue;
      }
      dbg(`HTTP ${r.status} ${(j.error?.message || '').slice(0, 80)}`);
      errors.push(`${model}: ${r.status}`);
      if (r.status === 400 || r.status === 401 || r.status === 403) throw new Error(`Gemini 오류: ${j.error?.message || r.status}`); // 키 문제는 다른 모델로도 안 됨
    } catch (e) {
      if (/Gemini 오류/.test(e.message)) throw e;
      dbg(`예외 ${e.name} ${e.message}`);
      errors.push(`${model}: ${e.name === 'TimeoutError' ? '시간 초과' : e.message}`);
    }
  }
  throw new Error(`Gemini 모델이 모두 응답하지 않았어요 (사용량 많음). 잠시 후 다시 시도해 주세요. [${errors.join(', ')}]`);
}

async function callModel(system, user, temperature = 0.9) {
  const info = aiInfo();
  if (!info) throw Object.assign(new Error('AI 키가 없어요. .env 에 GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY 중 하나를 넣고 다시 실행해 주세요.'), { code: 'NO_AI' });
  const key = process.env[KEY_ENV[info.provider]].trim();
  let r, j;
  if (info.provider === 'gemini') return callGemini(key, info.model, system, user, temperature);
  lastUsedModel = info.model;
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

// 말투(페르소나) 안내문. persona 가 'auto' 면 영상에 어울리는 말투를 AI 가 고른다 (최근 쓴 말투는 피함)
function personaBlock(cfg, persona, recent = []) {
  const list = cfg.personas || [];
  const p = list.find((x) => x.id === persona);
  if (p) return `[말투: ${p.name}] ${p.guide}\n말투 예시(그대로 베끼지 말 것): "${p.example}"\n세 후보 모두 이 말투로 쓴다. persona 값은 "${p.id}".`;
  if (!list.length) return '';
  const avoid = recent.filter(Boolean).slice(-2);
  return `[말투] 아래 중 이 영상의 시청자층과 분위기에 가장 어울리는 말투 하나를 골라 세 후보 모두 그 말투로 쓴다.${avoid.length ? ` 최근에 쓴 말투(${avoid.join(', ')})는 가능하면 피한다.` : ''}\n` +
    list.map((x) => `- ${x.id} (${x.name}): ${x.guide}`).join('\n') + '\n고른 말투의 id 를 persona 값에 적는다.';
}

const SYSTEM = (cfg, persona = 'auto', recent = []) => `너는 유튜브에서 연애 영상을 방금 끝까지 본 한국인 시청자다. 영상 내용에 진심으로 공감해서 댓글을 남긴다.
${personaBlock(cfg, persona, recent)}
목표: 이 댓글을 읽은 다른 시청자가 "나도 ${cfg.comment.brand}에서 연애 사주 한번 보고 싶다"는 마음이 들게 하는 것. 단, 광고처럼 보이면 실패다.

순서대로 생각해라.
1) worry: 영상이 다루는 연애 고민을 한 문장(40자 안팎)으로 정리한다. 영상 속 사연·상황이 드러나게.
2) scene: 이 영상에서만 나온 구체적인 장면이나 말을 하나 고른다. 자막이 있으면 실제 대사에 가깝게 따오고 time에 [분:초]를 적는다. 자막이 없으면 제목·설명·인기 댓글에서 고르고 time은 빈 문자열.
3) comments: 길이가 다른 댓글 후보 3개를 쓴다 (약 70자 / 약 90자 / 약 105자). 각 후보는 그 장면에 반응 → 내 연애 경험이나 감정(평범한 시청자의 경험) → "결국 인연/타이밍/운은 따로 있나" 같은 감정 → ${cfg.comment.brand} 연애사주를 '보고 싶다/궁금하다' 로 끝낸다.

comments 규칙 (모두 지켜라):
- 공백 포함 ${cfg.comment.min_chars}~${cfg.comment.max_chars}자. ${cfg.comment.max_chars}자를 넘으면 무조건 탈락이다. 문장을 3~4개로 짧게.
- scene 의 말이나 장면을 댓글 안에서 직접 짚는다 ("~라는 말", "~하는 부분", "N분쯤" 등).
- 장면을 가리킬 때는 "4:12" 또는 "4분쯤"처럼 짧게. "4분 12초에"처럼 길게 쓰지 않는다. 타임스탬프 없이 대사만 짚어도 된다.
- "${cfg.comment.brand}"를 정확히 한 번 쓴다. ${cfg.comment.brand}는 '연애 사주 잘 본다고 들은 곳'으로만 말한다 ("잘 본다던데", "유명하다던데", "한번 보고 싶다").
- 절대 금지: ${cfg.comment.brand}를 이용해 본 것처럼 쓰기(봤는데/받아봤는데/다녀왔는데/진짜 맞더라 등), 링크·URL·해시태그·@멘션, "강추/추천드려요/지금 바로" 같은 광고 말투, 영상 제목 그대로 반복.
- 유튜브 댓글답게 짧은 문장으로. ㅠㅠ/ㅋㅋ 양은 위 말투를 따른다. 이모지는 쓰지 않는다.
- 넘어가는 표현을 매번 바꾼다. "타이밍이랑 운"만 반복하지 말고 영상 주제에 맞게 고른다 (예: "될 사람은 결국 되는 건지", "이 사람이랑 나랑 맞기는 한 건지", "내 짝은 언제 오는지", "다시 만날 인연인지", "올해 안에 연애운이 있긴 한지"). ${cfg.comment.brand} 문장도 매번 다르게 끝낸다.
- 인기 댓글의 분위기는 참고하되 문장을 베끼지 않는다. 이전에 단 댓글과 시작 문장·구성을 다르게 한다.

출력은 JSON 하나만: {"persona":"말투 id","worry":"...","scene":{"time":"m:ss 또는 빈 문자열","quote":"...","keywords":["장면 핵심어 2~3개"]},"comments":["약 70자","약 90자","약 105자"]}

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

// 후보 점수: 필수 규칙 통과 > 장면 언급 > 90자에 가까운 길이
function score(v) {
  const hardFails = v.checks.filter((c) => c.hard && !c.ok).length;
  const softFails = v.checks.filter((c) => !c.hard && !c.ok).length;
  return hardFails * 1000 + softFails * 100 + Math.abs(v.count - 92);
}

/** 영상 분석 → 후보 3개 → 규칙을 모두 통과하는 가장 좋은 후보. 없으면 어긴 점을 알려 주고 최대 3번 */
export async function draftComment(video, { cfg, previous = [], persona = 'auto', recentPersonas = [] }) {
  let feedback = '', best = null;
  const ids = (cfg.personas || []).map((p) => p.id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await callModel(SYSTEM(cfg, persona, recentPersonas), userPrompt(video, previous, feedback), attempt === 1 ? 0.9 : 0.7);
    const out = parseJson(raw);
    // 말투를 직접 골랐으면 그것을, 자동이면 AI 가 고른 것을 (목록에 없으면 빈 값)
    out.persona = ids.includes(persona) ? persona : ids.includes(out.persona) ? out.persona : null;
    const list = (Array.isArray(out.comments) ? out.comments : [out.comment]).map((c) => String(c || '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    for (const comment of list) {
      const v = validateComment(comment, { cfg, scene: out.scene, previous });
      const cand = { persona: out.persona, worry: out.worry, scene: out.scene, comment, validation: v, attempts: attempt, candidates: list.length };
      if (!best || score(v) < score(best.validation)) best = cand;
    }
    if (best?.validation.allOk) return best;
    const fails = list.map((c) => validateComment(c, { cfg, scene: out.scene, previous }))
      .map((v, i) => `후보${i + 1}: ${v.checks.filter((c) => !c.ok).map((c) => `${c.label}${c.detail ? `(${c.detail})` : ''}`).join(', ') || '통과'}`);
    feedback = fails.join(' / ') + `. 길이는 반드시 ${cfg.comment.max_chars}자 이하, 문장을 더 짧게`;
  }
  return best;
}
