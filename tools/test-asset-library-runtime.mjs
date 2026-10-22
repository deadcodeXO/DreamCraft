import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = join(import.meta.dirname, '..', 'target', 'release', 'dreamcraft.exe');
const edgeCandidates = [join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe')];
let edge;
for (const candidate of edgeCandidates) { try { await access(candidate); edge = candidate; break; } catch {} }
assert.ok(edge, 'Microsoft Edge is required for the editor runtime test.');

const server = spawn(executable, [], { env: { ...process.env, DREAMCRAFT_NO_BROWSER: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
server.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
let edgeProcess;
let socket;
let profile;
let origin;
let fixturePaths = [];
const port = 9300 + (process.pid % 1000);
const unique = `__asset-library-runtime-${process.pid}`;

async function waitFor(predicate, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput}`);
}

async function requestJson(url, method = 'GET', body) {
  const response = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${url} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}

let commandId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++commandId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression: `Promise.resolve((async()=>{${expression}})())`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text || JSON.stringify(response.result.exceptionDetails));
  return response.result?.result?.value;
}
async function pageEval(expression) {
  const result = await evaluate(expression);
  if (result?.error) throw new Error(result.error);
  return result;
}

try {
  const baseUrl = await waitFor(async () => {
    const match = serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) return match[0];
  }, 'DreamCraft loopback server');
  origin = new URL(baseUrl).origin;
  const pagePath = `pages/${unique}.html`;
  const cssPath = `styles/${unique}.css`;
  const uploadName = `${unique}.png`;
  const imagePath = `assets/${uploadName}`;
  fixturePaths = [pagePath, cssPath, imagePath];
  await requestJson(`${origin}/api/file/${pagePath}`, 'PUT', { content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Asset library runtime</title><link rel="stylesheet" href="../styles/${unique}.css"></head><body><main></main></body></html>` });
  await requestJson(`${origin}/api/file/${cssPath}`, 'PUT', { content: 'main { color: #222; }\n' });
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p3sAAAAASUVORK5CYII=', 'base64'));
  const form = new FormData();
  form.append('files', new File([png], uploadName, { type: 'image/png' }));
  const upload = await fetch(`${origin}/api/upload`, { method: 'POST', body: form });
  assert.equal(upload.status, 204, 'project asset upload endpoint must save image assets');

  profile = await mkdtemp(join(tmpdir(), 'dreamcraft-edge-'));
  edgeProcess = spawn(edge, [`--headless=new`, '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `${origin}/`], { windowsHide: true, stdio: 'ignore' });
  const targets = await waitFor(async () => {
    try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return null; }
  }, 'Edge DevTools page');
  const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
  assert.ok(page, 'Edge must expose a browser page over DevTools.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message);
    }
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(async () => pageEval(`return document.readyState === 'complete' && typeof openAssetLibrary === 'function'`), 'DreamCraft editor initialization');
  await pageEval(`await openFile(${JSON.stringify(pagePath)}); await openAssetLibrary(); return true`);
  const card = await waitFor(async () => pageEval(`return Array.from(document.querySelectorAll('.asset-card')).find(card=>card.textContent.includes(${JSON.stringify(uploadName)}))?.querySelector('.asset-preview img')?.complete ? true : false`), 'uploaded image preview');
  assert.equal(card, true);
  const imageDetails = await pageEval(`return (()=>{const card=Array.from(document.querySelectorAll('.asset-card')).find(card=>card.textContent.includes(${JSON.stringify(uploadName)}));return {dimensions:card.querySelector('.asset-meta').textContent,insert:!!Array.from(card.querySelectorAll('button')).find(button=>button.textContent==='Insert')}})()`);
  assert.match(imageDetails.dimensions, /1 × 1/);
  assert.equal(imageDetails.insert, true, 'HTML document should offer image insertion.');
  await pageEval(`(()=>{const card=Array.from(document.querySelectorAll('.asset-card')).find(card=>card.textContent.includes(${JSON.stringify(uploadName)}));card.querySelector('button.primary').click();document.querySelector('#newFileName').value='A functional runtime test image';document.querySelector('#confirmModal').click();return true})()`);
  const insertedHtml = await waitFor(async () => pageEval(`return editor.getValue().includes('A functional runtime test image') ? editor.getValue() : false`), 'HTML image insertion');
  assert.match(insertedHtml, /\.\.\/assets\/__asset-library-runtime-\d+\.png/);
  await pageEval(`await save(); true`);
  const savedHtml = await (await fetch(`${origin}/api/file/${pagePath}`)).text();
  assert.match(savedHtml, /alt="A functional runtime test image"/);

  await pageEval(`await openFile(${JSON.stringify(cssPath)}); await openAssetLibrary(); return true`);
  await pageEval(`return (()=>{const card=Array.from(document.querySelectorAll('.asset-card')).find(card=>card.textContent.includes(${JSON.stringify(uploadName)}));const button=Array.from(card.querySelectorAll('button')).find(button=>button.textContent==='Insert URL');if(!button)throw Error('CSS URL insertion action missing');button.click();return true})()`);
  const insertedCss = await waitFor(async () => pageEval(`return editor.getValue().includes('url("../assets/${uploadName}")') ? editor.getValue() : false`), 'CSS asset URL insertion');
  await pageEval('await save(); true');
  const savedCss = await (await fetch(`${origin}/api/file/${cssPath}`)).text();
  assert.match(insertedCss, /url\("\.\.\/assets\/__asset-library-runtime-\d+\.png"\)/);
  assert.match(savedCss, /url\("\.\.\/assets\/__asset-library-runtime-\d+\.png"\)/);

  const filters = await pageEval(`await openAssetLibrary(); document.querySelector('#assetLibrarySearch').value='${unique}'; document.querySelector('#assetLibrarySearch').dispatchEvent(new Event('input')); document.querySelector('#assetLibraryType').value='image'; document.querySelector('#assetLibraryType').dispatchEvent(new Event('change')); return {count:document.querySelectorAll('.asset-card').length,filtered:document.querySelector('#assetLibraryCount').textContent}`);
  assert.equal(filters.count, 1, 'search and image filtering should retain only the matching image');
  console.log(JSON.stringify({ result: 'passed', imageDimensions: imageDetails.dimensions, htmlImageInsertion: 'saved', cssUrlInsertion: 'saved', assetSearchAndTypeFilter: 'passed' }));
} finally {
  try { socket?.close(); } catch {}
  if (edgeProcess?.pid) {
    spawnSync('taskkill.exe', ['/PID', String(edgeProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    const escapedProfile = profile.replaceAll("'", "''");
    spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${escapedProfile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
    await delay(750);
  }
  if (profile) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rm(profile, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9 || error.code !== 'EBUSY' && error.code !== 'EPERM') throw error; await delay(250); }
    }
  }
  for (const path of fixturePaths) { try { await fetch(`${origin}/api/file/${path}`, { method: 'DELETE' }); } catch {} }
  if (server.pid) spawnSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
}
