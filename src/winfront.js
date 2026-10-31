// © 2026 윤신철 (github.com/chul7719). All rights reserved. 무단 복제·수정·상업적 사용 금지 — LICENSE 참고
// 크롬 창을 댓글 에이전트 화면보다 앞에(항상 위) 띄우기 - Windows 전용
// 창 없이 켠 서버가 연 크롬은 Windows 포커스 보호 때문에 뒤에 깔릴 수 있어서,
// 게시하는 동안만 '항상 위'로 올리고 끝나면 해제한다.
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPT = path.resolve('scripts', 'win-front.ps1');

function run(args) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { windowsHide: true });
    p.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 12000);
    p.on('close', () => { clearTimeout(t); const m = out.match(/OK (\d+)/); resolve(m ? m[1] : null); });
    p.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

/**
 * page 의 창을 맨 앞으로. 창을 찾으려고 잠깐 제목을 표식으로 바꿨다가 되돌린다.
 * @returns 창 번호(hwnd) - 나중에 해제할 때 사용. 실패하면 null
 */
export async function bringToTop(page, token) {
  if (process.platform !== 'win32') return null;
  try {
    // 유튜브가 제목을 다시 바꿔도 찾을 때까지 표식을 유지
    await page.evaluate((t) => {
      window.__umwTitle = document.title;
      document.title = t;
      window.__umwKeep = setInterval(() => { if (document.title !== t) document.title = t; }, 50);
    }, token);
    const hwnd = await run(['-Token', token, '-Top', '1']);
    await page.evaluate(() => {
      clearInterval(window.__umwKeep);
      if (window.__umwTitle) document.title = window.__umwTitle;
    }).catch(() => {});
    return hwnd;
  } catch { return null; }
}

export async function releaseTop(hwnd) {
  if (!hwnd) return;
  await run(['-Hwnd', String(hwnd), '-Top', '0']);
}
