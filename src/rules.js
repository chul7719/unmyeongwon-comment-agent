// © 2026 윤신철 (github.com/chul7719). All rights reserved. 무단 복제·수정·상업적 사용 금지 — LICENSE 참고
// 댓글 규칙 검사. 서버가 게시 직전에 반드시 다시 검사하므로 화면에서 우회할 수 없다.

const LINK = /(https?:\/\/|www\.|\b[\w-]+\.(com|net|kr|co|io|me|ly|site|shop)\b|youtu\.?be)/i;
const HASHTAG = /#[^\s#]+/;
const MENTION = /@[\w가-힣]/;
// 운명원을 직접 이용해 본 것처럼 쓰는 표현 (지어낸 후기 금지)
const REVIEW = [
  /운명원[^.!?~\n]{0,25}(봤는데|봤더니|봤어요|봤음|봤다|받았는데|받아봤|받아 봤|받고 왔|다녀왔|가봤|가 봤|상담 ?받|맞더라|맞았|맞춰|소름 돋|후기)/,
  /(봤는데|받아봤는데|다녀왔는데|상담받았는데|가봤는데)[^.!?\n]{0,20}운명원/,
  /운명원\s*(강추|추천합니다|추천드려요|추천해요|최고)/,
];

export const charCount = (s) => [...String(s || '').trim()].length;

function bigrams(s) {
  const t = String(s).replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

export function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// 장면 언급: AI가 고른 장면의 말이 댓글에 3글자 이상 겹치거나 장면 핵심어를 포함
// ("4분쨯 대사"처럼 타임스탬프만 있고 내용이 없으면 인정하지 않음)
function mentionsScene(textValue, scene) {
  if (!scene) return false;
  const c = textValue.replace(/\s+/g, '');
  const q = String(scene.quote || '').replace(/[\s"'“”‘’.,!?~]/g, '');
  for (let i = 0; i + 3 <= q.length; i++) if (c.includes(q.slice(i, i + 3))) return true;
  return (scene.keywords || []).some((k) => k && k.length >= 2 && c.includes(k.replace(/\s+/g, '')));
}

/**
 * @returns {{ok:boolean, checks:{key:string,label:string,ok:boolean,hard:boolean,detail?:string}[]}}
 * hard=true 인 항목이 하나라도 실패하면 게시 불가
 */
export function validateComment(textValue, { cfg, scene, previous = [] }) {
  const t = String(textValue || '').trim();
  const n = charCount(t);
  const { min_chars: min, max_chars: max, brand } = cfg.comment;
  const maxSim = previous.reduce((m, p) => Math.max(m, similarity(t, p)), 0);
  const brandCount = t.split(brand).length - 1;
  // 같은 말 반복(스팸처럼 보이는 댓글) — 4글자 이상 구간이 3번 이상 나오면 차단
  const compact = t.replace(/\s+/g, '');
  let repeated = false;
  for (let i = 0; i + 4 <= compact.length && !repeated; i++) {
    const piece = compact.slice(i, i + 4);
    if (/^[ㄱ-ㅎㅏ-ㅣ.~!?]+$/.test(piece)) continue; // ㅋㅋㅋㅋ, ㅠㅠㅠㅠ, ... 는 허용
    if (compact.split(piece).length - 1 >= 3) repeated = true;
  }
  const checks = [
    { key: 'length', label: `${min}~${max}자`, ok: n >= min && n <= max, hard: true, detail: `${n}자` },
    { key: 'brand', label: `${brand} 한 번 언급`, ok: brandCount === 1, hard: true, detail: `${brandCount}번` },
    { key: 'norepeat', label: '같은 말 반복 없음', ok: !repeated, hard: true },
    { key: 'scene', label: '장면 언급', ok: mentionsScene(t, scene), hard: false },
    { key: 'nolink', label: '링크·해시태그 없음', ok: !LINK.test(t) && !HASHTAG.test(t) && !MENTION.test(t), hard: true },
    { key: 'noreview', label: '지어낸 후기 아님', ok: !REVIEW.some((r) => r.test(t)), hard: true },
    { key: 'unique', label: '다른 댓글과 다름', ok: maxSim < 0.45, hard: true, detail: `유사도 ${Math.round(maxSim * 100)}%` },
  ];
  return { ok: checks.every((c) => !c.hard || c.ok), allOk: checks.every((c) => c.ok), checks, count: n };
}
