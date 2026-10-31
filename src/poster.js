// ③ 크롬 프로필을 열어 댓글을 한 글자씩 입력 → 게시 → 내 댓글 확인
// 크롬은 평소 쓰는 기본 프로필의 자동 제어를 막으므로, 프로젝트 안 profiles/<이름> 폴더를
// 별도 user-data-dir 로 쓰는 "전용 크롬 프로필"을 만든다. (launchPersistentContext)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { SHOTS } from './store.js';
import { bringToTop, releaseTop } from './winfront.js';

export const PROFILES_DIR = path.resolve('profiles');
export const profileDir = (name) => path.join(PROFILES_DIR, name);

const open = new Set(); // 지금 열려 있는 프로필 (같은 폴더를 두 번 열 수 없음)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export class StepError extends Error {
  constructor(message, { posted = false } = {}) { super(message); this.posted = posted; }
}

export function chromePath() {
  const c = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  return c.find((p) => fs.existsSync(p)) || null;
}

/** 계정 설정용: 자동 제어 없이 일반 크롬으로 프로필을 열어 사용자가 직접 구글 로그인 */
export function openForLogin(name) {
  const exe = chromePath();
  if (!exe) throw new Error('크롬을 찾지 못했어요. .env 의 CHROME_PATH 를 지정해 주세요.');
  if (open.has(name)) throw new Error(`${name} 프로필이 이미 열려 있어요`);
  fs.mkdirSync(profileDir(name), { recursive: true });
  const child = spawn(exe, [`--user-data-dir=${profileDir(name)}`, '--lang=ko', '--no-first-run', '--no-default-browser-check',
    'https://accounts.google.com/ServiceLogin?hl=ko&continue=https%3A%2F%2Fwww.youtube.com%2F%3Fhl%3Dko'], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** 계정 클릭: 그 크롬 프로필로 유튜브를 별도 창(일반 크롬)으로 열고 대시보드 앞에 띄운다 */
export async function openYouTube(name) {
  const exe = chromePath();
  if (!exe) throw new Error('크롬을 찾지 못했어요. .env 의 CHROME_PATH 를 지정해 주세요.');
  if (open.has(name)) throw new Error(`${name} 프로필로 게시 중이에요. 끝난 뒤 열어 주세요`);
  if (!fs.existsSync(profileDir(name))) throw new Error(`${name}은 아직 로그인한 적이 없어요`);
  const child = spawn(exe, [`--user-data-dir=${profileDir(name)}`, '--lang=ko', '--no-first-run', '--no-default-browser-check', '--new-window',
    '--window-size=1280,900', '--window-position=80,40', 'https://www.youtube.com/?hl=ko'], { detached: true, stdio: 'ignore' });
  child.unref();
  if (process.platform === 'win32') {
    // 창이 대시보드 뒤에 깔리지 않게 앞으로 (잠깐 '항상 위' 후 해제)
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts', 'front-by-profile.ps1'), '-Dir', profileDir(name)], { windowsHide: true, stdio: 'ignore' });
    setTimeout(() => { try { ps.kill(); } catch {} }, 15000);
  }
}

async function launch(name, { headless = false, win = null } = {}) {
  // 바로 앞 작업이 크롬을 닫는 중일 수 있어 최대 15초 기다린다
  for (let i = 0; i < 60 && open.has(name); i++) await sleep(250);
  if (open.has(name)) throw new StepError(`${name} 프로필이 이미 사용 중이에요`);
  fs.mkdirSync(profileDir(name), { recursive: true });
  open.add(name);
  try {
    const exe = chromePath();
    return await chromium.launchPersistentContext(profileDir(name), {
      ...(exe ? { executablePath: exe } : { channel: 'chrome' }),
      headless,
      chromiumSandbox: true, // --no-sandbox 경고줄이 뜨지 않게
      viewport: null,
      locale: 'ko-KR',
      // 팝업처럼 정해진 크기·위치로 연다 (config.json 의 chrome_window)
      args: ['--lang=ko-KR', ...(win ? [`--window-size=${win.width},${win.height}`, `--window-position=${win.x},${win.y}`] : ['--start-maximized']), '--no-first-run', '--no-default-browser-check'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (e) {
    open.delete(name);
    const msg = /lock|in use|ProcessSingleton|exitCode=21/i.test(e.message)
      ? `${name} 프로필 크롬 창이 이미 열려 있어요. 그 창을 닫고 다시 눌러 주세요`
      : `크롬 프로필을 열지 못했어요: ${e.message.split('\n')[0]}`;
    throw new StepError(msg);
  }
}

async function close(name, ctx) {
  try { await ctx?.close(); } catch {}
  open.delete(name);
}

/** 로그인 확인: 창을 띄우지 않고 유튜브의 로그인 상태값을 읽는다 */
export async function checkLogin(name) {
  if (!fs.existsSync(profileDir(name))) return { loggedIn: false, note: '프로필 없음' };
  const ctx = await launch(name, { headless: true });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://www.youtube.com/?hl=ko', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.ytcfg?.get?.('LOGGED_IN') !== undefined, null, { timeout: 15000 });
    const loggedIn = await page.evaluate(() => !!window.ytcfg.get('LOGGED_IN'));
    return { loggedIn };
  } finally { await close(name, ctx); }
}

/**
 * 로그아웃: ① 창을 띄우지 않고 구글 로그아웃 주소를 열어 세션을 끊고
 * ② 전용 프로필 폴더(쿠키 포함)를 지운다. 평소 쓰는 크롬 프로필은 건드리지 않는다.
 */
export async function logoutProfile(name) {
  const dir = profileDir(name);
  if (!fs.existsSync(dir)) return { removed: false };
  if (open.has(name)) throw new Error(`${name} 프로필이 지금 사용 중이에요. 끝난 뒤 다시 눌러 주세요`);
  const ctx = await launch(name, { headless: true }); // 창이 열려 있으면 여기서 '창을 닫아 달라'는 오류
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://accounts.google.com/Logout?hl=ko&continue=https%3A%2F%2Fwww.youtube.com%2F', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(1500);
  } finally { await close(name, ctx); }
  for (let i = 0; ; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (e) {
      if (i >= 6) throw new Error(`${name} 프로필 파일을 지우지 못했어요. 그 프로필의 크롬 창을 모두 닫고 다시 눌러 주세요`);
      await sleep(700);
    }
  }
  return { removed: true };
}

const norm = (s) => String(s || '').replace(/\s+/g, '');

/**
 * 댓글 게시. onStep(step, extra) 로 진행 상황을 알린다.
 * step: open → navigate → typing → post → verify → done
 */
export async function postComment({ profile, videoId, text, cfg, onStep, shotName, dryRun = false }) {
  const t0 = Date.now();
  const lap = (() => { let last = t0; return () => { const n = Date.now(); const d = n - last; last = n; return d; }; })();
  let ctx, page, posted = false, hwnd = null;
  const shot = async (suffix) => {
    if (!page) return null;
    const file = `${shotName}-${suffix}.png`;
    try { await page.screenshot({ path: path.join(SHOTS, file) }); return file; } catch { return null; }
  };
  try {
    onStep('open');
    ctx = await launch(profile, { win: cfg.chrome_window || { width: 1280, height: 900, x: 60, y: 30 } });
    page = ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront();
    // 대시보드보다 앞에 보이도록 '항상 위'로 (페이지를 열기 전 빈 화면일 때 창을 찾음, 끝나면 해제)
    hwnd = await bringToTop(page, `UMW-AGENT-${shotName}`);
    if (!hwnd) hwnd = await bringToTop(page, `UMW-AGENT-${shotName}-2`);
    console.log(`[크롬 창] ${profile} 맨 앞 띄우기: ${hwnd ? '성공' : '실패'}`);
    onStep('navigate', { ms: lap() });

    await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=ko&persist_hl=1`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => window.ytcfg?.get?.('LOGGED_IN') !== undefined, null, { timeout: 20000 });
    if (!(await page.evaluate(() => !!window.ytcfg.get('LOGGED_IN'))))
      throw new StepError(`${profile} 프로필이 구글에 로그인돼 있지 않아요. 상단 [계정 설정]에서 로그인해 주세요`);
    // 소리 끄고 멈춤 (시연 화면 정리)
    await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.pause(); } }).catch(() => {});

    // 댓글 영역까지 천천히 내려가기
    const placeholder = page.locator('ytd-comments #simplebox-placeholder').first();
    let found = false;
    for (let i = 0; i < 30 && !found; i++) {
      await page.mouse.wheel(0, 450);
      await sleep(400);
      const disabled = await page.locator('ytd-comments ytd-message-renderer, ytd-comments #message').first().textContent({ timeout: 300 }).catch(() => '');
      if (/사용 중지|turned off/.test(disabled || '')) throw new StepError('댓글 사용이 중지된 영상이에요');
      found = await placeholder.isVisible().catch(() => false);
    }
    if (!found) throw new StepError('댓글 입력 칸을 찾지 못했어요 (유튜브 화면이 바뀌었거나 로딩이 늦어요)');
    await placeholder.click();
    const editor = page.locator('ytd-comments #contenteditable-root').first();
    await editor.waitFor({ state: 'visible', timeout: 10000 });
    // 입력 칸을 창 가운데로 (시연 화면에서 잘 보이게)
    await editor.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' })).catch(() => {});
    await sleep(600);
    await editor.click();

    // 한 글자씩 타이핑
    // 새 영상(댓글 0개 등)에서는 유튜브가 댓글 영역을 한 번 더 그리면서 입력 칸이 바뀌어 친 글자가 사라질 수 있다.
    // → 입력 칸이 안정될 때까지 잠깐 기다리고, 글자마다 '지금의' 입력 칸에 넣으며, 어긋나면 지우고 한 번 더 입력한다.
    const chars = [...text];
    onStep('typing', { ms: lap(), typed: 0, total: chars.length });
    const ensureEditor = async () => {
      if (!(await editor.isVisible().catch(() => false))) {
        await placeholder.scrollIntoViewIfNeeded().catch(() => {});
        await placeholder.click().catch(() => {});
        await editor.waitFor({ state: 'visible', timeout: 10000 });
      }
      await editor.click();
    };
    await sleep(1500);
    let typedOk = false;
    for (let attempt = 1; attempt <= 2 && !typedOk; attempt++) {
      await ensureEditor();
      if (attempt > 1) {
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await sleep(400);
        onStep('typing', { typed: 0, total: chars.length, retry: true });
      }
      for (let i = 0; i < chars.length; i++) {
        await editor.pressSequentially(chars[i]); // 매번 현재 입력 칸을 다시 찾아 넣음
        const ch = chars[i];
        await sleep(rand(cfg.typing.min_delay_ms, cfg.typing.max_delay_ms) + (/[.,!?ㅠㅋ~]/.test(ch) ? 120 : 0) + (ch === ' ' ? 40 : 0));
        if (i % 2 === 1 || i === chars.length - 1) onStep('typing', { typed: i + 1, total: chars.length });
      }
      await sleep(500);
      typedOk = norm(await editor.innerText().catch(() => '')) === norm(text);
      if (!typedOk) console.log(`[입력 확인] ${attempt}번째 입력이 초안과 달라 ${attempt < 2 ? '지우고 다시 입력' : '중단'}`);
    }
    if (!typedOk) throw new StepError('입력된 글자가 초안과 달라요 (두 번 시도). 게시하지 않았어요');

    onStep('post', { ms: lap() });
    if (dryRun) {
      // 리허설: 게시하지 않고 입력한 글을 지운 뒤 끝낸다
      const rShot = await shot('rehearsal');
      await sleep(1200);
      await editor.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      onStep('done', { ms: lap(), dryRun: true, shot: rShot, totalMs: Date.now() - t0 });
      await sleep(1500);
      return { dryRun: true, shot: rShot };
    }
    const submit = page.locator('ytd-comments ytd-commentbox #submit-button button').first();
    await submit.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction((el) => !el.disabled, await submit.elementHandle(), { timeout: 5000 });
    await sleep(600);
    await submit.click();
    posted = true;

    // 확인: 내 댓글이 목록에 나타나는지
    onStep('verify', { ms: lap() });
    const key = norm(text).slice(0, 25);
    const handle = await page.waitForFunction((k) => {
      const threads = [...document.querySelectorAll('ytd-comments ytd-comment-thread-renderer')].slice(0, 6);
      return threads.find((t) => (t.querySelector('#content-text')?.textContent || '').replace(/\s+/g, '').startsWith(k)) || null;
    }, key, { timeout: 20000 }).catch(() => null);
    if (!handle) throw new StepError('게시 버튼은 눌렀지만 댓글 목록에서 내 댓글을 찾지 못했어요', { posted: true });
    const el = handle.asElement();
    await el.scrollIntoViewIfNeeded();
    await el.evaluate((n) => { n.style.outline = '3px solid #BE185D'; n.style.outlineOffset = '6px'; n.style.borderRadius = '8px'; });
    const href = await el.evaluate((n) => n.querySelector('#published-time-text a')?.getAttribute('href') || '');
    const commentUrl = href ? new URL(href, 'https://www.youtube.com').href : `https://www.youtube.com/watch?v=${videoId}`;
    await sleep(800);
    const okShot = await shot('ok');
    onStep('done', { ms: lap(), commentUrl, shot: okShot, totalMs: Date.now() - t0 });
    await sleep(cfg.keep_browser_open_ms);
    return { commentUrl, shot: okShot };
  } catch (e) {
    const failShot = await shot('fail');
    const err = e instanceof StepError ? e : new StepError(`예상치 못한 오류: ${String(e.message).split('\n')[0]}`, { posted });
    err.posted = err.posted || posted;
    err.shot = failShot;
    await sleep(1500);
    throw err;
  } finally {
    await releaseTop(hwnd);
    await close(profile, ctx);
  }
}
