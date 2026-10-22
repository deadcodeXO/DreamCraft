const byId = id => document.getElementById(id);
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  const button = byId('themeToggle');
  if (!button) return;
  const label = light ? 'Switch to dark theme' : 'Switch to light theme';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(light));
  button.innerHTML = light
    ? '<svg viewBox="0 0 24 24" fill="none"><path d="M20.5 15.1A8.6 8.6 0 0 1 8.9 3.5 8.7 8.7 0 1 0 20.5 15.1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  try { localStorage.setItem('dreamcraft.theme', light ? 'light' : 'dark'); } catch {}
}
const frame = byId('preview');
const frameBox = byId('previewFrame');
const canvas = byId('canvas');
const textarea = byId('editor');
let editor;
let activePath = 'index.html';
let editorPath = null;
const historyByPath = new Map();
const cursorByPath = new Map();
let openTabs = ['index.html'];
let activeView = 'design';
let previewBasePath = 'index.html';
let dirty = false;
let loading = false;
let editVersion = 0;
let saveTimer;
let previewTimer;
let toastTimer;
let selectedNode = 0;
let searchMatches = [];
let searchRequestId = 0;
let replacePreview = [];
let projectEntries = [];
let completionSourceByPath = new Map();
let completionIndex = { classes: [], ids: [], variables: [], properties: [], identifiers: [], phpSymbols: [] };
let completionIndexTimer;
let completionIndexRevision = 0;
let lastPublishUrl = '';
let modalAction = null;
let filterAssets = false;
let insertUploadedImage = false;
let assetLibraryEntries = [];
let aiHistory = [];
let aiBusy = false;
let aiConfigured = false;
let aiMode = 'chat';
let aiRequestController = null;
let aiContextEntries = [];
let gitRepository = false;
let webdavCompareEntries = [];
let sftpRemoteDirectory = '';
let sftpRemoteEntries = [];
let sftpComparedTarget = null;
let ftpCompareEntries = [];
let remoteAction = null;
let ftpComparedTarget = null;
let webdavComparedTarget = null;
let templateRegionState = null;
let templateRegionMarks = new Map();
let codeSnippets = [];
let selectedSnippetId = null;
let snippetEditorDirty = false;
const collapsedFolders = new Set();
let commandPaletteOpen = false;
let commandSelection = 0;
const starterPages = {
  studio: {
    label: 'Northline · Design studio',
    path: 'pages/studio.html',
    description: 'A complete studio website with responsive navigation, selected case studies, a clear process, and working section links.'
  },
  product: {
    label: 'Field Notes · Product collection',
    path: 'pages/collection.html',
    description: 'A finished product collection with editorial product cards, responsive layouts, and useful in-page navigation.'
  },
  journal: {
    label: 'The Long Weekend · Editorial journal',
    path: 'pages/journal.html',
    description: 'A responsive editorial front page with a feature story, article grid, accessible navigation, and complete page styling.'
  }
};

function toast(message) {
  const el = byId('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function sourceLine(needle) {
  if (!needle) return 0;
  const offset = source().indexOf(needle);
  return offset < 0 ? 0 : source().slice(0, offset).split('\n').length - 1;
}

let liveDiagnosticsEnabled = (() => { try { return localStorage.getItem('dreamcraft.live-diagnostics') !== 'false'; } catch { return true; } })();
let liveDiagnosticsTimer = null;
let liveDiagnosticsRevision = 0;
let liveDiagnosticsPanelOpen = false;

function installLiveDiagnostics() {
  if (byId('liveDiagnosticsToggle')) return;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'liveDiagnosticsToggle';
  toggle.className = 'btn live-diagnostics-toggle';
  toggle.setAttribute('aria-pressed', String(liveDiagnosticsEnabled));
  byId('checkPage').insertAdjacentElement('afterend', toggle);

  const panel = document.createElement('section');
  panel.id = 'liveDiagnosticsPanel';
  panel.className = 'live-diagnostics hide';
  panel.setAttribute('aria-label', 'Live code diagnostics');
  const header = document.createElement('header');
  header.className = 'live-diagnostics-head';
  const title = document.createElement('strong');
  title.textContent = 'Live diagnostics';
  const count = document.createElement('span');
  count.id = 'liveDiagnosticsCount';
  count.className = 'live-diagnostics-count';
  const spacer = document.createElement('span');
  spacer.className = 'live-diagnostics-spacer';
  const clear = document.createElement('button');
  clear.type = 'button'; clear.id = 'liveDiagnosticsClear'; clear.textContent = 'Clear';
  const close = document.createElement('button');
  close.type = 'button'; close.id = 'liveDiagnosticsClose'; close.setAttribute('aria-label', 'Close diagnostics panel'); close.textContent = '×';
  header.append(title, count, spacer, clear, close);
  const list = document.createElement('div');
  list.id = 'liveDiagnosticsList';
  list.className = 'live-diagnostics-list';
  list.setAttribute('aria-live', 'polite');
  panel.append(header, list);
  document.querySelector('.main').insertBefore(panel, document.querySelector('.bottom-status'));

  toggle.addEventListener('click', () => {
    liveDiagnosticsEnabled = !liveDiagnosticsEnabled;
    try { localStorage.setItem('dreamcraft.live-diagnostics', String(liveDiagnosticsEnabled)); } catch {}
    if (!liveDiagnosticsEnabled) {
      clearTimeout(liveDiagnosticsTimer);
      liveDiagnosticsRevision++;
      clearLiveDiagnostics();
    } else scheduleLiveDiagnostics();
    updateLiveDiagnosticsToggle();
  });
  clear.addEventListener('click', clearLiveDiagnostics);
  close.addEventListener('click', () => {
    liveDiagnosticsPanelOpen = false;
    panel.classList.add('hide');
  });
  updateLiveDiagnosticsToggle();
}

function updateLiveDiagnosticsToggle(issueCount = 0) {
  const button = byId('liveDiagnosticsToggle');
  if (!button) return;
  button.classList.toggle('disabled', !liveDiagnosticsEnabled);
  button.setAttribute('aria-pressed', String(liveDiagnosticsEnabled));
  button.textContent = `Live checks ${liveDiagnosticsEnabled ? 'On' : 'Off'}${issueCount ? ` · ${issueCount}` : ''}`;
  button.title = liveDiagnosticsEnabled ? 'Check the current file after edits' : 'Live checks are off; click to enable';
}

function clearLiveDiagnostics() {
  liveDiagnosticsPanelOpen = false;
  byId('liveDiagnosticsPanel')?.classList.add('hide');
  const list = byId('liveDiagnosticsList');
  if (list) list.replaceChildren();
  const count = byId('liveDiagnosticsCount');
  if (count) count.textContent = '';
  updateLiveDiagnosticsToggle();
}

function renderLiveDiagnostics(issues, path) {
  const list = byId('liveDiagnosticsList');
  const count = byId('liveDiagnosticsCount');
  if (!list || !count) return;
  list.replaceChildren();
  count.textContent = `${issues.length} ${issues.length === 1 ? 'finding' : 'findings'} · ${path}`;
  updateLiveDiagnosticsToggle(issues.length);
  if (issues.length) liveDiagnosticsPanelOpen = true;
  if (!issues.length) {
    const clean = document.createElement('div');
    clean.className = 'live-diagnostics-empty';
    clean.textContent = `${path} · No issues found by the enabled live checks.`;
    list.appendChild(clean);
  } else {
    for (const issue of issues) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'live-diagnostic-row';
      row.setAttribute('aria-label', `${issue.severity}, ${path}, line ${issue.line + 1}: ${issue.message}`);
      const file = document.createElement('span'); file.className = 'live-diagnostic-path'; file.textContent = path;
      const line = document.createElement('span'); line.className = 'live-diagnostic-line'; line.textContent = `Line ${issue.line + 1}`;
      const message = document.createElement('span'); message.className = `live-diagnostic-severity ${issue.severity}`; message.textContent = `${issue.severity} · ${issue.message}`;
      row.append(file, line, message);
      row.addEventListener('click', async () => {
        if (activePath !== path) await openFile(path);
        if (activePath !== path) return;
        setView('code');
        editor.setCursor({ line: Math.min(issue.line, editor.lastLine()), ch: 0 });
        editor.focus();
        editor.scrollIntoView({ line: Math.min(issue.line, editor.lastLine()), ch: 0 }, 100);
      });
      list.appendChild(row);
    }
  }
  byId('liveDiagnosticsPanel').classList.toggle('hide', !liveDiagnosticsPanelOpen);
}

function scheduleLiveDiagnostics() {
  if (!liveDiagnosticsEnabled || !['html', 'htm', 'svg', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json'].includes(extension(activePath))) return;
  clearTimeout(liveDiagnosticsTimer);
  const revision = ++liveDiagnosticsRevision;
  liveDiagnosticsTimer = setTimeout(() => {
    if (revision !== liveDiagnosticsRevision || loading) return;
    validateCurrentFile({ live: true }).catch(error => {
      if (revision === liveDiagnosticsRevision) renderLiveDiagnostics([{ severity: 'error', line: 0, message: `Live diagnostics could not run: ${error.message}` }], activePath);
    });
  }, 800);
}

async function validateCurrentFile(options = {}) {
  const checkedPath = activePath;
  const checkedVersion = editVersion;
  const text = source();
  const ext = extension(checkedPath);
  const issues = [];
  const add = (severity, message, needle = '') => issues.push({ severity, message, line: sourceLine(needle) });
  if (['html', 'htm', 'svg'].includes(ext)) {
    const document = new DOMParser().parseFromString(text, 'text/html');
    if (!/<!doctype\s+html/i.test(text)) add('warning', 'Add an HTML5 doctype so browsers use standards mode.', '<html');
    if (!document.documentElement.hasAttribute('lang')) add('warning', 'Set a language on the html element for assistive technology and search.', '<html');
    if (!document.querySelector('title')?.textContent.trim()) add('error', 'The document needs a non-empty title.', '<head');
    const ids = new Map();
    for (const element of document.querySelectorAll('[id]')) {
      const id = element.id;
      if (ids.has(id)) add('error', `Duplicate id "${id}". IDs must be unique.`, `id="${id}"`);
      ids.set(id, element);
    }
    for (const image of document.querySelectorAll('img')) {
      if (!image.hasAttribute('alt') && image.getAttribute('role') !== 'presentation') add('error', 'Image needs an alt attribute. Use alt="" for decorative images.', '<img');
      if (!image.getAttribute('src')) add('error', 'Image is missing its src attribute.', '<img');
    }
    const entries = await (await fetch('/api/files')).json();
    const normalizeProjectPath = path => path.replaceAll('\\', '/').split('/').filter(Boolean).join('/').toLowerCase();
    const projectFiles = new Set(entries.filter(item => item.kind === 'file').map(item => normalizeProjectPath(item.path)));
    const projectDirectories = new Set(entries.filter(item => item.kind === 'directory').map(item => normalizeProjectPath(item.path)));
    const pageDirectory = activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/') + 1) : '';
    for (const element of document.querySelectorAll('[src], [href]')) {
      const attr = element.hasAttribute('src') ? 'src' : 'href';
      const ref = element.getAttribute(attr)?.trim();
      if (!ref) {
        add('error', `${attr} is empty and has no destination.`, `<${element.tagName.toLowerCase()}`);
        continue;
      }
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(ref)) {
        if (ref.startsWith('#') && !document.getElementById(decodeURIComponent(ref.slice(1)))) add('error', `In-page link target "${ref}" does not exist.`, `${attr}="${ref}"`);
        continue;
      }
      const pathPart = ref.split(/[?#]/, 1)[0];
      if (!pathPart) continue;
      const base = pathPart.startsWith('/') ? pathPart.slice(1) : pageDirectory + pathPart;
      const segments = [];
      for (const part of base.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') segments.pop(); else segments.push(part);
      }
      const resolved = segments.join('/');
      if (resolved) {
        const normalized = normalizeProjectPath(resolved);
        const exists = projectFiles.has(normalized) || (projectDirectories.has(normalized) && ['index.html', 'index.htm', 'default.html', 'default.htm', 'index.php'].some(name => projectFiles.has(`${normalized}/${name}`)));
        if (!exists) add('error', `Local ${attr} target "${ref}" was not found in this project.`, `${attr}="${ref}"`);
      }
    }
    if (!document.querySelector('meta[name="description"]')) add('warning', 'Add a meta description for search and link previews.', '<head');
  } else if (['css', 'scss', 'sass', 'less'].includes(ext)) {
    const stack = [];
    let quote = '';
    let comment = false;
    for (let i = 0; i < text.length; i++) {
      const pair = text.slice(i, i + 2);
      if (comment) { if (pair === '*/') { comment = false; i++; } continue; }
      if (quote) { if (text[i] === '\\') i++; else if (text[i] === quote) quote = ''; continue; }
      if (pair === '/*') { comment = true; i++; continue; }
      if (text[i] === '"' || text[i] === "'") { quote = text[i]; continue; }
      if (text[i] === '{') stack.push(i);
      if (text[i] === '}') { if (!stack.length) add('error', 'Closing brace has no matching opening brace.', '}'); else stack.pop(); }
    }
    for (const offset of stack) add('error', 'Opening brace is not closed.', text.slice(offset, offset + 1));
    if (quote) add('error', 'String value is missing its closing quote.');
    if (comment) add('error', 'CSS comment is missing its closing */.');
  } else if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) {
    try {
      await import('/formatter.js');
      await window.dreamFormatter.format(text, activePath);
    } catch (error) {
      const line = error.loc?.start?.line ?? error.line;
      const issue = { severity: 'error', message: `Source syntax: ${error.message}`, line: Number.isInteger(line) ? Math.max(0, line - 1) : 0 };
      issues.push(issue);
    }
  } else if (ext === 'json') {
    try { JSON.parse(text); } catch (error) { add('error', `JSON syntax: ${error.message}`); }
  } else {
    add('warning', `No built-in validator is available for .${ext || 'unknown'} files.`);
  }
  if (options.live) {
    if (activePath !== checkedPath || editVersion !== checkedVersion || source() !== text) return;
    renderLiveDiagnostics(issues, checkedPath);
    return;
  }
  const list = byId('validationResults');
  list.replaceChildren();
  byId('validationSummary').textContent = `${activePath} · ${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`;
  if (!issues.length) {
    const clean = document.createElement('div');
    clean.className = 'validation-clean';
    clean.textContent = 'No issues found by DreamCraft’s built-in checks.';
    list.appendChild(clean);
  } else {
    issues.forEach(issue => {
      const row = document.createElement('button');
      row.className = 'validation-item';
      const line = document.createElement('span');
      line.className = 'validation-line';
      line.textContent = `Line ${issue.line + 1}`;
      const severity = document.createElement('span');
      severity.className = 'validation-severity ' + issue.severity;
      severity.textContent = issue.severity;
      const message = document.createElement('span');
      message.textContent = issue.message;
      row.append(line, severity, message);
      row.addEventListener('click', () => {
        byId('validationModal').style.display = 'none';
        setView('code');
        editor.setCursor({ line: issue.line, ch: 0 });
        editor.focus();
        editor.scrollIntoView({ line: issue.line, ch: 0 }, 100);
      });
      list.appendChild(row);
    });
  }
  byId('validationModal').style.display = 'grid';
}

let siteReportController = null;

function openSiteReports() {
  byId('siteReportsModal').style.display = 'grid';
  byId('siteReportStatus').textContent = 'Select checks and scan the active website.';
  loadRuntimeTestBrowsers();
  byId('siteReportsRun').focus();
}

async function loadRuntimeTestBrowsers() {
  const select = byId('siteReportBrowser');
  const runtimeLabel = byId('siteReportRuntime').parentElement;
  if (runtimeLabel.lastChild?.nodeType === Node.TEXT_NODE) runtimeLabel.lastChild.textContent = ' Test in';
  select.disabled = true;
  try {
    const response = await fetch('/api/browsers');
    if (!response.ok) throw new Error('Could not detect installed browsers.');
    const browsers = (await response.json()).filter(browser => ['edge','chrome','chromium','brave'].includes(browser.id));
    select.replaceChildren();
    select.multiple = true;
    select.size = Math.min(4, Math.max(1, browsers.length));
    select.style.height = `${select.size * 29 + 8}px`;
    select.style.padding = '4px 7px';
    if (!browsers.length) {
      select.add(new Option('No Chromium browser found', ''));
      byId('siteReportRuntime').checked = false;
      byId('siteReportRuntime').disabled = true;
      byId('siteReportStatus').textContent = 'Install Edge, Chrome, Chromium, or Brave to run browser diagnostics.';
      return;
    }
    byId('siteReportRuntime').disabled = false;
    for (const browser of browsers) select.add(new Option(browser.name, browser.id));
    select.disabled = !byId('siteReportRuntime').checked;
    let preferred = [];
    try {
      const saved = JSON.parse(localStorage.getItem('dreamcraft.runtime-test-browsers') || 'null');
      preferred = Array.isArray(saved) ? saved : [localStorage.getItem('dreamcraft.runtime-test-browser')].filter(Boolean);
    } catch {}
    const available = new Set(browsers.map(browser => browser.id));
    const selected = preferred.filter(id => available.has(id));
    for (const option of select.options) option.selected = !selected.length || selected.includes(option.value);
  } catch (error) {
    select.replaceChildren(new Option('Browser detection failed', ''));
    byId('siteReportStatus').textContent = error.message;
  }
}

function closeSiteReports() {
  siteReportController?.abort();
  byId('siteReportsModal').style.display = 'none';
}

let templateDocuments = [];
let selectedTemplateDocument = '';

function templateMessage(message, error = false) {
  const node = byId('siteTemplatesMessage');
  node.textContent = message; node.classList.toggle('hide', !message); node.classList.toggle('git-error', error);
}

function openTemplates() {
  byId('siteTemplatesModal').style.display = 'grid';
  loadTemplateDocuments();
}

async function loadTemplateDocuments() {
  const list = byId('templateDocumentList');
  list.replaceChildren(Object.assign(document.createElement('div'), { className: 'template-note', textContent: 'Loading HTML documents…' }));
  try {
    const entries = await (await fetch('/api/files')).json();
    templateDocuments = entries.filter(entry => entry.kind === 'file' && /\.(?:html?|dwt)$/i.test(entry.path));
    list.replaceChildren();
    if (!templateDocuments.length) { list.append(Object.assign(document.createElement('div'), { className: 'template-note', textContent: 'This project has no HTML documents yet.' })); return; }
    for (const entry of templateDocuments) {
      const row = document.createElement('div'); row.className = `template-row${entry.path === selectedTemplateDocument ? ' selected' : ''}`;
      row.append(document.createTextNode(entry.path));
      const sub = document.createElement('small'); sub.textContent = /\.dwt$/i.test(entry.path) ? 'Template master' : 'HTML page'; row.appendChild(sub);
      row.addEventListener('click', () => { selectedTemplateDocument = entry.path; renderTemplateDetail(); list.querySelectorAll('.template-row').forEach(item => item.classList.toggle('selected', item === row)); });
      list.appendChild(row);
    }
    if (selectedTemplateDocument && !templateDocuments.some(entry => entry.path === selectedTemplateDocument)) selectedTemplateDocument = '';
    if (!selectedTemplateDocument) selectedTemplateDocument = templateDocuments[0].path;
    renderTemplateDetail();
    list.querySelectorAll('.template-row').forEach(row => row.classList.toggle('selected', row.firstChild.textContent === selectedTemplateDocument));
  } catch (error) { list.replaceChildren(Object.assign(document.createElement('div'), { className: 'template-note', textContent: error.message })); }
}

function appendTemplateField(container, labelText, value, type = 'text') {
  const label = document.createElement('label'); label.className = 'prop-label'; label.textContent = labelText;
  const input = document.createElement('input'); input.className = 'input'; input.type = type; input.value = value;
  container.append(label, input); return input;
}

function renderTemplateDetail() {
  const detail = byId('templateDetail'); detail.replaceChildren();
  const selected = templateDocuments.find(entry => entry.path === selectedTemplateDocument);
  if (!selected) return;
  const action = document.createElement('div'); action.className = 'modal-actions'; action.style.justifyContent = 'flex-start';
  const open = document.createElement('button'); open.className = 'btn'; open.textContent = 'Open in editor'; open.onclick = async () => { byId('siteTemplatesModal').style.display = 'none'; await openFile(selected.path); setView('code'); };
  action.appendChild(open); detail.appendChild(action);
  const note = document.createElement('div'); note.className = 'template-note'; note.textContent = 'Editable regions use Dreamweaver-compatible HTML comments. Keep region names unique within the master. Child pages are ordinary HTML and publish without template processing.'; detail.appendChild(note);
  if (/\.dwt$/i.test(selected.path)) renderTemplateMaster(selected, detail);
  else renderTemplatePage(selected, detail);
}

async function renderTemplateMaster(selected, detail) {
  const text = selected.path === activePath && dirty ? source() : await fetchText(selected.path);
  const state = templateMarkupState(text, selected.path);
  const title = document.createElement('div'); title.className = 'section-title'; title.textContent = `${state.regions.length} editable · ${state.parameters.length} optional · ${state.repeats.length} repeating`; detail.appendChild(title);
  if (!state.regions.length) detail.append(Object.assign(document.createElement('div'), { className: 'template-note', textContent: 'This template has no editable regions. Add one from the current source selection.' }));
  for (const region of state.regions) {
    const row = document.createElement('div'); row.className = 'template-region-row';
    const name = document.createElement('span'); name.textContent = region.name;
    const edit = document.createElement('button'); edit.className = 'btn'; edit.textContent = 'Select'; edit.onclick = async () => { byId('siteTemplatesModal').style.display = 'none'; await openFile(selected.path); setView('code'); const marker = `<!-- TemplateBeginEditable name="${region.name}" -->`; const at = source().indexOf(marker); if (at >= 0) { editor.setCursor(editor.posFromIndex(at + marker.length)); editor.focus(); } };
    row.append(name, edit); detail.appendChild(row);
  }
  for (const parameter of state.parameters) {
    const row = document.createElement('div'); row.className = 'template-region-row';
    const name = document.createElement('span'); name.textContent = `${parameter.name} · ${parameter.value ? 'shown by default' : 'hidden by default'}`;
    const edit = document.createElement('button'); edit.className = 'btn'; edit.textContent = 'Select'; edit.onclick = async () => { byId('siteTemplatesModal').style.display = 'none'; await openFile(selected.path); setView('code'); const marker = `<!-- TemplateBeginIf cond="${parameter.name}" -->`; const at = source().indexOf(marker); if (at >= 0) { editor.setCursor(editor.posFromIndex(at + marker.length)); editor.focus(); } };
    row.append(name, edit); detail.appendChild(row);
  }
  for (const repeat of state.repeats) {
    const row = document.createElement('div'); row.className = 'template-region-row';
    const name = document.createElement('span'); name.textContent = `${repeat.name} · repeating`;
    const edit = document.createElement('button'); edit.className = 'btn'; edit.textContent = 'Select'; edit.onclick = async () => { byId('siteTemplatesModal').style.display = 'none'; await openFile(selected.path); setView('code'); const marker = `<!-- TemplateBeginRepeat name="${repeat.name}" -->`; const at = source().indexOf(marker); if (at >= 0) { editor.setCursor(editor.posFromIndex(at + marker.length)); editor.focus(); } };
    row.append(name, edit); detail.appendChild(row);
  }
  const pageHeading = document.createElement('div'); pageHeading.className = 'section-title'; pageHeading.textContent = 'Pages using this template'; pageHeading.style.marginTop = '17px'; detail.appendChild(pageHeading);
  const pages = [];
  for (const entry of templateDocuments.filter(item => !/\.dwt$/i.test(item.path))) {
    let page; try { page = await fetchText(entry.path); } catch { continue; }
    if (templateInstancePath(page, entry.path) === selected.path) pages.push({ entry, page });
  }
  detail.append(Object.assign(document.createElement('div'), { className: 'template-note', textContent: `${pages.length} dependent page${pages.length === 1 ? '' : 's'} found. Changing this master can update their locked content.` }));
  const update = document.createElement('button'); update.className = 'btn primary'; update.textContent = 'Update dependent pages'; update.disabled = !pages.length;
  update.onclick = async () => {
    if (dirty && !(await save())) return;
    const masterText = await fetchText(selected.path);
    await updateDependentPages(selected, masterText, pages);
  };
  detail.appendChild(update);
  appendCreateTemplatePage(detail, selected, state.regions.length + state.parameters.length + state.repeats.length > 0);
}

function appendCreateTemplatePage(detail, templateEntry, hasEditableRegions) {
  const heading = document.createElement('div'); heading.className = 'section-title'; heading.textContent = 'Create a page from this template'; heading.style.marginTop = '17px'; detail.appendChild(heading);
  const pagePath = appendTemplateField(detail, 'New page path', 'pages/new-page.html');
  const create = document.createElement('button'); create.className = 'btn primary'; create.textContent = 'Create template page';
  create.disabled = !hasEditableRegions;
  if (!hasEditableRegions) create.title = 'Add at least one editable region to this template first.';
  create.addEventListener('click', async () => {
    const path = pagePath.value.trim().replaceAll('\\', '/').replace(/^\/+/, '');
    if (!path.toLowerCase().endsWith('.html') || path.split('/').some(part => !part || part === '.' || part === '..')) return templateMessage('Choose a safe project-relative .html path.', true);
    let templateSource;
    try { templateSource = await fetchText(templateEntry.path); } catch (error) { return templateMessage(error.message, true); }
    const templateState = templateMarkupState(templateSource, templateEntry.path);
    if (!templateState || !templateState.regions.length && !templateState.parameters.length && !templateState.repeats.length) return templateMessage('Add an editable, optional, or repeating region to the template before creating a page.', true);
    const relative = relativeProjectPath(path, templateEntry.path);
    const marker = `<!-- TemplateBeginInstance template="${relative}" -->\n`;
    let output = templateSource.replace(/<head\b[^>]*>/i, match => `${match}\n${marker}`);
  for (const [name, value] of parseTemplateParameters(templateSource)) output = output.replace(marker.trim(), match => `${match}\n<!-- InstanceParam name="${name}" type="boolean" value="${value}" passthrough="false" -->`);
    for (const [name, value] of parseTemplateParameters(templateSource)) output = output.replace(marker.trim(), match => `${match}\n<!-- InstanceParam name="${name}" type="boolean" value="${value}" passthrough="false" -->`);
    output = output.replace(/<\/body\s*>/i, '<!-- TemplateEndInstance -->\n</body>');
    output = adjustTemplateResourcePaths(output, templateEntry.path, path);
    try {
      const response = await fetch('/api/files'); const files = await response.json();
      if (files.some(entry => entry.path.toLowerCase() === path.toLowerCase())) throw new Error('That page path already exists.');
      const write = await fetch(apiPath(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: output }) });
      if (!write.ok) throw new Error('Could not create the template-based page.');
      await loadTree(); selectedTemplateDocument = path; await loadTemplateDocuments(); templateMessage(`Created ${path} from ${templateEntry.path}.`);
    } catch (error) { templateMessage(error.message, true); }
  });
  const actions = document.createElement('div'); actions.className = 'modal-actions'; actions.style.justifyContent = 'flex-start'; actions.appendChild(create); detail.appendChild(actions);
}

function templateInstancePath(text, pagePath) {
  const found = text.match(/<!--\s*TemplateBeginInstance\s+template="([^"]+)"\s*-->/i);
  if (!found) return '';
  const reference = found[1].replaceAll('\\', '/');
  const base = reference.startsWith('/') ? reference.slice(1) : `${pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/') + 1) : ''}${reference}`;
  const parts = [];
  for (const part of base.split('/')) { if (!part || part === '.') continue; if (part === '..') parts.pop(); else parts.push(part); }
  return parts.join('/');
}

function adjustTemplateResourcePaths(markup, fromFile, toFile) {
  return markup.replace(/\b(href|src)=(['"])(.*?)\2/gi, (whole, attribute, quote, value) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return whole;
    const split = value.search(/[?#]/);
    const sourcePath = split < 0 ? value : value.slice(0, split);
    const suffix = split < 0 ? '' : value.slice(split);
    if (!sourcePath) return whole;
    const target = resolveProjectHref(fromFile, sourcePath);
    if (!target) return whole;
    return `${attribute}=${quote}${relativeProjectPath(toFile, target)}${suffix}${quote}`;
  });
}

function extractTemplateRegions(text) {
  const result = new Map();
  const re = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;
  const repeats = findTemplateRepeatBlocks(text);
  for (const found of text.matchAll(re)) {
    if (repeats.some(repeat => found.index >= repeat.start && found.index < repeat.end)) continue;
    if (result.has(found[1])) throw new Error(`The template repeats editable region “${found[1]}”.`);
    result.set(found[1], found[2]);
  }
  return result;
}

function findTemplateRepeatBlocks(text) {
  const blocks = [], pattern = /<!--\s*TemplateBeginRepeat\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndRepeat\s*-->/g;
  for (const match of text.matchAll(pattern)) blocks.push({ name: match[1], body: match[2], start: match.index, end: match.index + match[0].length, markup: match[0] });
  return blocks;
}

function mergeTemplateRepeatBody(masterBody, pageBody) {
  const oldEditable = new Map(), oldPattern = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;
  for (const match of pageBody.matchAll(oldPattern)) {
    const entries = oldEditable.get(match[1]) || [];
    entries.push(match[2]); oldEditable.set(match[1], entries);
  }
  const occurrences = new Map();
  const pattern = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;
  return masterBody.replace(pattern, (whole, name, defaultContent) => {
    const occurrence = occurrences.get(name) || 0; occurrences.set(name, occurrence + 1);
    const content = oldEditable.get(name)?.[occurrence] ?? defaultContent;
    return whole.replace(defaultContent, content);
  });
}

async function modifyTemplateRepeat(path, name, index, action) {
  try {
    if (path === activePath && dirty && !(await save())) throw new Error('Save the current page before changing repeating entries.');
    const original = await fetchText(path), repeats = findTemplateRepeatBlocks(original).filter(repeat => repeat.name === name);
    if (!repeats.length || index < 0 || index >= repeats.length) throw new Error('This repeating region changed. Reopen the template panel and try again.');
    if (action === 'remove' && repeats.length < 2) throw new Error('A repeating region must keep at least one entry.');
    const entries = repeats.map(repeat => repeat.markup);
    if (action === 'add') entries.splice(index + 1, 0, entries[index]);
    else if (action === 'remove') entries.splice(index, 1);
    else if (action === 'up' && index > 0) [entries[index - 1], entries[index]] = [entries[index], entries[index - 1]];
    else if (action === 'down' && index < entries.length - 1) [entries[index], entries[index + 1]] = [entries[index + 1], entries[index]];
    const first = repeats[0], last = repeats.at(-1);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<!--\\s*TemplateBeginRepeat\\s+name="${escaped}"\\s*-->[\\s\\S]*?<!--\\s*TemplateEndRepeat\\s*-->`, 'g');
    let entryIndex = 0;
    const blockRange = original.slice(first.start, last.end).replace(pattern, () => entries[entryIndex++] || '');
    const updated = `${original.slice(0, first.start)}${blockRange}${original.slice(last.end)}`;
    const snapshotResponse = await fetch('/api/snapshots', { method: 'POST' });
    const snapshot = await snapshotResponse.json();
    if (!snapshotResponse.ok) throw new Error(snapshot.error || 'Could not create a recovery snapshot; no changes were made.');
    if (await fetchText(path) !== original) throw new Error('This page changed while its repeating entries were being updated.');
    const response = await fetch(apiPath(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: updated }) });
    if (!response.ok) throw new Error(`Could not update repeating entries. Recovery snapshot ${snapshot.id} is available.`);
    if (path === activePath) await openFile(path);
    await loadTree(); await renderPreview(); await loadTemplateDocuments();
    templateMessage(`Updated repeating entries in ${path}. Recovery snapshot ${snapshot.id} is available.`);
  } catch (error) { templateMessage(error.message, true); }
}

function parseTemplateParameters(text) {
  const parameters = new Map();
  const comments = /<!--\s*TemplateParam\b([\s\S]*?)-->/g;
  for (const comment of text.matchAll(comments)) {
    const attributes = Object.fromEntries([...comment[1].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], match[3]]));
    if (attributes.type !== 'boolean' || !/^(?:true|false)$/.test(attributes.value || '') || !attributes.name) continue;
    if (parameters.has(attributes.name)) throw new Error(`Template parameter “${attributes.name}” is defined more than once.`);
    parameters.set(attributes.name, attributes.value === 'true');
  }
  return parameters;
}

function parseTemplateInstanceParameters(text) {
  const parameters = new Map();
  const comments = /<!--\s*InstanceParam\b([\s\S]*?)-->/g;
  for (const comment of text.matchAll(comments)) {
    const attributes = Object.fromEntries([...comment[1].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], match[3]]));
    if (attributes.type === 'boolean' && /^(?:true|false)$/.test(attributes.value || '') && attributes.name) parameters.set(attributes.name, attributes.value === 'true');
  }
  return parameters;
}

function setTemplateInstanceParameter(text, name, enabled) {
  const found = parseTemplateInstanceParameters(text).has(name);
  if (found) {
    const comments = /<!--\s*InstanceParam\b([\s\S]*?)-->/g;
    return text.replace(comments, (whole, body) => {
      const attributes = Object.fromEntries([...body.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], match[3]]));
      return attributes.name === name && attributes.type === 'boolean' ? `<!-- InstanceParam name="${name}" type="boolean" value="${enabled}" passthrough="${attributes.passthrough || 'false'}" -->` : whole;
    });
  }
  if (!parseTemplateParameters(text).has(name)) throw new Error(`Template parameter “${name}” is no longer present.`);
  return text.replace(/<!--\s*TemplateBeginInstance\s+template="[^"]+"\s*-->/, match => `${match}\n<!-- InstanceParam name="${name}" type="boolean" value="${enabled}" passthrough="false" -->`);
}

function applyTemplateParameters(markup, parameters) {
  let output = markup;
  const instanceValues = parseTemplateInstanceParameters(markup);
  for (const [name, defaultValue] of parameters) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const value = instanceValues.has(name) ? instanceValues.get(name) : defaultValue;
    const condition = new RegExp(`<!--\\s*TemplateBeginIf\\s+cond=(["'])${escaped}\\1\\s*-->([\\s\\S]*?)<!--\\s*TemplateEndIf\\s*-->`, 'g');
    output = output.replace(condition, (_match, _quote, content) => value ? content : '');
  }
  return output;
}

function confirmTemplateUpdate(description) {
  return new Promise(resolve => {
    const modal = byId('templateConfirmModal');
    const finish = value => { modal.style.display = 'none'; resolve(value); };
    byId('templateConfirmDescription').textContent = description;
    byId('templateConfirmCancel').onclick = () => finish(false);
    byId('templateConfirmProceed').onclick = () => finish(true);
    modal.onclick = event => { if (event.target === modal) finish(false); };
    modal.style.display = 'grid'; byId('templateConfirmCancel').focus();
  });
}

async function updateDependentPages(template, updatedMaster, pages) {
  try {
    const newRegions = extractTemplateRegions(updatedMaster);
    const prepared = [];
    for (const item of pages) {
      const original = await fetchText(item.entry.path);
      const pageRegions = extractTemplateRegions(original);
      const pageParameters = parseTemplateInstanceParameters(original);
      const pageRepeats = findTemplateRepeatBlocks(original);
      let output = updatedMaster.replace(/<!--\s*TemplateBeginInstance\b[\s\S]*?-->/gi, '').replace(/<!--\s*TemplateEndInstance\s*-->/gi, '');
      for (const [name, defaultBody] of newRegions) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(<!--\\s*TemplateBeginEditable\\s+name="${escaped}"\\s*-->)[\\s\\S]*?(<!--\\s*TemplateEndEditable\\s*-->)`);
        if (!pattern.test(output)) throw new Error(`Updated template region “${name}” could not be mapped. No pages were changed.`);
        const body = pageRegions.has(name) ? pageRegions.get(name) : defaultBody;
        output = output.replace(pattern, (_match, open, close) => `${open}${body}${close}`);
      }
      const masterRepeats = findTemplateRepeatBlocks(updatedMaster);
      const repeatGroups = new Map();
      for (const repeat of pageRepeats) { const entries = repeatGroups.get(repeat.name) || []; entries.push(repeat); repeatGroups.set(repeat.name, entries); }
      for (const repeat of masterRepeats) {
        const entries = repeatGroups.get(repeat.name) || [null];
        const replacements = entries.map(entry => `<!-- TemplateBeginRepeat name="${repeat.name}" -->${mergeTemplateRepeatBody(repeat.body, entry?.body ?? repeat.body)}<!-- TemplateEndRepeat -->`).join('');
        const escaped = repeat.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`<!--\\s*TemplateBeginRepeat\\s+name="${escaped}"\\s*-->[\\s\\S]*?<!--\\s*TemplateEndRepeat\\s*-->`);
        if (!pattern.test(output)) throw new Error(`Updated repeating region “${repeat.name}” could not be mapped. No pages were changed.`);
        output = output.replace(pattern, replacements);
      }
      const relative = relativeProjectPath(item.entry.path, template.path);
      const instance = [`<!-- TemplateBeginInstance template="${relative}" -->`, ...[...parseTemplateParameters(updatedMaster)].map(([name, value]) => `<!-- InstanceParam name="${name}" type="boolean" value="${pageParameters.get(name) ?? value}" passthrough="false" -->`)].join('\n');
      if (/<\/head\s*>/i.test(output)) output = output.replace(/<\/head\s*>/i, `${instance}\n</head>`);
      else output = `${instance}\n${output}`;
      output = output.replace(/<\/body\s*>/i, '<!-- TemplateEndInstance -->\n</body>');
      output = adjustTemplateResourcePaths(output, template.path, item.entry.path);
      const childState = templateMarkupState(output, item.entry.path);
      if (!childState || childState.regions.length !== newRegions.size) throw new Error(`Could not safely map all template regions in ${item.entry.path}; no pages were changed.`);
      prepared.push({ path: item.entry.path, original, output });
    }
    const currentNames = new Set(prepared.flatMap(item => [...extractTemplateRegions(item.original).keys()]));
    const removed = [...currentNames].filter(name => !newRegions.has(name));
    if (removed.length && !(await confirmTemplateUpdate(`The master removed editable region${removed.length === 1 ? '' : 's'} ${removed.join(', ')}. Content in those regions will be removed from ${pages.length} dependent page${pages.length === 1 ? '' : 's'}. A recovery snapshot will be created first.`))) return;
    const snapshotResponse = await fetch('/api/snapshots', { method: 'POST' });
    const snapshot = await snapshotResponse.json();
    if (!snapshotResponse.ok) throw new Error(snapshot.error || 'Could not create a recovery snapshot; no pages were changed.');
    for (const page of prepared) {
      if (await fetchText(page.path) !== page.original) throw new Error(`${page.path} changed while the update was being prepared. No pages were updated.`);
    }
    for (const page of prepared) {
      const response = await fetch(apiPath(page.path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: page.output }) });
      if (!response.ok) throw new Error(`Could not update ${page.path}. Recovery snapshot ${snapshot.id} is available.`);
    }
    await loadTree();
    if (prepared.some(item => item.path === activePath)) await openFile(activePath);
    await renderPreview(); templateMessage(`Updated ${prepared.length} page${prepared.length === 1 ? '' : 's'}. Recovery snapshot ${snapshot.id} is available.`);
    toast(`Updated ${prepared.length} template-based page${prepared.length === 1 ? '' : 's'}`);
    await loadTemplateDocuments();
  } catch (error) { templateMessage(error.message, true); }
}

async function renderTemplatePage(selected, detail) {
  const text = selected.path === activePath && dirty ? source() : await fetchText(selected.path);
  const linked = templateInstancePath(text, selected.path);
  if (linked) {
    detail.append(Object.assign(document.createElement('div'), { className: 'template-note', textContent: `Uses template: ${linked}` }));
    const master = templateDocuments.find(entry => entry.path === linked);
    if (master) {
      const create = document.createElement('button'); create.className = 'btn'; create.textContent = 'Open template'; create.onclick = async () => { byId('siteTemplatesModal').style.display = 'none'; await openFile(linked); setView('code'); };
      detail.appendChild(create);
    }
    const state = templateMarkupState(text, selected.path);
    detail.append(Object.assign(document.createElement('div'), { className: 'template-note', textContent: `${state?.regions.length || 0} editable region${state?.regions.length === 1 ? '' : 's'}. Locked areas are protected in Code view.` }));
    if (state?.parameters.length) {
      const heading = document.createElement('div'); heading.className = 'section-title'; heading.textContent = 'Template properties'; heading.style.marginTop = '12px'; detail.appendChild(heading);
      for (const parameter of state.parameters) {
        const row = document.createElement('label'); row.className = 'template-page-check';
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = parameter.value;
        const label = document.createElement('span'); label.textContent = parameter.name;
        input.addEventListener('change', async () => {
          const enabled = input.checked;
          try {
            if (selected.path === activePath && dirty && !(await save())) throw new Error('Save the page before changing its template properties.');
            const original = selected.path === activePath ? source() : await fetchText(selected.path);
            const changed = setTemplateInstanceParameter(original, parameter.name, enabled);
            if (selected.path === activePath) replaceEditorDocument(changed);
            else {
              if (await fetchText(selected.path) !== original) throw new Error('This page changed while its properties were being updated.');
              const response = await fetch(apiPath(selected.path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: changed }) });
              if (!response.ok) throw new Error('Could not save the template property.');
            }
            await renderPreview();
          } catch (error) { input.checked = !enabled; templateMessage(error.message, true); }
        });
        row.append(input, label); detail.appendChild(row);
      }
    }
    const repeatGroups = new Map();
    for (const repeat of state?.repeats || []) repeatGroups.set(repeat.name, (repeatGroups.get(repeat.name) || 0) + 1);
    if (repeatGroups.size) {
      const heading = document.createElement('div'); heading.className = 'section-title'; heading.textContent = 'Repeating entries'; heading.style.marginTop = '12px'; detail.appendChild(heading);
      const childDirty = selected.path === activePath && dirty;
      for (const [name, count] of repeatGroups) {
        const row = document.createElement('div'); row.className = 'template-region-row';
        const label = document.createElement('span'); label.textContent = `${name} · ${count} ${count === 1 ? 'entry' : 'entries'}`;
        const actions = document.createElement('div'); actions.style.display = 'flex'; actions.style.gap = '4px';
        const add = document.createElement('button'); add.className = 'btn'; add.textContent = 'Add'; add.disabled = childDirty; add.title = childDirty ? 'Save the current page first.' : 'Duplicate the last entry'; add.onclick = () => modifyTemplateRepeat(selected.path, name, count - 1, 'add');
        const remove = document.createElement('button'); remove.className = 'btn'; remove.textContent = 'Remove last'; remove.disabled = childDirty || count < 2; remove.title = count < 2 ? 'A repeating region keeps at least one entry.' : 'Remove the last entry'; remove.onclick = () => modifyTemplateRepeat(selected.path, name, count - 1, 'remove');
        const up = document.createElement('button'); up.className = 'btn'; up.textContent = '↑'; up.disabled = childDirty || count < 2; up.title = 'Move the last entry earlier'; up.onclick = () => modifyTemplateRepeat(selected.path, name, count - 1, 'up');
        const down = document.createElement('button'); down.className = 'btn'; down.textContent = '↓'; down.disabled = childDirty || count < 2; down.title = 'Move the first entry later'; down.onclick = () => modifyTemplateRepeat(selected.path, name, 0, 'down');
        actions.append(add, remove, up, down); row.append(label, actions); detail.appendChild(row);
      }
    }
    return;
  }
  const controls = document.createElement('div'); detail.appendChild(controls);
  const templatePath = appendTemplateField(controls, 'Save template as', 'Templates/site.dwt');
  const save = document.createElement('button'); save.className = 'btn primary'; save.textContent = 'Save as template';
  save.onclick = async () => {
    const path = templatePath.value.trim().replaceAll('\\', '/').replace(/^\/+/, '');
    if (!path.toLowerCase().endsWith('.dwt') || path.split('/').some(part => !part || part === '.' || part === '..')) return templateMessage('Choose a safe project-relative .dwt path.', true);
    if (templateDocuments.some(entry => entry.path.toLowerCase() === path.toLowerCase())) return templateMessage('That template path already exists.', true);
    try {
      if (!/<body\b[^>]*>[\s\S]*?<\/body\s*>/i.test(text)) throw new Error('A template master needs a body element.');
      let body = text.replace(/<!--\s*TemplateBeginInstance\b[\s\S]*?-->/gi, '').replace(/<!--\s*TemplateEndInstance\s*-->/gi, '');
      body = adjustTemplateResourcePaths(body, selected.path, path);
      const response = await fetch(apiPath(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: body }) });
      if (!response.ok) throw new Error('Could not create the template file.');
      selectedTemplateDocument = path; await loadTree(); await loadTemplateDocuments(); templateMessage(`Created ${path}.`);
    } catch (error) { templateMessage(error.message, true); }
  };
  const actions = document.createElement('div'); actions.className = 'modal-actions'; actions.style.justifyContent = 'flex-start'; actions.appendChild(save); detail.appendChild(actions);
  const region = document.createElement('div'); region.className = 'template-note'; region.textContent = 'Open the saved master, select HTML or place the cursor for an empty region, then choose “Mark selection editable” from the command palette. Create dependent pages from the master once its regions are defined.'; detail.appendChild(region);
}

function markTemplateSelectionEditable() {
  if (!/\.dwt$/i.test(activePath)) return toast('Open a .dwt template before marking editable regions.');
  const selection = editor.getSelection();
  const from = editor.getCursor('from');
  showModal({
    title: 'Create editable region',
    description: 'Give this template region a unique name. Select content first, or leave the selection empty to insert a new editable area at the cursor.',
    value: 'content', confirmLabel: 'Mark editable',
    action: () => {
      const name = byId('newFileName').value.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || extractTemplateRegions(source()).has(name)) return toast('Use a unique region name beginning with a letter.');
      const open = `<!-- TemplateBeginEditable name="${name}" -->`;
      editor.replaceRange(`${open}${selection}<!-- TemplateEndEditable -->`, from, editor.getCursor('to'), 'around');
      hideModal();
      const start = editor.indexFromPos(from) + open.length;
      editor.setSelection(editor.posFromIndex(start), editor.posFromIndex(start + selection.length));
      templateRegionState = templateMarkupState(source(), activePath); markTemplateRegions(); updateTemplateRegionStatus();
    }
  });
}

function markTemplateSelectionOptional() {
  if (!/\.dwt$/i.test(activePath)) return toast('Open a .dwt template before marking optional regions.');
  const selection = editor.getSelection(), from = editor.getCursor('from');
  showModal({ title: 'Create optional region', description: 'Give this region a unique parameter name. Each child page can show or hide its content.', value: 'showNotice', confirmLabel: 'Mark optional', action: () => {
    const name = byId('newFileName').value.trim();
    let parameters;
    try { parameters = parseTemplateParameters(source()); } catch (error) { return toast(error.message); }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || parameters.has(name)) return toast('Use a unique parameter name beginning with a letter.');
    if (editor.somethingSelected() && !selection.trim()) return toast('Select non-empty template markup for the optional region.');
    editor.replaceRange(`<!-- TemplateBeginIf cond="${name}" -->${selection}<!-- TemplateEndIf -->`, from, editor.getCursor('to'), 'around');
    const current = source(), headClose = current.search(/<\/head\s*>/i), declaration = `<!-- TemplateParam name="${name}" type="boolean" value="true" -->\n`;
    if (headClose < 0) editor.replaceRange(`\n${declaration}`, editor.posFromIndex(0), editor.posFromIndex(0), 'dreamcraft');
    else editor.replaceRange(`\n${declaration}`, editor.posFromIndex(headClose), editor.posFromIndex(headClose), 'dreamcraft');
    hideModal(); templateRegionState = templateMarkupState(source(), activePath); markTemplateRegions(); updateTemplateRegionStatus(); setDirty(true); renderPreview();
  }});
}

function markTemplateSelectionRepeating() {
  if (!/\.dwt$/i.test(activePath)) return toast('Open a .dwt template before marking repeating regions.');
  const selection = editor.getSelection();
  if (!selection.trim()) return toast('Select the markup that should become a repeating entry.');
  const from = editor.getCursor('from');
  showModal({ title: 'Create repeating region', description: 'Name the repeating entry. Put editable regions inside it when each copied entry needs unique content.', value: 'items', confirmLabel: 'Mark repeating', action: () => {
    const name = byId('newFileName').value.trim(), current = templateMarkupState(source(), activePath);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || current?.repeats.some(region => region.name === name)) return toast('Use a unique region name beginning with a letter.');
    editor.replaceRange(`<!-- TemplateBeginRepeat name="${name}" -->${selection}<!-- TemplateEndRepeat -->`, from, editor.getCursor('to'), 'around');
    hideModal(); templateRegionState = templateMarkupState(source(), activePath); markTemplateRegions(); updateTemplateRegionStatus(); setDirty(true); renderPreview();
  }});
}

function sourceAttributeLine(text, attribute, value, occurrence = 0) {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escapedAttribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  let match;
  while ((match = pattern.exec(text))) {
    if ((match[1] ?? match[2] ?? match[3]) === value) {
      if (occurrence-- === 0) return text.slice(0, match.index).split('\n').length - 1;
    }
  }
  const offset = text.indexOf(value);
  return offset < 0 ? 0 : text.slice(0, offset).split('\n').length - 1;
}

function sourceTagLine(text, tag) {
  const match = new RegExp(`<${tag}\\b`, 'i').exec(text);
  return match ? text.slice(0, match.index).split('\n').length - 1 : 0;
}

let browserCompatData = null;
let browserCompatTools = null;
let browserJsAnalyzer = null;

async function loadBrowserCompatData(signal) {
  if (browserCompatData) return browserCompatData;
  browserCompatTools ||= await import('/compatibility.mjs');
  const response = await fetch('/vendor/browser-compat/index.json', { signal });
  if (!response.ok) throw new Error('Could not load the bundled MDN browser compatibility index.');
  browserCompatData = await response.json();
  return browserCompatData;
}

async function loadBrowserJsAnalyzer() {
  browserJsAnalyzer ||= await import('/js-analyzer.mjs');
  return browserJsAnalyzer;
}

function browserCompatTargets(data) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem('dreamcraft.compat.targets') || '{}'); } catch { return {}; } })();
  const labels = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari' };
  const targets = {};
  for (const name of data.metadata.browsers) {
    const input = byId(`compat${name[0].toUpperCase()}${name.slice(1)}`);
    if (!input.value.trim() && saved[name]) input.value = saved[name];
    targets[name] = String(input.value.trim() || data.currentVersions[name]);
  }
  byId('compatDataStatus').textContent = `MDN BCD ${data.metadata.packageVersion} · data ${data.metadata.generatedAt.slice(0, 10)} · ${data.metadata.browsers.map(name => `${labels[name]} ${targets[name]}`).join(' · ')}`;
  return targets;
}

function appendCompatibilityFinding(findings, seen, path, line, feature, record, targets, detail = '') {
  const reasons = browserCompatTools.compatibilityReasons(record, browserCompatData.metadata.browsers, targets);
  if (!reasons.length) return;
  const key = `${path}:${line}:${feature}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({ severity: 'warning', path, line, message: `${detail || feature} compatibility: ${reasons.join('; ')}.` });
}

async function inspectCompatibilityHtml(path, text, data, targets, findings, seen, scripts = []) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const occurrences = new Map();
  for (const element of doc.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();
    const occurrence = occurrences.get(tag) || 0;
    occurrences.set(tag, occurrence + 1);
    const tagPattern = new RegExp(`<${tag}\\b`, 'gi');
    let tagMatch, line = 0;
    for (let index = 0; index <= occurrence && (tagMatch = tagPattern.exec(text)); index++) line = text.slice(0, tagMatch.index).split('\n').length - 1;
    appendCompatibilityFinding(findings, seen, path, line, `HTML element <${tag}>`, data.html.elements[tag], targets);
    for (const attribute of element.getAttributeNames()) {
      let feature = data.html.elementAttributes[`${tag}.${attribute}`];
      if (tag === 'input' && attribute === 'type') feature = data.html.elementAttributes[`input.type_${element.getAttribute('type')?.toLowerCase()}`] || feature;
      feature ||= data.html.globalAttributes[attribute];
      if (!feature) continue;
      const value = element.getAttribute(attribute) || '';
      appendCompatibilityFinding(findings, seen, path, sourceAttributeLine(text, attribute, value), `HTML ${tag}[${attribute}]`, feature, targets);
    }
    const style = element.getAttribute('style');
    if (style) {
      try {
        const parsed = await window.dreamFormatter.analyzeCss(style);
        inspectCompatibilityCssFeatures(path, parsed, data, targets, findings, seen, sourceAttributeLine(text, 'style', style));
      } catch {}
    }
  }
  const styles = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)];
  for (const match of styles) {
    try {
      const parsed = await window.dreamFormatter.analyzeCss(match[1]);
      const baseLine = text.slice(0, match.index + match[0].indexOf(match[1])).split('\n').length - 1;
      inspectCompatibilityCssFeatures(path, parsed, data, targets, findings, seen, baseLine);
    } catch {}
  }
  const scriptBlocks = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  let scriptBlockIndex = 0;
  for (const script of doc.querySelectorAll('script')) {
    const scriptBlock = scriptBlocks[scriptBlockIndex++];
    const type = (script.getAttribute('type') || '').trim().toLowerCase();
    if (type && !['module', 'text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'].includes(type)) continue;
    const source = script.getAttribute('src')?.trim();
    if (source) {
      if (!/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) {
        const resolved = resolveProjectHref(path, source);
        if (resolved) scripts.push(resolved);
      }
      continue;
    }
    if (!script.textContent.trim() || !scriptBlock) continue;
    const code = scriptBlock[1];
    const line = text.slice(0, scriptBlock.index + scriptBlock[0].indexOf(code)).split('\n').length - 1;
    await inspectCompatibilityJavaScript(path, code, data, targets, findings, seen, line);
  }
}

async function inspectCompatibilityJavaScript(path, text, data, targets, findings, seen, lineOffset = 0) {
  try {
    const analyzer = await loadBrowserJsAnalyzer();
    const features = await analyzer.analyzeJavaScript(text, path, data.javascript);
    for (const feature of features) {
      const record = data.javascript?.[feature.category]?.[feature.name];
      appendCompatibilityFinding(findings, seen, path, lineOffset + feature.line, `JavaScript ${feature.name}`, record, targets);
    }
  } catch (error) {
    findings.push({ severity: 'warning', path, line: lineOffset, message: `Could not parse this script for browser compatibility: ${error.message}` });
  }
}

function inspectCompatibilityCssFeatures(path, parsed, data, targets, findings, seen, lineOffset = 0) {
  const properties = data.css.properties;
  for (const declaration of parsed.declarations) {
    const property = declaration.name.toLowerCase();
    if (property.startsWith('--') || property.startsWith('-webkit-') || property.startsWith('-moz-') || property.startsWith('-ms-')) continue;
    appendCompatibilityFinding(findings, seen, path, lineOffset + declaration.line, `CSS property ${property}`, properties[property], targets);
    const valueWords = declaration.value.toLowerCase().match(/[a-z][a-z0-9-]*/g) || [];
    for (const word of valueWords) {
      const feature = properties[`${property}.${word}`];
      if (feature) appendCompatibilityFinding(findings, seen, path, lineOffset + declaration.line, `CSS value ${property}: ${word}`, feature, targets);
    }
  }
  for (const rule of parsed.atRules) {
    const name = rule.name.toLowerCase();
    const features = data.css['at-rules'];
    appendCompatibilityFinding(findings, seen, path, lineOffset + rule.line, `CSS at-rule @${name}`, features[name], targets);
    for (const featureName of Object.keys(features)) {
      if (!featureName.startsWith(`${name}.`)) continue;
      const child = featureName.slice(name.length + 1);
      if (rule.params.toLowerCase().includes(child.toLowerCase())) {
        appendCompatibilityFinding(findings, seen, path, lineOffset + rule.line, `CSS @${name} feature ${child}`, features[featureName], targets);
      }
    }
  }
  for (const selector of parsed.selectors) {
    for (const match of selector.value.matchAll(/:{1,2}([a-z][a-z0-9-]*)/gi)) {
      const feature = data.css.selectors[match[1].toLowerCase()];
      if (feature) appendCompatibilityFinding(findings, seen, path, lineOffset + selector.line, `CSS selector :${match[1]}`, feature, targets);
    }
  }
}

async function inspectCompatibilityCss(path, text, data, targets, findings, seen) {
  try {
    const parsed = await window.dreamFormatter.analyzeCss(text);
    inspectCompatibilityCssFeatures(path, parsed, data, targets, findings, seen);
  } catch (error) {
    findings.push({ severity: 'warning', path, line: 0, message: `Could not parse this stylesheet for browser compatibility: ${error.message}` });
  }
}

function decodeReportFragment(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function reportHasLocalPath(path, filePaths, directoryPaths) {
  const normalized = path.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!normalized) return false;
  if (filePaths.has(normalized)) return true;
  if (directoryPaths.has(normalized) && (filePaths.has(normalized + '/index.html') || filePaths.has(normalized + '/index.htm'))) return true;
  return false;
}

function inspectSitePage(path, text, filePaths, directoryPaths, checks) {
  const issues = [];
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const add = (severity, line, message) => issues.push({ severity, path, line, message });
  if (checks.metadata) {
    if (!/<!doctype\s+html/i.test(text)) add('warning', 0, 'Missing HTML5 doctype.');
    const lang = doc.documentElement.getAttribute('lang')?.trim();
    if (!lang) add('warning', sourceTagLine(text, 'html'), 'The html element has no language value.');
    const title = doc.querySelector('title')?.textContent.trim();
    if (!title) add('error', sourceTagLine(text, 'head'), 'Missing non-empty document title.');
    if (!doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim()) add('warning', sourceTagLine(text, 'head'), 'Missing meta description.');
  }
  if (checks.images) {
    for (const image of doc.querySelectorAll('img')) {
      const role = image.getAttribute('role')?.toLowerCase();
      if (!image.hasAttribute('alt') && !['presentation', 'none'].includes(role)) {
        const line = sourceAttributeLine(text, 'src', image.getAttribute('src') || '');
        add('error', line, `Image ${image.getAttribute('src') || '(missing source)'} has no alt attribute.`);
      }
    }
  }
  if (checks.ids) {
    const seen = new Set();
    const occurrences = new Map();
    for (const element of doc.querySelectorAll('[id]')) {
      const id = element.id;
      if (seen.has(id)) {
        const occurrence = occurrences.get(id) || 1;
        const line = sourceAttributeLine(text, 'id', id, occurrence);
        occurrences.set(id, occurrence + 1);
        add('error', line, `Duplicate id "${id}"; IDs must be unique within a page.`);
      } else { seen.add(id); occurrences.set(id, 1); }
    }
  }
  if (checks.links) {
    for (const element of doc.querySelectorAll('[src], [href]')) {
      const attribute = element.hasAttribute('src') ? 'src' : 'href';
      const value = element.getAttribute(attribute)?.trim() || '';
      const line = sourceAttributeLine(text, attribute, element.getAttribute(attribute) || '');
      if (!value) { add('error', line, `Empty ${attribute} destination.`); continue; }
      if (attribute === 'href' && value.startsWith('#')) {
        const anchor = value.slice(1);
        if (anchor && !doc.getElementById(decodeReportFragment(anchor))) add('error', line, `In-page target "${value}" does not exist.`);
        continue;
      }
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) continue;
      const resolved = resolveProjectHref(path, value) || (value.startsWith('/') ? 'index.html' : '');
      if (!resolved) continue;
      if (!reportHasLocalPath(resolved, filePaths, directoryPaths)) {
        add('error', line, `Local ${attribute} target "${value}" was not found in the website.`);
        continue;
      }
      const hashIndex = value.indexOf('#');
      if (attribute === 'href' && hashIndex >= 0 && hashIndex < value.length - 1 && (resolved.toLowerCase() === path.toLowerCase() || filePaths.has(resolved.toLowerCase()))) {
        const targetContent = resolved.toLowerCase() === path.toLowerCase() ? text : null;
        const targetId = decodeReportFragment(value.slice(hashIndex + 1));
        if (targetContent && targetId && !new DOMParser().parseFromString(targetContent, 'text/html').getElementById(targetId)) add('error', line, `In-page target "#${targetId}" does not exist.`);
      }
    }
  }
  return issues;
}

function renderSiteReportResults(issues) {
  const root = byId('siteReportResults');
  root.replaceChildren();
  if (!issues.length) {
    const empty = document.createElement('div');
    empty.className = 'site-report-empty';
    empty.textContent = 'No findings for the selected checks.';
    root.appendChild(empty);
    return;
  }
  for (const issue of issues) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site-report-row';
    const severity = document.createElement('span');
    severity.className = 'site-report-severity ' + issue.severity;
    severity.textContent = issue.severity;
    const path = document.createElement('span');
    path.className = 'site-report-path';
    path.textContent = issue.path;
    const line = document.createElement('span');
    line.className = 'site-report-line';
    line.textContent = 'Line ' + (issue.line + 1);
    const message = document.createElement('span');
    message.className = 'site-report-message';
    message.textContent = issue.message;
    row.append(severity, path, line, message);
    row.addEventListener('click', async () => {
      byId('siteReportsModal').style.display = 'none';
      await openFile(issue.path);
      if (activePath !== issue.path) return;
      setView('code');
      editor.setCursor({ line: Math.min(issue.line, editor.lastLine()), ch: 0 });
      editor.focus();
      editor.scrollIntoView({ line: Math.min(issue.line, editor.lastLine()), ch: 0 }, 100);
    });
    root.appendChild(row);
  }
}

async function runBrowserRuntimeReport(signal) {
  const browserIds = [...byId('siteReportBrowser').selectedOptions].map(option => option.value).filter(Boolean);
  if (!browserIds.length) throw new Error('Select at least one installed Chromium browser for runtime diagnostics.');
  const snapshotResponse = await fetch('/api/publish', { method: 'POST', signal });
  if (!snapshotResponse.ok) throw new Error('Could not create a site snapshot for the browser run.');
  const snapshot = await snapshotResponse.json();
  const target = new URL(snapshot.url, location.origin);
  const base = new URL(snapshot.url, location.origin);
  const findings = [];
  const select = byId('siteReportBrowser');
  const selectedNames = browserIds.map(id => [...select.options].find(option => option.value === id)?.textContent || id);
  try { localStorage.setItem('dreamcraft.runtime-test-browsers', JSON.stringify(browserIds)); } catch {}
  for (let index = 0; index < browserIds.length; index++) {
    if (signal.aborted) break;
    const browserId = browserIds[index];
    byId('siteReportStatus').textContent = `Running browser ${index + 1} of ${browserIds.length}: ${selectedNames[index]}…`;
    try {
      const response = await fetch('/api/preview/browser-test', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browser_id: browserId, url: target.href })
      });
      if (!response.ok) throw new Error(response.status === 504 ? 'Browser did not start or finish loading within the time limit.' : `Headless browser run returned HTTP ${response.status}.`);
      const report = await response.json();
      for (const issue of report.issues) {
        let path = issue.path;
        try {
          const absolute = new URL(path, base);
          if (absolute.origin === base.origin && absolute.pathname.startsWith(base.pathname.replace(/index\.html$/, ''))) {
            path = decodeURIComponent(absolute.pathname.slice(base.pathname.replace(/index\.html$/, '').length)) || 'index.html';
          } else path = 'index.html';
        } catch { path = 'index.html'; }
        findings.push({ ...issue, path, message: `${report.browser}: ${issue.message}` });
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      findings.push({ severity: 'error', path: activePath || 'index.html', line: 0, message: `${selectedNames[index]} runtime test failed: ${error.message}` });
    }
  }
  return findings;
}

async function runSiteReports() {
  if (siteReportController) return;
  const checks = {
    links: byId('siteReportLinks').checked,
    images: byId('siteReportImages').checked,
    ids: byId('siteReportIds').checked,
    metadata: byId('siteReportMetadata').checked,
    compatibility: byId('siteReportCompatibility').checked,
    runtime: byId('siteReportRuntime').checked
  };
  if (!Object.values(checks).some(Boolean)) { byId('siteReportStatus').textContent = 'Select at least one report.'; return; }
  if (!(await save())) { byId('siteReportStatus').textContent = 'Save the open file before running site reports.'; return; }
  const controller = new AbortController();
  siteReportController = controller;
  const run = byId('siteReportsRun'), cancel = byId('siteReportCancel'), progress = byId('siteReportProgress'), bar = byId('siteReportProgressBar');
  run.disabled = true; cancel.disabled = false; progress.classList.remove('hide'); bar.style.width = '0%';
  const findings = [];
  try {
    const response = await fetch('/api/files', { signal: controller.signal });
    if (!response.ok) throw new Error('Could not list the active website files.');
    const entries = await response.json();
    const filePaths = new Set(entries.filter(entry => entry.kind === 'file').map(entry => entry.path.replaceAll('\\', '/').toLowerCase()));
    const directoryPaths = new Set(entries.filter(entry => entry.kind === 'directory').map(entry => entry.path.replaceAll('\\', '/').toLowerCase()));
    const pages = entries.filter(entry => entry.kind === 'file' && ['html', 'htm'].includes(extension(entry.path)));
    const stylesheets = checks.compatibility ? entries.filter(entry => entry.kind === 'file' && extension(entry.path) === 'css') : [];
    const scriptExtensions = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx']);
    const authoredScripts = checks.compatibility ? entries.filter(entry => entry.kind === 'file' && scriptExtensions.has(extension(entry.path)) && !/(?:^|\/)(?:\.git|\.dreamcraft|node_modules|vendor)(?:\/|$)/i.test(entry.path.replaceAll('\\', '/'))) : [];
    const scripts = checks.compatibility ? authoredScripts.map(entry => entry.path.replaceAll('\\', '/')) : [];
    if (!pages.length && !stylesheets.length && !scripts?.length) {
      byId('siteReportStatus').textContent = 'No HTML pages, stylesheets, or JavaScript files were found in the active website.';
      renderSiteReportResults([]);
      return;
    }
    let compatData = null, compatTargets = null;
    if (checks.compatibility) {
      compatData = await loadBrowserCompatData(controller.signal);
      compatTargets = browserCompatTargets(compatData);
      await loadBrowserJsAnalyzer();
      if (!window.dreamFormatter) await import('/formatter.js');
    }
    const totalFiles = pages.length + stylesheets.length + scripts.length;
    let scanned = 0;
    for (let offset = 0; offset < pages.length; offset += 6) {
      if (controller.signal.aborted) break;
      const batch = pages.slice(offset, offset + 6);
      const results = await Promise.all(batch.map(async page => {
        try {
          const file = await fetch(apiPath(page.path), { signal: controller.signal });
          if (!file.ok) throw new Error(`Could not read ${page.path}.`);
          const text = await file.text();
          const issues = inspectSitePage(page.path, text, filePaths, directoryPaths, checks);
          if (checks.compatibility) {
            const compatibility = [], seen = new Set();
            await inspectCompatibilityHtml(page.path, text, compatData, compatTargets, compatibility, seen, scripts);
            issues.push(...compatibility);
          }
          return issues;
        } catch (error) {
          if (error.name === 'AbortError') return [];
          return [{ severity: 'warning', path: page.path, line: 0, message: error.message }];
        }
      }));
      findings.push(...results.flat());
      scanned += batch.length;
      byId('siteReportStatus').textContent = `Scanned ${scanned} of ${totalFiles} HTML pages and CSS files · ${findings.length} findings`;
      bar.style.width = `${Math.round(scanned / totalFiles * 100)}%`;
    }
    if (checks.compatibility && !controller.signal.aborted) {
      const actualPaths = new Map(entries.filter(entry => entry.kind === 'file').map(entry => [entry.path.replaceAll('\\', '/').toLowerCase(), entry.path.replaceAll('\\', '/')]));
      const uniqueScripts = [...new Set(scripts.map(path => actualPaths.get(path.toLowerCase())).filter(Boolean))];
      for (let offset = 0; offset < uniqueScripts.length; offset += 6) {
        if (controller.signal.aborted) break;
        const batch = uniqueScripts.slice(offset, offset + 6);
        const results = await Promise.all(batch.map(async scriptPath => {
          try {
            const file = await fetch(apiPath(scriptPath), { signal: controller.signal });
            if (!file.ok) throw new Error(`Could not read ${scriptPath}.`);
            const features = await (await loadBrowserJsAnalyzer()).analyzeJavaScript(await file.text(), scriptPath, compatData.javascript);
            const issues = [];
            for (const feature of features) appendCompatibilityFinding(issues, new Set(), scriptPath, feature.line, `JavaScript ${feature.name}`, compatData.javascript?.[feature.category]?.[feature.name], compatTargets);
            return issues;
          } catch (error) {
            if (error.name === 'AbortError') return [];
            return [{ severity: 'warning', path: scriptPath, line: 0, message: error.message }];
          }
        }));
        findings.push(...results.flat());
        scanned += batch.length;
        byId('siteReportStatus').textContent = `Scanned ${scanned} files · ${findings.length} findings`;
        bar.style.width = `${Math.round(scanned / (totalFiles + uniqueScripts.length) * 100)}%`;
      }
    }
    for (let offset = 0; offset < stylesheets.length; offset += 6) {
      if (controller.signal.aborted) break;
      const batch = stylesheets.slice(offset, offset + 6);
      const results = await Promise.all(batch.map(async stylesheet => {
        try {
          const file = await fetch(apiPath(stylesheet.path), { signal: controller.signal });
          if (!file.ok) throw new Error(`Could not read ${stylesheet.path}.`);
          const compatibility = [];
          await inspectCompatibilityCss(stylesheet.path, await file.text(), compatData, compatTargets, compatibility, new Set());
          return compatibility;
        } catch (error) {
          if (error.name === 'AbortError') return [];
          return [{ severity: 'warning', path: stylesheet.path, line: 0, message: error.message }];
        }
      }));
      findings.push(...results.flat());
      scanned += batch.length;
      byId('siteReportStatus').textContent = `Scanned ${scanned} of ${totalFiles} HTML pages and CSS files · ${findings.length} findings`;
      bar.style.width = `${Math.round(scanned / totalFiles * 100)}%`;
    }
    if (checks.runtime && !controller.signal.aborted) {
      const selectedBrowsers = [...byId('siteReportBrowser').selectedOptions].map(option => option.textContent);
      byId('siteReportStatus').textContent = `Running published snapshot in ${selectedBrowsers.join(', ') || 'selected browsers'}…`;
      try {
        findings.push(...await runBrowserRuntimeReport(controller.signal));
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        findings.push({ severity: 'error', path: activePath || 'index.html', line: 0, message: `Browser runtime check: ${error.message}` });
      }
    }
    const severityOrder = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
    renderSiteReportResults(findings);
    byId('siteReportStatus').textContent = controller.signal.aborted
      ? `Scan cancelled after ${scanned} of ${totalFiles} HTML pages and CSS files · ${findings.length} findings`
      : `Scanned ${pages.length} HTML pages, ${stylesheets.length} CSS files, and ${scripts.length} JavaScript files · ${findings.length} findings`;
  } catch (error) {
    byId('siteReportStatus').textContent = error.name === 'AbortError' ? `Scan cancelled · ${findings.length} findings` : error.message;
    renderSiteReportResults(findings);
  } finally {
    siteReportController = null;
    run.disabled = false; cancel.disabled = true; progress.classList.add('hide');
  }
}

function setDirty(value) {
  dirty = value;
  byId('saveDot').style.background = value ? '#ffbf70' : '#65dda9';
  byId('saveLabel').textContent = value ? 'Unsaved changes…' : 'All changes saved';
}

function source() { return editor.getValue(); }
function isVisualDocument(path = activePath) { return ['html', 'htm', 'svg'].includes(extension(path)); }
function replaceEditorDocument(content, origin = 'dreamcraft') {
  const lastLine = editor.lastLine();
  editor.replaceRange(content, { line: 0, ch: 0 }, { line: lastLine, ch: editor.getLine(lastLine).length }, origin);
}
function updateHistoryButtons() {
  if (!editor || !byId('undoPage') || !byId('redoPage')) return;
  const history = editor.historySize();
  byId('undoPage').disabled = history.undo === 0;
  byId('redoPage').disabled = history.redo === 0;
}
function apiPath(path) { return '/api/file/' + path.split('/').map(encodeURIComponent).join('/'); }
function relativeDirectory(path) { return path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''; }
function extension(path) { return path.split('.').pop().toLowerCase(); }
function relativeProjectPath(fromFile, targetPath) {
  const from = relativeDirectory(fromFile).split('/').filter(Boolean), target = targetPath.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common++;
  return [...Array(from.length - common).fill('..'), ...target.slice(common)].join('/') || target.at(-1) || '';
}
function encodeProjectPath(path) { return path.split('/').map(segment => encodeURIComponent(segment)).join('/'); }
function resolveProjectHref(fromFile, href) {
  try {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return '';
    const url = new URL(href, `http://dreamcraft.local/${relativeDirectory(fromFile)}`);
    if (url.origin !== 'http://dreamcraft.local') return '';
    return decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch { return ''; }
}

function projectMessage(message, error = false) {
  const target = byId('projectMessage');
  target.textContent = message;
  target.classList.toggle('error', error);
}

async function loadProjects() {
  const response = await fetch('/api/projects');
  if (!response.ok) throw new Error('Could not load website projects.');
  const workspace = await response.json();
  const active = workspace.projects.find(item => item.path.toLowerCase() === workspace.current.toLowerCase());
  byId('projectName').textContent = active?.name || 'Website';
  byId('projectLocation').textContent = workspace.current;
  document.querySelector('.crumb > strong').textContent = active?.name || 'Website';
  document.querySelector('.crumb-mini > span').textContent = active?.name || 'Website';
  const list = byId('projectList');
  list.replaceChildren();
  if (!workspace.projects.length) {
    list.append(Object.assign(document.createElement('div'), { className: 'project-empty', textContent: 'No recent websites. Open a folder or create your first website below.' }));
    return;
  }
  for (const item of [...workspace.projects].reverse()) {
    const row = document.createElement('div');
    row.className = `project-row${item.path.toLowerCase() === workspace.current.toLowerCase() ? ' current' : ''}`;
    const info = document.createElement('div');
    info.innerHTML = `<div class="project-row-name"></div><div class="project-row-path"></div>`;
    info.querySelector('.project-row-name').textContent = item.name;
    info.querySelector('.project-row-path').textContent = item.path;
    row.append(info);
    if (item.path.toLowerCase() === workspace.current.toLowerCase()) {
      row.append(Object.assign(document.createElement('span'), { className: 'project-row-state', textContent: 'OPEN' }));
    } else {
      const button = document.createElement('button');
      button.className = 'btn';
      button.type = 'button';
      button.textContent = 'Open';
      button.addEventListener('click', () => switchProject('/api/projects/open', { path: item.path }));
      row.append(button);
    }
    list.append(row);
  }
}

async function switchProject(endpoint, body) {
  const button = byId('projectOpen');
  const create = byId('projectCreate');
  button.disabled = true;
  create.disabled = true;
  projectMessage('Saving the current website and switching…');
  try {
    if (!(await save())) throw new Error('Save the open file before switching websites.');
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `Website operation failed (${response.status}). Check the folder path and permissions.`);
    }
    location.reload();
  } catch (error) { projectMessage(error.message, true); }
  finally { button.disabled = false; create.disabled = false; }
}

function openProjectManager() {
  byId('projectModal').style.display = 'grid';
  projectMessage('');
  loadProjects().catch(error => projectMessage(error.message, true));
}

function editorMode(path) {
  const ext = extension(path);
  if (ext === 'html' || ext === 'htm' || ext === 'svg' || ext === 'vue') return 'htmlmixed';
  if (ext === 'css') return 'css';
  if (ext === 'scss') return 'text/x-scss';
  if (ext === 'sass') return 'text/x-sass';
  if (ext === 'less') return 'text/x-less';
  if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json'].includes(ext)) return 'javascript';
  if (ext === 'xml') return 'xml';
  if (['php', 'phtml'].includes(ext)) return 'application/x-httpd-php';
  return 'text/plain';
}

function languageName(path) {
  const ext = extension(path);
  return ({ html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SASS', less: 'LESS', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', jsx: 'JSX', tsx: 'TSX', json: 'JSON', md: 'Markdown', svg: 'SVG', xml: 'XML', vue: 'Vue', php: 'PHP', phtml: 'PHP' })[ext] || ext.toUpperCase() || 'TEXT';
}

const htmlTagCompletions = 'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr'.split(' ');
const htmlAttributeCompletions = 'accept accept-charset accesskey action alt aria-describedby aria-hidden aria-label aria-labelledby async autocomplete autofocus autoplay charset checked class cols colspan content controls crossorigin data-* defer disabled download for form formaction headers height hidden href id lang loading loop max maxlength media method min minlength multiple muted name open pattern placeholder playsinline poster readonly rel required role rowspan rows selected shape size slot span src srcset start step style tabindex target title type value width wrap'.split(' ');
const cssPropertyCompletions = 'align-content align-items animation background background-color border border-radius box-shadow color column-gap display flex flex-basis flex-direction flex-wrap font font-family font-size font-weight gap grid grid-template-columns grid-template-rows height justify-content line-height margin max-width min-height object-fit opacity overflow padding position text-align text-decoration text-transform transform transition width z-index'.split(' ');
const phpCompletions = ('$this $_COOKIE $_ENV $_FILES $_GET $_POST $_REQUEST $_SERVER $_SESSION $GLOBALS __DIR__ __FILE__ __LINE__ __NAMESPACE__ __CLASS__ __TRAIT__ __METHOD__ __FUNCTION__ abstract and array as break callable case catch class clone const continue declare default die do else elseif empty endfor endforeach endif endswitch endwhile enum eval exit extends false final finally fn for foreach function global if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait true try unset use var while xor echo print_r var_dump isset empty array_key_exists count strlen substr strpos str_replace preg_match preg_match_all preg_replace explode implode trim strtolower strtoupper ucfirst ucwords htmlspecialchars htmlentities htmlspecialchars_decode nl2br json_encode json_decode filter_var filter_input date strtotime time gmdate header http_response_code session_start session_destroy password_hash password_verify hash hash_equals random_bytes file_get_contents file_put_contents fopen fclose mkdir rmdir is_file is_dir file_exists dirname basename pathinfo parse_url sprintf vsprintf printf number_format abs ceil floor round min max array_map array_filter array_reduce array_column array_values array_keys array_unique array_merge array_search array_slice array_splice in_array sort asort ksort usort usort urlencode urldecode rawurlencode urlencode serialize unserialize gettype is_array is_string is_int is_numeric is_null is_bool is_object is_callable get_class method_exists property_exists class_exists function_exists defined define trigger_error error_log setcookie settype intval floatval strval preg_quote preg_split mb_strlen mb_substr mb_strtolower mb_strtoupper PDO PDOException PDOStatement DateTime DateTimeImmutable Exception RuntimeException InvalidArgumentException LogicException Throwable Generator Iterator IteratorAggregate Countable JsonSerializable Stringable Closure stdClass').split(' ');
const cssValuesByProperty = {
  display: 'block contents flex flow-root grid inline inline-block inline-flex inline-grid list-item none table'.split(' '),
  position: 'absolute fixed relative static sticky'.split(' '),
  'flex-direction': 'column column-reverse row row-reverse'.split(' '),
  'justify-content': 'center end flex-end flex-start space-around space-between space-evenly start'.split(' '),
  'align-items': 'baseline center end flex-end flex-start stretch'.split(' '),
  'text-align': 'center end justify left right start'.split(' '),
  'object-fit': 'contain cover fill none scale-down'.split(' '),
  overflow: 'auto clip hidden scroll visible'.split(' '),
  'font-weight': '100 200 300 400 500 600 700 800 900 bold lighter normal'.split(' '),
  'background-size': 'auto contain cover'.split(' ')
};

function scanCompletionNames(text, path) {
  const ext = extension(path);
  const classes = [], ids = [], variables = [], properties = [], identifiers = [], phpSymbols = [];
  if (['html', 'htm', 'vue', 'svg'].includes(ext)) {
    for (const match of text.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gs)) classes.push(...match[2].split(/\s+/).filter(Boolean));
    ids.push(...[...text.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gs)].map(match => match[2]).filter(Boolean));
  }
  if (['css', 'scss', 'less'].includes(ext)) {
    classes.push(...[...text.matchAll(/\.([_a-zA-Z][\w-]*)/g)].map(match => match[1]));
    ids.push(...[...text.matchAll(/#([_a-zA-Z][\w-]*)/g)].map(match => match[1]));
    variables.push(...[...text.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
    properties.push(...[...text.matchAll(/(?:^|[;{])\s*([a-zA-Z-][\w-]*)\s*:/gm)].map(match => match[1]));
  }
  if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'vue'].includes(ext)) {
    identifiers.push(...[...text.matchAll(/\b(?:const|let|var|function|class|import)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]));
    identifiers.push(...[...text.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g)].flatMap(match => [...match[1].matchAll(/[A-Za-z_$][\w$]*/g)].map(parameter => parameter[0])));
  }
  if (['php', 'phtml'].includes(ext)) {
    phpSymbols.push(...[...text.matchAll(/\b(?:function|class|trait|interface|enum|const)\s+([A-Za-z_][\w]*)/g)].map(match => match[1]));
    phpSymbols.push(...[...text.matchAll(/\$[A-Za-z_][\w]*/g)].map(match => match[0]));
  }
  return { classes, ids, variables, properties, identifiers, phpSymbols };
}

function updateCompletionIndex() {
  const all = [...completionSourceByPath].map(([path, text]) => scanCompletionNames(text, path));
  completionIndex = {
    classes: uniqueCompletions(all.flatMap(item => item.classes)),
    ids: uniqueCompletions(all.flatMap(item => item.ids)),
    variables: uniqueCompletions(all.flatMap(item => item.variables)),
    properties: uniqueCompletions(all.flatMap(item => item.properties)),
    identifiers: uniqueCompletions(all.flatMap(item => item.identifiers)),
    phpSymbols: uniqueCompletions(all.flatMap(item => item.phpSymbols))
  };
}

function scheduleCompletionIndexRefresh(entries = projectEntries) {
  const revision = ++completionIndexRevision;
  clearTimeout(completionIndexTimer);
  completionIndexTimer = setTimeout(async () => {
    const relevant = entries.filter(item => item.kind === 'file' && /\.(html?|vue|svg|css|scss|less|m?js|cjs|tsx?|php|phtml)$/i.test(item.path));
    const paths = new Set(relevant.map(item => item.path));
    completionSourceByPath = new Map([...completionSourceByPath].filter(([path]) => paths.has(path)));
    await Promise.all(relevant.map(async item => {
      if (editor && editorPath === item.path && activePath === item.path) completionSourceByPath.set(item.path, source());
      else if (!completionSourceByPath.has(item.path)) {
        try { completionSourceByPath.set(item.path, await fetchText(item.path)); } catch { }
      }
    }));
    if (revision === completionIndexRevision) updateCompletionIndex();
  }, 180);
}

function uniqueCompletions(items) {
  const seen = new Set();
  return items.filter(item => {
    const text = typeof item === 'string' ? item : item?.text;
    if (!text || seen.has(text)) return false;
    seen.add(text); return true;
  });
}

function completionMode(cm) {
  const token = cm.getTokenAt(cm.getCursor());
  return CodeMirror.innerMode(cm.getMode(), token.state).mode.name;
}

function projectCompletionItems(cm, baseResult) {
  const cursor = cm.getCursor(), line = cm.getLine(cursor.line), prefixLine = line.slice(0, cursor.ch);
  const mode = completionMode(cm), text = source();
  const htmlClasses = [...text.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gs)].flatMap(match => match[2].split(/\s+/)).filter(Boolean);
  const htmlIds = [...text.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gs)].map(match => match[2]).filter(Boolean);
  const cssClasses = [...text.matchAll(/\.([_a-zA-Z][\w-]*)/g)].map(match => match[1]);
  const cssIds = [...text.matchAll(/#([_a-zA-Z][\w-]*)/g)].map(match => match[1]);
  const candidates = [];
  let context = 'default';
  let overrideFrom = null;

  if (mode === 'htmlmixed' || mode === 'xml') {
    const pathValue = prefixLine.match(/(?:src|href|poster|action)\s*=\s*["']([^"']*)$/i);
    const classValue = prefixLine.match(/\bclass\s*=\s*["'][^"']*$/i);
    const idValue = prefixLine.match(/\bid\s*=\s*["'][^"']*$/i);
    const tagStart = prefixLine.match(/<([a-zA-Z][\w-]*)\s+[^<>]*$/);
    if (pathValue) {
      context = 'path';
      const entered = pathValue[1], slash = Math.max(entered.lastIndexOf('/'), entered.lastIndexOf('\\'));
      const directory = slash >= 0 ? entered.slice(0, slash + 1) : '';
      const tail = entered.slice(slash + 1);
      candidates.push(...projectEntries.filter(item => item.kind === 'file' || item.kind === 'directory').map(item => item.path).filter(path => path.startsWith(directory)).map(path => {
        const remainder = path.slice(directory.length), next = remainder.split('/')[0];
        return remainder.includes('/') && !next.includes('.') ? `${next}/` : next;
      }), './', '../', '#', 'mailto:');
      overrideFrom = CodeMirror.Pos(cursor.line, cursor.ch - tail.length);
    }
    else if (classValue) {
      context = 'class'; candidates.push(...htmlClasses, ...cssClasses, ...completionIndex.classes);
      const token = classValue[0].match(/[^\s]*$/)?.[0] || '';
      overrideFrom = CodeMirror.Pos(cursor.line, cursor.ch - token.length);
    }
    else if (idValue) { context = 'id'; candidates.push(...htmlIds, ...cssIds, ...completionIndex.ids); overrideFrom = CodeMirror.Pos(cursor.line, cursor.ch - idValue[0].split(/["']/).pop().length); }
    else if (tagStart) {
      context = 'attribute'; candidates.push(...htmlAttributeCompletions);
      const attribute = prefixLine.match(/<([a-zA-Z][\w-]*)\s+([\w:-]*)$/);
      if (attribute) overrideFrom = CodeMirror.Pos(cursor.line, cursor.ch - attribute[2].length);
    }
    else {
      candidates.push(...htmlTagCompletions);
      const tag = prefixLine.match(/<\/?([\w-]*)$/);
      if (tag) overrideFrom = CodeMirror.Pos(cursor.line, cursor.ch - tag[1].length);
    }
  } else if (mode === 'css') {
    const declaration = prefixLine.match(/^\s*([\w-]+)\s*:\s*([^;]*)$/);
    if (declaration) {
      context = 'value';
      const property = declaration[1].toLowerCase();
      candidates.push(...(cssValuesByProperty[property] || []), 'inherit', 'initial', 'revert', 'unset', 'var(--');
      candidates.push(...completionIndex.variables.map(name => `var(${name})`), ...[...text.matchAll(/(--[\w-]+)\s*:/g)].map(match => `var(${match[1]})`));
      if (/color|background|fill|stroke/i.test(property)) candidates.push('currentColor', 'transparent', '#fff', '#000', 'rgb()', 'hsl()');
      if (/width|height|margin|padding|gap|radius|size|top|left|right|bottom/i.test(property)) candidates.push('0', '100%', 'auto', '1rem', '2rem', '100vh', '100vw', 'min()', 'max()', 'clamp()');
    } else if (prefixLine.lastIndexOf('{') < prefixLine.lastIndexOf('}') || !prefixLine.slice(prefixLine.lastIndexOf('}')).includes('{')) {
      context = 'selector'; candidates.push(...htmlClasses.map(name => `.${name}`), ...cssClasses.map(name => `.${name}`), ...completionIndex.classes.map(name => `.${name}`), ...htmlIds.map(name => `#${name}`), ...cssIds.map(name => `#${name}`), ...completionIndex.ids.map(name => `#${name}`), ...htmlTagCompletions);
    } else candidates.push(...cssPropertyCompletions, ...completionIndex.properties);
  } else if (mode === 'php') {
    const pathValue = prefixLine.match(/\b(?:include|include_once|require|require_once)\s*\(?\s*(['"])([^'"]*)$/i);
    if (pathValue) {
      context = 'path';
      const entered = pathValue[2], slash = Math.max(entered.lastIndexOf('/'), entered.lastIndexOf('\\'));
      const directory = slash >= 0 ? entered.slice(0, slash + 1) : '';
      const tail = entered.slice(slash + 1);
      candidates.push(...projectEntries.filter(item => item.kind === 'file' || item.kind === 'directory').map(item => item.path).filter(path => path.startsWith(directory)).map(path => {
        const remainder = path.slice(directory.length), next = remainder.split('/')[0];
        return remainder.includes('/') && !next.includes('.') ? `${next}/` : next;
      }));
      overrideFrom = CodeMirror.Pos(cursor.line, cursor.ch - tail.length);
    } else {
      context = 'php';
      candidates.push(...phpCompletions, ...completionIndex.phpSymbols);
      const token = prefixLine.match(/\$?[A-Za-z_][\w$]*$/)?.[0] || '';
      if (token) overrideFrom = CodeMirror.Pos(cursor.line, cursor.ch - token.length);
    }
  } else {
    context = 'javascript';
    const identifiers = [...text.matchAll(/\b(?:const|let|var|function|class|import)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
    candidates.push(...identifiers, ...completionIndex.identifiers, ...'Array async await Boolean class const Date document Error fetch function Infinity JSON let Math NaN Number Object Promise RegExp Set String window console debugger export false for if import new null return this throw true try typeof undefined var'.split(' '));
  }

  const base = baseResult?.list || [];
  candidates.push(...base);
  let from = overrideFrom || baseResult?.from || CodeMirror.Pos(cursor.line, cursor.ch);
  const to = baseResult?.to || CodeMirror.Pos(cursor.line, cursor.ch);
  let query = cm.getRange(from, cursor);
  if (context === 'path') query = cm.getRange(from, cursor);
  else if (context === 'class' || context === 'id') {
    query = query.split(/\s/).pop();
    from = CodeMirror.Pos(cursor.line, cursor.ch - query.length);
  } else if (context === 'attribute') {
    query = cm.getRange(from, cursor);
  } else if (context === 'selector') {
    query = query.split(/[\s>+~]/).pop();
    from = CodeMirror.Pos(cursor.line, cursor.ch - query.length);
  }
  const normalizedQuery = query.toLowerCase();
  const results = uniqueCompletions(candidates).filter(item => {
    const value = typeof item === 'string' ? item : item?.text;
    return value && value.toLowerCase().startsWith(normalizedQuery);
  }).slice(0, 120);
  return { list: results, from, to };
}

function showProjectHints(cm = editor) {
  const mode = completionMode(cm);
  const provider = mode === 'css' ? CodeMirror.hint.css : mode === 'javascript' ? CodeMirror.hint.javascript : null;
  const baseResult = provider ? provider(cm) : null;
  const hint = projectCompletionItems(cm, baseResult);
  cm.showHint({ hint: () => hint, completeSingle: false, alignWithWord: true });
}

function snippetMessage(message, error = false) {
  const output = byId('snippetMessage'); output.textContent = message; output.classList.toggle('error', error);
}

async function snippetRequest(method = 'GET', snippets = undefined) {
  const response = await fetch('/api/snippets', {
    method,
    headers: method === 'PUT' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'PUT' ? JSON.stringify({ snippets }) : undefined
  });
  const result = await response.json().catch(() => []);
  if (!response.ok) throw new Error(result.error || `Snippet library request failed (${response.status}).`);
  return result;
}

function openSnippets() {
  byId('snippetModal').style.display = 'grid';
  byId('snippetsBtn').classList.add('active');
  byId('snippetSearch').value = '';
  byId('snippetSearch').focus();
  snippetMessage('Loading saved snippets…');
  loadSnippetLibrary();
}

async function loadSnippetLibrary() {
  try {
    codeSnippets = await snippetRequest();
    if (selectedSnippetId && !codeSnippets.some(item => item.id === selectedSnippetId)) selectedSnippetId = null;
    renderSnippetList();
    if (selectedSnippetId) selectSnippet(selectedSnippetId);
    else if (codeSnippets.length) selectSnippet(codeSnippets[0].id);
    else newSnippet();
    snippetMessage(`${codeSnippets.length} saved snippet${codeSnippets.length === 1 ? '' : 's'} · stored in DreamCraft settings.`);
  } catch (error) { snippetMessage(error.message, true); renderSnippetList(); }
}

function renderSnippetList() {
  const list = byId('snippetList'); list.replaceChildren();
  const query = byId('snippetSearch').value.trim().toLowerCase();
  const snippets = codeSnippets.filter(item => `${item.name} ${item.category} ${item.trigger} ${item.description}`.toLowerCase().includes(query));
  if (!snippets.length) {
    const empty = document.createElement('div'); empty.className = 'snippet-empty';
    empty.textContent = query ? 'No snippets match this search.' : 'Your snippet library is empty. Create a reusable code block to get started.';
    list.appendChild(empty); return;
  }
  for (const item of snippets) {
    const row = document.createElement('div'); row.className = `snippet-row${item.id === selectedSnippetId ? ' selected' : ''}`;
    row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `${item.name}, ${item.category}`);
    row.appendChild(document.createTextNode(item.name));
    const detail = document.createElement('small'); detail.textContent = `${item.category}${item.trigger ? ` · ${item.trigger}` : ''}${item.description ? ` · ${item.description}` : ''}`;
    row.appendChild(detail);
    row.addEventListener('click', () => selectSnippet(item.id));
    row.addEventListener('dblclick', () => insertSnippet(item.id));
    row.addEventListener('keydown', event => { if (event.key === 'Enter') selectSnippet(item.id); if (event.key === ' ') { event.preventDefault(); insertSnippet(item.id); } });
    list.appendChild(row);
  }
}

function selectSnippet(id) {
  if (snippetEditorDirty && id !== selectedSnippetId) { snippetMessage('Save or discard the current changes before selecting another snippet.', true); return; }
  const item = codeSnippets.find(entry => entry.id === id); if (!item) return;
  selectedSnippetId = id; snippetEditorDirty = false;
  byId('snippetName').value = item.name;
  byId('snippetCategory').value = item.category;
  byId('snippetTrigger').value = item.trigger;
  byId('snippetDescription').value = item.description;
  byId('snippetSyntax').value = item.syntax;
  byId('snippetMode').value = item.mode;
  byId('snippetCode').value = item.code;
  byId('snippetDelete').disabled = false;
  byId('snippetInsert').disabled = false;
  byId('snippetDiscard').disabled = true;
  byId('snippetSave').textContent = 'Save changes';
  renderSnippetList();
}

function newSnippet() {
  if (snippetEditorDirty) { snippetMessage('Save or discard the current changes before creating another snippet.', true); return; }
  selectedSnippetId = null; snippetEditorDirty = false;
  for (const id of ['snippetName', 'snippetCategory', 'snippetTrigger', 'snippetDescription', 'snippetCode']) byId(id).value = '';
  byId('snippetSyntax').value = 'htmlmixed'; byId('snippetMode').value = 'insert';
  byId('snippetDelete').disabled = true; byId('snippetInsert').disabled = true;
  byId('snippetDiscard').disabled = true;
  byId('snippetSave').textContent = 'Save snippet';
  renderSnippetList(); byId('snippetName').focus();
}

function currentSnippet() {
  return {
    id: selectedSnippetId || crypto.randomUUID(),
    name: byId('snippetName').value.trim(),
    category: byId('snippetCategory').value.trim(),
    trigger: byId('snippetTrigger').value.trim(),
    description: byId('snippetDescription').value.trim(),
    syntax: byId('snippetSyntax').value,
    mode: byId('snippetMode').value,
    code: byId('snippetCode').value
  };
}

async function saveSnippet() {
  const item = currentSnippet();
  if (!item.name || !item.category || !item.code.trim()) return snippetMessage('Name, category, and code are required.', true);
  if (item.mode === 'wrap' && !item.code.includes('${selection}')) return snippetMessage('A wrap-selection snippet must include ${selection} where the selected code belongs.', true);
  const conflict = codeSnippets.find(entry => entry.id !== item.id && entry.name.toLowerCase() === item.name.toLowerCase() && entry.category.toLowerCase() === item.category.toLowerCase());
  if (conflict) return snippetMessage('A snippet with that name already exists in this category.', true);
  const next = [...codeSnippets.filter(entry => entry.id !== item.id), item];
  try {
    codeSnippets = await snippetRequest('PUT', next); selectedSnippetId = item.id; snippetEditorDirty = false;
    renderSnippetList(); selectSnippet(item.id); snippetMessage(`Saved “${item.name}”.`);
  } catch (error) { snippetMessage(error.message, true); }
}

async function deleteSnippet() {
  if (snippetEditorDirty) return snippetMessage('Save or discard the current changes before deleting a snippet.', true);
  const item = codeSnippets.find(entry => entry.id === selectedSnippetId); if (!item) return;
  try {
    codeSnippets = await snippetRequest('PUT', codeSnippets.filter(entry => entry.id !== item.id));
    selectedSnippetId = null; renderSnippetList();
    if (codeSnippets.length) selectSnippet(codeSnippets[0].id); else newSnippet();
    snippetMessage(`Deleted “${item.name}”.`);
  } catch (error) { snippetMessage(error.message, true); }
}

function insertSnippet(id, close = true) {
  if (snippetEditorDirty && byId('snippetModal').style.display === 'grid') return snippetMessage('Save or discard the current changes before inserting a snippet.', true);
  const item = codeSnippets.find(entry => entry.id === id); if (!item) return;
  const selection = editor.getSelection();
  const output = item.mode === 'wrap' ? item.code.replaceAll('${selection}', selection) : item.code;
  if (!activePath) return toast('Open a source file before inserting a snippet.');
  setView('code');
  editor.replaceSelection(output, 'complete'); editor.focus();
  if (close) { byId('snippetModal').style.display = 'none'; byId('snippetsBtn').classList.remove('active'); }
  toast(`Inserted “${item.name}”`);
}

function discardSnippetChanges() {
  snippetEditorDirty = false;
  if (selectedSnippetId) selectSnippet(selectedSnippetId);
  else newSnippet();
  snippetEditorDirty = false;
  byId('snippetDiscard').disabled = true;
  byId('snippetInsert').disabled = !selectedSnippetId;
  snippetMessage('Unsaved changes discarded.');
}

function closeSnippets() {
  if (snippetEditorDirty) return snippetMessage('Save or discard your changes before closing the snippet library.', true);
  byId('snippetModal').style.display = 'none';
  byId('snippetsBtn').classList.remove('active');
}

function exportSnippets() {
  const blob = new Blob([JSON.stringify({ version: 1, snippets: codeSnippets }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = 'dreamcraft-snippets.json'; link.click(); URL.revokeObjectURL(url);
}

async function importSnippets(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = Array.isArray(parsed) ? parsed : parsed.snippets;
    if (!Array.isArray(incoming)) throw new Error('Choose a DreamCraft snippet JSON export.');
    const merged = [...codeSnippets];
    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object') throw new Error('The snippet file contains an invalid entry.');
      const item = { id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(), name: raw.name, category: raw.category, trigger: raw.trigger || '', description: raw.description || '', syntax: ['htmlmixed', 'css', 'javascript', 'json', 'xml', 'text'].includes(raw.syntax) ? raw.syntax : 'text', mode: raw.mode === 'wrap' ? 'wrap' : 'insert', code: raw.code };
      const index = merged.findIndex(entry => entry.name?.toLowerCase() === String(item.name).toLowerCase() && entry.category?.toLowerCase() === String(item.category).toLowerCase());
      if (index >= 0) merged[index] = { ...item, id: merged[index].id };
      else { if (merged.some(entry => entry.id === item.id)) item.id = crypto.randomUUID(); merged.push(item); }
    }
    codeSnippets = await snippetRequest('PUT', merged); selectedSnippetId = null; renderSnippetList();
    if (codeSnippets.length) selectSnippet(codeSnippets.at(-1).id); else newSnippet();
    snippetMessage(`Imported ${incoming.length} snippet${incoming.length === 1 ? '' : 's'}.`);
  } catch (error) { snippetMessage(error.message, true); }
}

let preprocessorWatchEnabled = false;
let preprocessorWatchTimer = null;
let preprocessorBuildBusy = false;
let preprocessorFingerprint = '';
let preprocessorOutputByPath = {};
const preprocessorResultMessages = new Map();
try {
  preprocessorWatchEnabled = localStorage.getItem('dreamcraft.preprocessor.watch') !== 'false';
  preprocessorOutputByPath = JSON.parse(localStorage.getItem('dreamcraft.preprocessor.outputs') || '{}');
  if (!preprocessorOutputByPath || typeof preprocessorOutputByPath !== 'object' || Array.isArray(preprocessorOutputByPath)) preprocessorOutputByPath = {};
} catch {}

function preprocessorOutput(path) {
  const value = preprocessorOutputByPath[path];
  return typeof value === 'string' && value ? value : path.replace(/\.(?:scss|sass|less)$/i, '.css');
}

function isPreprocessorPath(path) { return /\.(?:scss|sass|less)$/i.test(path); }

function preprocessorSourceForOutput(path) {
  return projectEntries.find(item => item.kind === 'file' && isPreprocessorPath(item.path)
    && preprocessorOutput(item.path).toLowerCase() === path.replaceAll('\\', '/').toLowerCase());
}

function preprocessorStatus(message, error = false) {
  const status = byId('preprocessorStatus');
  status.textContent = message;
  status.classList.toggle('error', error);
}

function setPreprocessorRowStatus(path, message, error = false) {
  preprocessorResultMessages.set(path, { message, error });
  const status = document.querySelector(`[data-preprocessor-status="${CSS.escape(path)}"]`);
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', error);
}

function savePreprocessorOutputs() {
  try { localStorage.setItem('dreamcraft.preprocessor.outputs', JSON.stringify(preprocessorOutputByPath)); }
  catch { preprocessorStatus('Output locations could not be saved in DreamCraft settings.', true); }
}

function validPreprocessorOutput(path) {
  const normalized = path.trim().replaceAll('\\', '/');
  return normalized.length > 0 && normalized.length <= 1024 && /\.css$/i.test(normalized)
    && normalized.split('/').every(part => part && part !== '.' && part !== '..')
    && !normalized.split('/').some(part => part.toLowerCase() === '.git' || part.toLowerCase() === '.dreamcraft');
}

function renderPreprocessorRows() {
  const list = byId('preprocessorSources');
  list.replaceChildren();
  const sources = projectEntries.filter(item => item.kind === 'file' && isPreprocessorPath(item.path));
  byId('preprocessorCount').textContent = `${sources.length} source file${sources.length === 1 ? '' : 's'}`;
  byId('preprocessorRun').disabled = sources.length === 0 || preprocessorBuildBusy;
  if (!sources.length) {
    const empty = document.createElement('div');
    empty.className = 'preprocessor-empty';
    empty.textContent = 'No Sass, SCSS, or Less sources are in this website yet. Create a .scss, .sass, or .less file in the site explorer to compile it here.';
    list.appendChild(empty);
    return;
  }
  for (const item of sources) {
    const row = document.createElement('div'); row.className = 'preprocessor-row'; row.dataset.path = item.path;
    const source = document.createElement('div'); source.className = 'preprocessor-source'; source.title = item.path;
    const badge = document.createElement('span'); badge.className = 'preprocessor-kind'; badge.textContent = extension(item.path).toUpperCase();
    const name = document.createElement('span'); name.className = 'preprocessor-source-name'; name.textContent = item.path;
    source.append(badge, name);
    const output = document.createElement('input'); output.className = 'preprocessor-output'; output.type = 'text'; output.value = preprocessorOutput(item.path);
    output.setAttribute('aria-label', `CSS output path for ${item.path}`); output.title = 'Project-relative .css output path';
    output.addEventListener('input', () => {
      const normalized = output.value.trim().replaceAll('\\', '/');
      output.classList.toggle('invalid', !validPreprocessorOutput(normalized));
      if (validPreprocessorOutput(normalized)) preprocessorOutputByPath[item.path] = normalized;
      else delete preprocessorOutputByPath[item.path];
      savePreprocessorOutputs();
    });
    output.addEventListener('change', () => {
      output.value = preprocessorOutput(item.path);
      output.classList.toggle('invalid', !validPreprocessorOutput(output.value));
      refreshPreprocessorRowsFromMemory();
    });
    const build = document.createElement('button'); build.type = 'button'; build.className = 'btn'; build.textContent = 'Compile';
    build.addEventListener('click', () => compilePreprocessorFile(item.path).catch(error => preprocessorStatus(error.message, true)));
    const status = document.createElement('div'); status.className = 'preprocessor-row-status'; status.dataset.preprocessorStatus = item.path;
    const result = preprocessorResultMessages.get(item.path);
    status.textContent = result?.message || '';
    status.classList.toggle('error', Boolean(result?.error));
    row.append(source, output, build, status); list.appendChild(row);
  }
}

function refreshPreprocessorRowsFromMemory() {
  for (const row of byId('preprocessorSources').querySelectorAll('.preprocessor-row')) {
    const output = row.querySelector('.preprocessor-output');
    output.value = preprocessorOutput(row.dataset.path);
    output.classList.toggle('invalid', !validPreprocessorOutput(output.value));
  }
}

async function refreshPreprocessorSources() {
  const response = await fetch('/api/files');
  if (!response.ok) throw new Error('Could not scan the active website for Sass and Less files.');
  projectEntries = await response.json();
  renderPreprocessorRows();
  return projectEntries.filter(item => item.kind === 'file' && isPreprocessorPath(item.path));
}

function siteAssetUrl(path) {
  return `${location.origin}/site/${encodeProjectPath(path)}`;
}

async function compilePreprocessorFile(path, options = {}) {
  const output = preprocessorOutput(path).trim().replaceAll('\\', '/');
  if (!validPreprocessorOutput(output)) throw new Error(`Choose a safe project-relative .css output path for ${path}.`);
  const outputOwner = projectEntries.find(item => item.kind === 'file' && item.path !== path && isPreprocessorPath(item.path)
    && preprocessorOutput(item.path).toLowerCase() === output.toLowerCase());
  if (outputOwner) throw new Error(`${output} is already assigned to ${outputOwner.path}. Give each source a different CSS output path.`);
  if (activePath === path && dirty && !(await save())) throw new Error(`Save ${path} before compiling it.`);
  setPreprocessorRowStatus(path, 'Compiling…');
  try {
    let css;
    if (extension(path) === 'less') {
      if (!window.less?.render) throw new Error('The bundled Less compiler did not load. Restart DreamCraft and try again.');
      const content = activePath === path ? source() : await fetchText(path);
      const folder = relativeDirectory(path);
      const compiled = await window.less.render(content, {
        filename: siteAssetUrl(path),
        paths: [siteAssetUrl(folder)],
        javascriptEnabled: false,
        math: 'parens-division',
        sourceMap: { outputSourceFiles: false }
      });
      css = compiled.css;
    } else {
      const response = await fetch('/api/preprocessors/sass', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, output, style: byId('preprocessorStyle').value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Could not compile ${path}.`);
      setPreprocessorRowStatus(path, `Built ${result.output} · ${result.bytes.toLocaleString()} bytes`);
      if (!options.silent) preprocessorStatus(`${path} compiled to ${result.output}.`);
      return result;
    }
    if (typeof css !== 'string' || css.length > 32 * 1024 * 1024) throw new Error('The generated stylesheet is empty or exceeds the 32 MB output limit.');
    const response = await fetch(apiPath(output), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: css })
    });
    if (!response.ok) throw new Error(`DreamCraft could not save generated CSS at ${output}.`);
    setPreprocessorRowStatus(path, `Built ${output} · ${new TextEncoder().encode(css).length.toLocaleString()} bytes`);
    if (!options.silent) preprocessorStatus(`${path} compiled to ${output}.`);
    return { path, output, bytes: new TextEncoder().encode(css).length };
  } catch (error) {
    setPreprocessorRowStatus(path, error.message || 'Compilation failed.', true);
    if (!options.silent) preprocessorStatus(`${path}: ${error.message}`, true);
    throw error;
  }
}

async function runPreprocessorBuild(options = {}) {
  if (preprocessorBuildBusy) return;
  if (dirty && !(await save())) { preprocessorStatus('Save the active document before compiling stylesheets.', true); return; }
  let sources;
  try { sources = await refreshPreprocessorSources(); }
  catch (error) { preprocessorStatus(error.message, true); return; }
  if (!sources.length) { preprocessorStatus('No Sass, SCSS, or Less source files were found.'); return; }
  preprocessorBuildBusy = true;
  byId('preprocessorRun').disabled = true;
  for (const button of byId('preprocessorSources').querySelectorAll('.preprocessor-row .btn')) button.disabled = true;
  let built = 0, failed = 0;
  preprocessorStatus(`Compiling 0 of ${sources.length} source files…`);
  try {
    for (let index = 0; index < sources.length; index++) {
      const item = sources[index];
      preprocessorStatus(`Compiling ${index + 1} of ${sources.length}: ${item.path}`);
      try { await compilePreprocessorFile(item.path, { silent: true }); built++; }
      catch { failed++; }
    }
    preprocessorStatus(failed ? `Built ${built} stylesheet${built === 1 ? '' : 's'}; ${failed} failed. Review the highlighted rows.` : `Built ${built} stylesheet${built === 1 ? '' : 's'} successfully.` , failed > 0);
    if (built) {
      await loadTree();
      if (['html', 'htm'].includes(extension(activePath)) || isPreprocessorPath(activePath)) await renderPreview();
      refreshCssFiles();
      refreshVisualMediaQueries();
    }
  } finally {
    preprocessorBuildBusy = false;
    byId('preprocessorRun').disabled = false;
    for (const button of byId('preprocessorSources').querySelectorAll('.preprocessor-row .btn')) button.disabled = false;
    renderPreprocessorRows();
  }
}

async function pollPreprocessorWatch() {
  if (!preprocessorWatchEnabled || preprocessorBuildBusy) return;
  try {
    const response = await fetch('/api/files');
    if (!response.ok) return;
    const files = await response.json();
    const generatedCss = new Set([
      ...Object.values(preprocessorOutputByPath).map(value => String(value).replaceAll('\\', '/')),
      ...files.filter(item => item.kind === 'file' && isPreprocessorPath(item.path)).map(item => preprocessorOutput(item.path))
    ]);
    const watched = files.filter(item => item.kind === 'file' && /\.(?:sass|scss|less|css)$/i.test(item.path)
      && !generatedCss.has(item.path.replaceAll('\\', '/')))
      .map(item => [item.path, item.size, item.modified_ms]);
    const project = byId('projectLocation').textContent;
    const nextFingerprint = `${project}\n${JSON.stringify(watched)}`;
    if (!preprocessorFingerprint) {
      preprocessorFingerprint = nextFingerprint;
      await runPreprocessorBuild({ silent: true });
      return;
    }
    if (nextFingerprint !== preprocessorFingerprint) {
      preprocessorFingerprint = nextFingerprint;
      await runPreprocessorBuild({ silent: true });
      if (byId('preprocessorModal').style.display === 'grid') preprocessorStatus('Watched stylesheet sources changed; builds are up to date.');
    }
  } catch (error) {
    if (byId('preprocessorModal').style.display === 'grid') preprocessorStatus(`Watch scan failed: ${error.message}`, true);
  }
}

function startPreprocessorWatch() {
  if (preprocessorWatchTimer) clearInterval(preprocessorWatchTimer);
  preprocessorWatchTimer = setInterval(pollPreprocessorWatch, 1400);
  if (preprocessorWatchEnabled) pollPreprocessorWatch();
}

async function openPreprocessorDialog() {
  byId('preprocessorModal').style.display = 'grid';
  byId('preprocessorWatch').checked = preprocessorWatchEnabled;
  byId('preprocessorStyle').value = localStorage.getItem('dreamcraft.preprocessor.style') === 'compressed' ? 'compressed' : 'expanded';
  preprocessorStatus('Scanning the active website…');
  try {
    const sources = await refreshPreprocessorSources();
    preprocessorStatus(sources.length ? 'Choose Compile to build the selected stylesheets. Imported partials and CSS files are resolved automatically.' : 'Add a .scss, .sass, or .less file in the site explorer to enable builds.');
  } catch (error) { preprocessorStatus(error.message, true); }
}

function closePreprocessorDialog() { byId('preprocessorModal').style.display = 'none'; }

const commandActions = [
  { label: 'Save current file', detail: 'Write editor changes to the active website', icon: '↧', shortcut: 'Ctrl S', run: () => save() },
  { label: 'Expand Emmet abbreviation', detail: 'Expand the abbreviation at the cursor, or press Tab in HTML and CSS', icon: '⇥', shortcut: 'Tab', run: () => { if (!expandEmmetAtCursor(editor)) toast('Place the cursor after a supported HTML or CSS abbreviation.'); } },
  { label: 'Format current file', detail: 'Format with the bundled Prettier engine', icon: '⟲', shortcut: 'Shift Alt F', run: () => formatCurrentFile() },
  { label: 'Check current page', detail: 'Run HTML, reference, accessibility, CSS, and JavaScript checks', icon: '✓', run: () => validateCurrentFile() },
  { label: 'Run site reports', detail: 'Scan every project page for links, accessibility, duplicate IDs, and metadata issues', icon: '▤', run: () => openSiteReports() },
  { label: 'Open code snippets', detail: 'Create, organize, import, export, and insert reusable code blocks', icon: '</>', run: () => openSnippets() },
  { label: 'Manage site templates', detail: 'Create templates, mark editable regions, and update dependent pages', icon: '▧', run: () => openTemplates() },
  { label: 'Mark selection editable', detail: 'Wrap the selected template HTML in a named editable region', icon: '▧', run: () => markTemplateSelectionEditable() },
  { label: 'Mark selection optional', detail: 'Show or hide template content per page', icon: '◉', run: () => markTemplateSelectionOptional() },
  { label: 'Mark selection repeating', detail: 'Create a named Dreamweaver-compatible repeating entry', icon: '↻', run: () => markTemplateSelectionRepeating() },
  { label: 'Fold code block', detail: 'Collapse the HTML, CSS, or JavaScript block at the cursor', icon: '⌄', shortcut: 'Ctrl Q', run: () => editor.foldCode(editor.getCursor()) },
  { label: 'Fold all code blocks', detail: 'Collapse every foldable section in the current document', icon: '⊟', run: () => editor.execCommand('foldAll') },
  { label: 'Unfold all code blocks', detail: 'Expand every collapsed section in the current document', icon: '⊞', run: () => editor.execCommand('unfoldAll') },
  { label: 'Find in project', detail: 'Search and review replacements across project source', icon: '⌕', shortcut: 'Ctrl Shift F', run: () => openSearch() },
  { label: 'Design view', detail: 'Edit the rendered page visually', icon: '◫', run: () => setView('design') },
  { label: 'Split view', detail: 'Edit source beside the live page', icon: '◧', run: () => setView('split') },
  { label: 'Code view', detail: 'Edit the current file in the source editor', icon: '</>', run: () => setView('code') },
  { label: 'Code / Code split view', detail: 'Show two source panes with independent scroll and cursors', icon: '▥', run: () => setView('code-split') },
  { label: 'Reset workspace panel sizes', detail: 'Restore the default file and inspector panel widths', icon: '↔', group: 'Workspace', run: () => { window.resetWorkspacePanelSizes?.(); toast('Workspace panels restored to their default widths'); } },
  { label: 'Manage workspace layouts', detail: 'Dock panels and save or restore named workspace arrangements', icon: '▥', group: 'Workspace', run: () => openWorkspaceLayouts() },
  { label: 'Toggle Files panel', detail: 'Show or hide the project file explorer', icon: '▤', group: 'Workspace', run: () => window.toggleWorkspacePanel?.('explorer') },
  { label: 'Toggle Inspector panel', detail: 'Show or hide the properties and CSS Designer inspector', icon: '◫', group: 'Workspace', run: () => window.toggleWorkspacePanel?.('inspector') },
  { label: 'Refresh live preview', detail: 'Rebuild the isolated page preview from saved project files', icon: '⟳', shortcut: 'F5', run: () => renderPreview() },
  { label: 'Compile Sass, SCSS, and Less', detail: 'Build project preprocessor files into linked CSS stylesheets', icon: '◈', run: () => openPreprocessorDialog() },
  { label: 'Manage websites', detail: 'Open a website folder or create a site', icon: '▰', run: () => openProjectManager() },
  { label: 'Open Git panel', detail: 'Review changes, commits, history, and remotes', icon: '⑂', run: () => openGit() },
  { label: 'Open Dream AI', detail: 'Ask the configured design and code copilot', icon: '✳', run: () => openAi() },
  { label: 'Publish website', detail: 'Preview a release or configure a publishing target', icon: '↗', run: () => openPublishDialog() },
  { label: 'Browse snapshots', detail: 'Create, review, and restore project recovery points', icon: '◷', run: () => openSnapshotDialog() },
  { label: 'Create a new file', detail: 'Add a project-relative file with a useful starter document', icon: '＋', run: () => byId('newFileBtn').click() },
  { label: 'Create a new folder', detail: 'Add a folder to the active website', icon: '▱', run: () => byId('newFolderBtn').click() },
  { label: 'Create and attach stylesheet', detail: 'Create a CSS file and link it from the open HTML page', icon: '◈', run: () => { setView('design'); document.querySelector('[data-inspector="cssDesignerPane"]').click(); byId('cssCreateSource').click(); } },
  { label: 'Create Bootstrap starter page', detail: 'Add a complete responsive Bootstrap 5.3 page and local framework assets', icon: 'B', group: 'Insert', run: () => createBootstrapStarter() },
  { label: 'Configure dynamic testing server', detail: 'Run the current site with PHP, Node, Python, or another local runtime', icon: '⇥', group: 'Preview', run: () => openTestingServerDialog() },
  { label: 'Project databases', detail: 'Create SQLite databases, inspect schema, and run SQL', icon: '▦', group: 'Project', run: () => openDatabaseDialog() },
  { label: 'Add images or fonts', detail: 'Copy selected assets into this project', icon: '⇧', run: () => byId('uploadBtn').click() },
  { label: 'Open project asset library', detail: 'Browse, preview, search, and insert project media', icon: '▧', run: openAssetLibrary },
  { label: 'Show all project files', detail: 'Clear the explorer asset filter', icon: '≡', run: () => { if (filterAssets) byId('assetsBtn').click(); } },
  { label: 'Open CSS Designer', detail: 'Inspect matching rules for the selected visual element', icon: '◈', run: () => { setView('design'); document.querySelector('[data-inspector="cssDesignerPane"]').click(); } },
  { label: 'Open element properties', detail: 'Inspect and visually edit the selected page element', icon: '⚙', run: () => { setView('design'); document.querySelector('[data-inspector="propertiesPane"]').click(); } },
  ...['section', 'heading', 'paragraph', 'image', 'link', 'button', 'list', 'container'].map(type => ({
    label: `Insert ${type}`, detail: 'Insert a complete editable HTML element at the source cursor', icon: '＋', group: 'Insert', run: () => { setView('code'); insertMarkup(type); }
  }))
];

async function createBootstrapStarter() {
  if (!(await save())) return toast('Save the current page before creating a Bootstrap starter.');
  try {
    const response = await fetch('/api/bootstrap/create', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not create the Bootstrap starter page.');
    await loadTree();
    await openFile(result.path);
    toast(`Created ${result.path} with local Bootstrap assets`);
  } catch (error) { toast(error.message); }
}

const testingPresets = {
  php: { command: 'php', arguments: ['-S', '127.0.0.1:{port}', '-t', '{project}'] },
  node: { command: 'node', arguments: ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '{port}'] },
  python: { command: 'python', arguments: ['-m', 'http.server', '{port}', '--bind', '127.0.0.1', '--directory', '{project}'] }
};

function testingServerMessage(text, isError = false) {
  const element = byId('testingServerMessage');
  element.textContent = text;
  element.classList.remove('hide', 'git-error');
  if (isError) element.classList.add('git-error');
}

function testingServerSettingsFromForm() {
  return {
    command: byId('testingCommand').value.trim(),
    arguments: byId('testingArguments').value.split(/\r?\n/).filter(argument => argument.length > 0)
  };
}

async function refreshTestingServerStatus() {
  try {
    const response = await fetch('/api/testing/status');
    const status = await response.json();
    byId('testingServerStop').disabled = !status.running;
    if (status.running) testingServerMessage(`Testing server is running at ${status.url}`);
    else if (!byId('testingServerMessage').classList.contains('git-error')) byId('testingServerMessage').classList.add('hide');
  } catch (error) { testingServerMessage(`Could not read testing-server status: ${error.message}`, true); }
}

let selectedDatabasePath = '';
let selectedDatabaseTable = null;
const remoteDatabaseOption = '@remote';

function databaseFormatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function databaseMessage(message, isError = false) {
  const output = byId('databaseMessage');
  output.textContent = message;
  output.classList.toggle('database-error', isError);
}

async function databaseRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Database request failed with HTTP ${response.status}.`);
  }
  return response.status === 204 ? null : response.json();
}

async function refreshDatabases(preferredPath = selectedDatabasePath) {
  const select = byId('databaseSelect');
  select.replaceChildren();
  const databases = await databaseRequest('/api/database/files');
  const remote = await databaseRequest('/api/database/remote/connection');
  byId('remoteDbDisconnect').disabled = !remote.connected;
  byId('remoteDbStatus').textContent = remote.connected ? `Connected · ${remote.engine} · ${remote.host}:${remote.port}/${remote.database}` : 'Disconnected';
  if (remote.connected) {
    byId('remoteDbEngine').value = remote.engine;
    byId('remoteDbName').value = remote.name;
    byId('remoteDbHost').value = remote.host;
    byId('remoteDbPort').value = remote.port;
    byId('remoteDbDatabase').value = remote.database;
    byId('remoteDbUsername').value = remote.username;
    byId('remoteDbTls').checked = remote.tls;
    const option = document.createElement('option'); option.value = remoteDatabaseOption; option.textContent = `Remote · ${remote.name} (${remote.engine})`; select.appendChild(option);
  }
  for (const database of databases) {
    const option = document.createElement('option'); option.value = database.path; option.textContent = `${database.path} · ${databaseFormatBytes(database.size)}`; select.appendChild(option);
  }
  if (!select.options.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No database connected or found'; select.appendChild(option); }
  const options = [...select.options].map(option => option.value);
  const nextDatabasePath = options.includes(preferredPath) ? preferredPath : options.find(value => value === remoteDatabaseOption) || databases[0]?.path || '';
  if (nextDatabasePath !== selectedDatabasePath) selectedDatabaseTable = null;
  selectedDatabasePath = nextDatabasePath;
  select.value = selectedDatabasePath;
  byId('databaseCreate').disabled = selectedDatabasePath === remoteDatabaseOption;
  await loadDatabaseSchema();
}

async function loadDatabaseSchema() {
  selectedDatabasePath = byId('databaseSelect').value;
  const root = byId('databaseSchema'); root.replaceChildren();
  const preferredTableName = selectedDatabaseTable?.name;
  selectedDatabaseTable = null;
  byId('databaseGeneratePhp').disabled = true;
  byId('databaseCreate').disabled = selectedDatabasePath === remoteDatabaseOption;
  byId('databasePhpTableStatus').textContent = 'Choose a table or view above to generate a page.';
  if (!selectedDatabasePath) return;
  if (selectedDatabasePath === remoteDatabaseOption) {
    byId('databaseGeneratePhp').disabled = true;
    byId('databaseCreate').disabled = true;
  }
  databaseMessage(`Inspecting ${selectedDatabasePath === remoteDatabaseOption ? 'remote database' : selectedDatabasePath}…`);
  try {
    const { tables } = selectedDatabasePath === remoteDatabaseOption
      ? await databaseRequest('/api/database/remote/schema', { method: 'POST', body: '{}' })
      : await databaseRequest('/api/database/schema', { method: 'POST', body: JSON.stringify({ path: selectedDatabasePath }) });
    if (!tables.length) { root.appendChild(Object.assign(document.createElement('div'), { className: 'database-empty', textContent: 'This database has no user tables or views yet.' })); }
    for (const table of tables) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'database-object';
      const name = document.createElement('span'); name.textContent = `${table.kind === 'view' ? '◉' : '▦'} ${table.name}`;
      const detail = document.createElement('small'); detail.textContent = table.columns.map(column => `${column.name} ${column.type || 'ANY'}${column.primaryKeyOrder > 0 ? ' · PK' : ''}`).join('\n') || 'No columns';
      button.append(name, detail);
      button.addEventListener('click', () => selectDatabaseTable(table));
      root.appendChild(button);
    }
    const preservedTable = tables.find(table => table.name === preferredTableName);
    if (preservedTable) selectDatabaseTable(preservedTable, false);
    databaseMessage(`${tables.length} table${tables.length === 1 ? '' : 's'} and views · ${selectedDatabasePath === remoteDatabaseOption ? 'remote database' : selectedDatabasePath}`);
  } catch (error) { databaseMessage(error.message, true); root.appendChild(Object.assign(document.createElement('div'), { className: 'database-empty database-error', textContent: error.message })); }
}

function selectDatabaseTable(table, updateQuery = true) {
  selectedDatabaseTable = table;
  byId('databaseGeneratePhp').disabled = false;
  byId('databasePhpTableStatus').textContent = selectedDatabasePath === remoteDatabaseOption
    ? `${table.kind}: ${table.name} · ${table.columns.length} fields · generated PHP reads DREAMCRAFT_DB_* server environment variables`
    : `${table.kind}: ${table.name} · ${table.columns.length} fields${table.columns.some(column => column.primaryKeyOrder > 0) ? ' · editable by primary key' : ' · read and create only (no primary key)'}`;
  byId('databaseSchema').querySelectorAll('.database-object').forEach(button => button.classList.toggle('selected', button.firstElementChild?.textContent.endsWith(table.name)));
  const textColumns = table.columns.filter(column => /CHAR|TEXT|CLOB|STRING|ENUM|UUID/i.test(column.type || ''));
  for (const id of ['databaseAuthUsername', 'databaseAuthPassword']) {
    const select = byId(id); select.replaceChildren();
    for (const column of textColumns) { const option = document.createElement('option'); option.value = column.name; option.textContent = `${column.name} · ${column.type || 'text'}`; select.append(option); }
    select.disabled = table.kind !== 'table' || textColumns.length < 2;
  }
  byId('databaseGenerateAuth').disabled = table.kind !== 'table' || textColumns.length < 2;
  byId('databaseAuthStatus').textContent = table.kind !== 'table' ? 'Views cannot authenticate accounts. Select a table with username and password hash fields.' : textColumns.length < 2 ? 'This table needs two text columns: username and password hash.' : 'Password values must be created with PHP password_hash(). A recovery snapshot is created before any files are written.';
  if (textColumns.length >= 2) {
    const username = textColumns.find(column => /user|email|login/i.test(column.name)) || textColumns[0];
    const password = textColumns.find(column => column !== username && /pass|hash|credential/i.test(column.name)) || textColumns.find(column => column !== username);
    byId('databaseAuthUsername').value = username.name; byId('databaseAuthPassword').value = password.name;
  }
  const authFolder = byId('databaseAuthFolder').value.trim().replaceAll('\\', '/').replace(/\/$/, '') || 'auth';
  byId('databaseAuthLogout').value = `${authFolder}/logout.php`;
  if (updateQuery) {
    const mysqlRemote = selectedDatabasePath === remoteDatabaseOption && byId('remoteDbEngine').value === 'mysql';
    const quotedName = mysqlRemote ? `\`${table.name.replaceAll('`', '``')}\`` : `"${table.name.replaceAll('"', '""')}"`;
    byId('databaseSql').value = `SELECT * FROM ${quotedName} LIMIT 100;`;
    byId('databaseParams').value = '[]';
    byId('databaseSql').focus();
  }
}

async function createDatabase() {
  if (selectedDatabasePath === remoteDatabaseOption) { databaseMessage('Switch to a project SQLite file to create another database.', true); return; }
  const input = byId('databaseNewPath');
  let path = input.value.trim().replaceAll('\\', '/');
  if (!path) { databaseMessage('Enter a project-relative database file name.', true); input.focus(); return; }
  if (!/\.(?:db|sqlite|sqlite3)$/i.test(path)) path += '.db';
  try {
    const result = await databaseRequest('/api/database/create', { method: 'POST', body: JSON.stringify({ path }) });
    input.value = '';
    await refreshDatabases(result.path);
    databaseMessage(`Created ${result.path}.`);
  } catch (error) { databaseMessage(error.message, true); }
}

function renderDatabaseResult(result) {
  const root = byId('databaseResults'); root.replaceChildren();
  if (!result.columns.length) {
    root.appendChild(Object.assign(document.createElement('div'), { className: 'database-empty', textContent: `Statement completed · ${result.changes} row${result.changes === 1 ? '' : 's'} changed${result.lastInsertRowId ? ` · last insert ID ${result.lastInsertRowId}` : ''}` }));
    return;
  }
  const table = document.createElement('table'), head = document.createElement('thead'), heading = document.createElement('tr'), body = document.createElement('tbody');
  for (const column of result.columns) { const cell = document.createElement('th'); cell.textContent = column; heading.appendChild(cell); }
  head.appendChild(heading);
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    for (const value of row) { const cell = document.createElement('td'); cell.textContent = value === null ? 'NULL' : value && typeof value === 'object' && value.type === 'blob' ? `BLOB 0x${value.hex}` : typeof value === 'object' ? JSON.stringify(value) : String(value); tr.appendChild(cell); }
    body.appendChild(tr);
  }
  table.append(head, body); root.appendChild(table);
  if (!result.rows.length) root.appendChild(Object.assign(document.createElement('div'), { className: 'database-empty', textContent: 'The query returned no rows.' }));
}

async function runDatabaseQuery() {
  if (!selectedDatabasePath) { databaseMessage('Select or create a project database first.', true); return; }
  const button = byId('databaseRun'); button.disabled = true;
  try {
    const params = JSON.parse(byId('databaseParams').value || '[]');
    if (!Array.isArray(params)) throw new Error('SQL parameters must be a JSON array.');
    databaseMessage('Running SQL…');
    const remote = selectedDatabasePath === remoteDatabaseOption;
    const result = await databaseRequest(remote ? '/api/database/remote/query' : '/api/database/query', { method: 'POST', body: JSON.stringify(remote ? { sql: byId('databaseSql').value, params } : { path: selectedDatabasePath, sql: byId('databaseSql').value, params }) });
    renderDatabaseResult(result);
    await loadDatabaseSchema();
    databaseMessage(result.columns.length ? `${result.rowCount} row${result.rowCount === 1 ? '' : 's'} returned${result.rows.length === 1000 ? ' · capped at 1,000 rows' : ''}.` : `Statement completed · ${result.changes} row${result.changes === 1 ? '' : 's'} changed.`);
  } catch (error) { databaseMessage(error.message, true); byId('databaseResults').replaceChildren(Object.assign(document.createElement('div'), { className: 'database-empty database-error', textContent: error.message })); }
  finally { button.disabled = false; }
}

async function generatePhpDataPage() {
  if (!selectedDatabasePath || !selectedDatabaseTable) { databaseMessage('Choose a database table or view first.', true); return; }
  const pagePath = byId('databasePhpPagePath').value.trim().replaceAll('\\', '/');
  if (!pagePath || pagePath.startsWith('/') || pagePath.split('/').some(part => !part || part === '.' || part === '..' || /[:\u0000-\u001f]/.test(part)) || !/\.php$/i.test(pagePath)) {
    databaseMessage('Use a project-relative .php path without empty, dot, or parent folders.', true); return;
  }
  try {
    const entries = await databaseRequest('/api/files');
    if (entries.some(file => file.kind === 'file' && file.path.toLowerCase() === pagePath.toLowerCase())) {
      databaseMessage(`${pagePath} already exists. Choose a different path to preserve the existing file.`, true); return;
    }
    const generator = await import('/php-scaffolder.mjs');
    const connection = selectedDatabasePath === remoteDatabaseOption
      ? await databaseRequest('/api/database/remote/connection')
      : { engine: 'sqlite', tls: false };
    if (!connection.connected && selectedDatabasePath === remoteDatabaseOption) throw new Error('Connect to the remote database again before generating a bound PHP page.');
    const source = generator.buildPhpDataPage(selectedDatabasePath, selectedDatabaseTable, pagePath, connection);
    const response = await fetch(apiPath(pagePath), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: source }) });
    if (!response.ok) throw new Error(`Could not create ${pagePath} (HTTP ${response.status}).`);
    await loadTree();
    byId('databaseModal').style.display = 'none';
    setView('code');
    await openFile(pagePath);
    toast(`Generated PHP data page: ${pagePath}`);
  } catch (error) { databaseMessage(error.message, true); }
}

async function generatePhpAuthentication() {
  if (!selectedDatabasePath || !selectedDatabaseTable) { databaseMessage('Select a database table to generate authentication files.', true); return; }
  const button = byId('databaseGenerateAuth'); button.disabled = true;
  try {
    const generator = await import('/php-scaffolder.mjs');
    const remote = selectedDatabasePath === remoteDatabaseOption;
    const connection = remote ? await databaseRequest('/api/database/remote/connection') : { engine: 'sqlite', tls: false };
    if (remote && !connection.connected) throw new Error('Connect to the remote database again before generating its login system.');
    const result = generator.buildPhpAuthenticationFiles(selectedDatabasePath, selectedDatabaseTable, {
      folder: byId('databaseAuthFolder').value,
      usernameColumn: byId('databaseAuthUsername').value,
      passwordColumn: byId('databaseAuthPassword').value,
      loginRedirect: byId('databaseAuthRedirect').value,
      protectedPage: byId('databaseAuthProtect').value
    }, connection);
    const entries = await databaseRequest('/api/files');
    const existing = new Set(entries.filter(item => item.kind === 'file').map(item => item.path.toLowerCase()));
    const collisions = result.files.filter(file => existing.has(file.path.toLowerCase()));
    if (collisions.length) throw new Error(`These authentication files already exist; no files were changed: ${collisions.map(file => file.path).join(', ')}`);
    let protectedOriginal = '';
    if (result.protectedPage) {
      if (!existing.has(result.protectedPage.toLowerCase())) throw new Error(`Protected page ${result.protectedPage} does not exist in the project.`);
      protectedOriginal = await fetchText(result.protectedPage);
      if (!/^\s*<\?php\b/.test(protectedOriginal)) throw new Error('The protected page must begin with a PHP opening tag.');
      const guardPath = relativeProjectPath(result.protectedPage, result.files.find(file => file.path.endsWith('/require-login.php')).path);
      const guardLine = `require_once __DIR__ . ${JSON.stringify('/' + guardPath)};`;
      if (protectedOriginal.includes(guardLine)) throw new Error('The selected page already includes this DreamCraft access guard.');
      let insertionPoint = protectedOriginal.indexOf('<?php') + 5;
      const strict = protectedOriginal.slice(insertionPoint).match(/^\s*declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;/);
      if (strict) insertionPoint += strict[0].length;
      const protectedUpdated = `${protectedOriginal.slice(0, insertionPoint)}\n${guardLine}${protectedOriginal.slice(insertionPoint)}`;
      result.protectedContent = protectedUpdated;
      result.protectedOriginal = protectedOriginal;
    }
    const snapshotResponse = await fetch('/api/snapshots', { method: 'POST' });
    const snapshot = await snapshotResponse.json();
    if (!snapshotResponse.ok) throw new Error(snapshot.error || 'Could not create a recovery snapshot; no files were changed.');
    const written = [];
    try {
      for (const file of result.files) {
        const response = await fetch(apiPath(file.path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: file.content }) });
        if (!response.ok) throw new Error(`Could not create ${file.path} (HTTP ${response.status}).`);
        written.push(file.path);
      }
      if (result.protectedPage) {
        if (await fetchText(result.protectedPage) !== result.protectedOriginal) throw new Error(`${result.protectedPage} changed while authentication files were being generated.`);
        const response = await fetch(apiPath(result.protectedPage), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: result.protectedContent }) });
        if (!response.ok) throw new Error(`Could not protect ${result.protectedPage} (HTTP ${response.status}).`);
        written.push(result.protectedPage);
      }
    } catch (writeError) {
      for (const path of written.reverse()) {
        if (path === result.protectedPage) await fetch(apiPath(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: result.protectedOriginal }) }).catch(() => {});
        else await fetch(`/api/file/${encodeProjectPath(path)}`, { method: 'DELETE' }).catch(() => {});
      }
      throw new Error(`${writeError.message} Recovery snapshot ${snapshot.id} preserves the original project state.`);
    }
    await loadTree();
    const first = result.protectedPage || result.files.find(file => file.path.endsWith('/login.php')).path;
    byId('databaseModal').style.display = 'none'; setView('code'); await openFile(first);
    toast(`Generated PHP login system · recovery snapshot ${snapshot.id}`);
  } catch (error) { databaseMessage(error.message, true); }
  finally { button.disabled = false; }
}

async function openDatabaseDialog() {
  byId('databaseModal').style.display = 'grid';
  try { await refreshDatabases(); } catch (error) { databaseMessage(error.message, true); }
}

async function connectRemoteDatabase() {
  const engine = byId('remoteDbEngine').value;
  const button = byId('remoteDbConnect'); button.disabled = true;
  byId('remoteDbStatus').textContent = `Connecting to ${engine}…`;
  try {
    await databaseRequest('/api/database/remote/connection', { method: 'POST', body: JSON.stringify({ engine, name: byId('remoteDbName').value.trim(), host: byId('remoteDbHost').value.trim(), port: Number(byId('remoteDbPort').value), database: byId('remoteDbDatabase').value.trim(), username: byId('remoteDbUsername').value, password: byId('remoteDbPassword').value, tls: byId('remoteDbTls').checked }) });
    byId('remoteDbPassword').value = '';
    byId('databaseSql').value = 'SELECT 1;'; byId('databaseParams').value = '[]';
    selectedDatabaseTable = null;
    await refreshDatabases(remoteDatabaseOption);
    byId('remoteDbStatus').textContent = `Connected · ${engine} · ${byId('remoteDbHost').value}:${byId('remoteDbPort').value}/${byId('remoteDbDatabase').value}`;
  } catch (error) {
    byId('remoteDbStatus').textContent = `Connection failed · ${error.message}`;
    databaseMessage(error.message, true);
  } finally { button.disabled = false; }
}

async function disconnectRemoteDatabase() {
  try {
    await databaseRequest('/api/database/remote/connection', { method: 'DELETE' });
    byId('remoteDbPassword').value = '';
    selectedDatabaseTable = null;
    await refreshDatabases();
    byId('remoteDbStatus').textContent = 'Disconnected';
  } catch (error) { databaseMessage(error.message, true); }
}

async function openExternalPreviewDialog() {
  const modal = byId('externalPreviewModal');
  const select = byId('externalBrowserSelect');
  const status = byId('externalPreviewStatus');
  const open = byId('externalPreviewOpen');
  modal.style.display = 'grid';
  select.replaceChildren();
  open.disabled = true;
  status.textContent = 'Detecting installed browsers…';
  try {
    const response = await fetch('/api/browsers');
    if (!response.ok) throw new Error(`Browser discovery failed with HTTP ${response.status}.`);
    const browsers = await response.json();
    for (const browser of browsers) {
      const option = document.createElement('option');
      option.value = browser.id;
      option.textContent = browser.name;
      select.appendChild(option);
    }
    if (!browsers.length) {
      status.textContent = 'No supported desktop browser was detected. Install Edge, Chrome, Firefox, or Brave and reopen this dialog.';
      return;
    }
    try {
      const preferred = localStorage.getItem('dreamcraft.external-browser');
      if (browsers.some(browser => browser.id === preferred)) select.value = preferred;
    } catch {}
    status.textContent = `${browsers.length} installed browser${browsers.length === 1 ? '' : 's'} detected. The active site opens in live mode and reloads after saved files change.`;
    open.disabled = false;
  } catch (error) { status.textContent = error.message; }
}

async function launchExternalPreview() {
  const button = byId('externalPreviewOpen');
  const status = byId('externalPreviewStatus');
  if (!byId('externalBrowserSelect').value) { status.textContent = 'Select an installed browser first.'; return; }
  button.disabled = true;
  status.textContent = 'Saving the current page and opening a live site preview…';
  try {
    if (!(await save())) throw new Error('Could not save the current page before opening its preview.');
    const previewPath = ['html', 'htm'].includes(extension(activePath)) ? activePath : 'index.html';
    const previewUrl = new URL(`/site/${previewPath.split('/').map(encodeURIComponent).join('/')}`, location.origin).href;
    const response = await fetch('/api/preview/open-external', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser_id: byId('externalBrowserSelect').value, url: previewUrl })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `External preview failed with HTTP ${response.status}.`);
    try { localStorage.setItem('dreamcraft.external-browser', byId('externalBrowserSelect').value); } catch {}
    status.textContent = `Opened ${result.browser} in live preview. It reloads when saved site files change.`;
    toast(`Preview opened in ${result.browser}`);
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = !byId('externalBrowserSelect').value; }
}

function renderDevicePreviewStatus(result) {
  const url = byId('devicePreviewUrl');
  const status = byId('devicePreviewStatus');
  const start = byId('devicePreviewStart');
  const stop = byId('devicePreviewStop');
  const copy = byId('devicePreviewCopy');
  const active = result?.active === true && typeof result.url === 'string';
  url.value = active ? result.url : '';
  url.disabled = !active;
  start.disabled = active;
  stop.disabled = !active;
  copy.disabled = !active;
  status.classList.toggle('active', active);
  status.classList.remove('error');
  status.textContent = active
    ? 'Live preview is sharing this project on your local network. Keep DreamCraft open; it refreshes when saved files change.'
    : 'Preview server is stopped.';
}

async function openDevicePreviewDialog() {
  byId('devicePreviewModal').style.display = 'grid';
  byId('devicePreviewStatus').textContent = 'Checking the local preview server…';
  try {
    const response = await fetch('/api/device-preview/status');
    if (!response.ok) throw new Error(`Device preview status failed with HTTP ${response.status}.`);
    renderDevicePreviewStatus(await response.json());
  } catch (error) { byId('devicePreviewStatus').textContent = error.message; byId('devicePreviewStatus').classList.add('error'); }
}

async function startDevicePreview() {
  const button = byId('devicePreviewStart');
  const status = byId('devicePreviewStatus');
  button.disabled = true;
  status.classList.remove('error'); status.textContent = 'Starting a token-protected server on your local network…';
  try {
    if (!(await save())) throw new Error('Save the active page before sharing a device preview.');
    const response = await fetch('/api/device-preview/start', { method: 'POST' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Could not start device preview (HTTP ${response.status}).`);
    renderDevicePreviewStatus(result);
  } catch (error) { status.textContent = `${error.message} Check that this computer is connected to Wi-Fi and allow DreamCraft through the private-network firewall if prompted.`; status.classList.add('error'); button.disabled = false; }
}

async function stopDevicePreview() {
  const status = byId('devicePreviewStatus');
  byId('devicePreviewStop').disabled = true;
  try {
    const response = await fetch('/api/device-preview/stop', { method: 'POST' });
    if (!response.ok) throw new Error(`Could not stop device preview (HTTP ${response.status}).`);
    renderDevicePreviewStatus({ active: false });
  } catch (error) { status.textContent = error.message; status.classList.add('error'); byId('devicePreviewStop').disabled = false; }
}

async function copyDevicePreviewUrl() {
  const url = byId('devicePreviewUrl');
  if (!url.value) return;
  try { await navigator.clipboard.writeText(url.value); }
  catch { url.focus(); url.select(); document.execCommand('copy'); }
  byId('devicePreviewStatus').textContent = 'Device link copied. Open it on a phone or tablet on the same Wi-Fi network.';
}

async function openTestingServerDialog() {
  byId('testingServerModal').style.display = 'grid';
  byId('testingServerMessage').classList.add('hide');
  try {
    const response = await fetch('/api/testing/settings');
    const settings = await response.json();
    byId('testingCommand').value = settings.command || '';
    byId('testingArguments').value = (settings.arguments || []).join('\n');
    await refreshTestingServerStatus();
  } catch (error) { testingServerMessage(`Could not load testing-server settings: ${error.message}`, true); }
}

async function saveTestingServerSettings() {
  const settings = testingServerSettingsFromForm();
  const response = await fetch('/api/testing/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings)
  });
  if (!response.ok) throw new Error((await response.text()) || 'Could not save the testing-server command.');
  return settings;
}

function testingPreviewPath() {
  const dynamic = /\.(?:html?|php\d*|phtml|asp|aspx|jsp|cfm|shtml)$/i.test(activePath);
  if (dynamic) return activePath;
  const files = new Set(projectEntries.filter(entry => entry.kind === 'file').map(entry => entry.path.replaceAll('\\', '/')));
  return ['index.php', 'index.html', 'index.htm'].find(path => files.has(path)) || activePath;
}

async function startTestingServerAndPreview() {
  const previewWindow = window.open('about:blank', '_blank');
  if (previewWindow) previewWindow.opener = null;
  const button = byId('testingServerStart'); button.disabled = true;
  testingServerMessage('Saving command and starting the development server…');
  try {
    const settings = testingServerSettingsFromForm();
    if (!settings.command) throw new Error('Choose a server executable or select a runtime preset.');
    if (!(await save())) throw new Error('Save the open file before starting the testing server.');
    await saveTestingServerSettings();
    const response = await fetch('/api/testing/start', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The testing server could not start.');
    const path = testingPreviewPath().split('/').map(encodeURIComponent).join('/');
    const url = `${result.url}/${path}`;
    byId('testingServerStop').disabled = false;
    testingServerMessage(`Testing server is ready at ${url}`);
    if (previewWindow) previewWindow.location.href = url;
    else testingServerMessage(`Testing server is running at ${result.url}. The browser blocked the preview tab; copy this preview URL: ${url}`);
    byId('testingServerModal').style.display = 'none';
  } catch (error) {
    if (previewWindow) previewWindow.close();
    testingServerMessage(error.message, true);
  } finally { button.disabled = false; }
}

async function stopTestingServer() {
  const button = byId('testingServerStop'); button.disabled = true;
  try {
    const response = await fetch('/api/testing/stop', { method: 'POST' });
    if (!response.ok) throw new Error('Could not stop the testing server.');
    testingServerMessage('Testing server stopped.');
  } catch (error) { testingServerMessage(error.message, true); }
  finally { await refreshTestingServerStatus(); }
}

function availableCommands() {
  const files = projectEntries.filter(item => item.kind === 'file' && !item.path.split('/').some(part => part.startsWith('.')))
    .map(item => ({ label: `Open ${item.name}`, detail: item.path, icon: extension(item.path) === 'html' ? '▤' : extension(item.path) === 'css' ? '◈' : extension(item.path) === 'js' ? '◉' : '≡', group: 'Files', run: () => openFile(item.path) }));
  const snippets = codeSnippets.map(item => ({ label: `Insert snippet: ${item.name}`, detail: `${item.category}${item.trigger ? ` · ${item.trigger}` : ''} · ${item.description}`, icon: '</>', group: 'Snippets', run: () => insertSnippet(item.id, false) }));
  return [...files, ...snippets, ...commandActions];
}

function renderCommandResults() {
  const input = byId('commandInput'), results = byId('commandResults');
  const query = input.value.trim().toLowerCase();
  const commands = availableCommands();
  const candidates = query ? commands : [...commands.filter(item => item.group === 'Files').slice(0, 8), ...commandActions];
  const matches = candidates.map((item, index) => ({ ...item, index, score: query ? (item.label.toLowerCase().startsWith(query) ? 0 : item.label.toLowerCase().includes(query) ? 1 : item.detail.toLowerCase().includes(query) ? 2 : -1) : 0 }))
    .filter(item => item.score >= 0)
    .sort((a, b) => a.score - b.score || (a.group === 'Files' && b.group !== 'Files' ? -1 : b.group === 'Files' && a.group !== 'Files' ? 1 : a.label.localeCompare(b.label)))
    .slice(0, 40);
  commandSelection = Math.min(commandSelection, Math.max(0, matches.length - 1));
  input.removeAttribute('aria-activedescendant');
  results.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement('div'); empty.className = 'command-empty'; empty.textContent = 'No matching files or commands.'; results.appendChild(empty); return;
  }
  matches.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `command-item${index === commandSelection ? ' active' : ''}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === commandSelection));
    button.id = `commandResult${index}`;
    if (index === commandSelection) input.setAttribute('aria-activedescendant', button.id);
    const icon = document.createElement('span'); icon.className = 'command-item-icon'; icon.textContent = item.icon;
    const copy = document.createElement('span'); copy.className = 'command-item-copy';
    const label = document.createElement('span'); label.className = 'command-item-label'; label.textContent = item.label;
    const detail = document.createElement('span'); detail.className = 'command-item-detail'; detail.textContent = item.detail;
    copy.append(label, detail); button.append(icon, copy);
    if (item.shortcut) { const shortcut = document.createElement('kbd'); shortcut.textContent = item.shortcut; button.append(shortcut); }
    button.addEventListener('mousemove', () => { commandSelection = index; input.setAttribute('aria-activedescendant', button.id); results.querySelectorAll('.command-item').forEach((row, rowIndex) => { row.classList.toggle('active', rowIndex === index); row.setAttribute('aria-selected', String(rowIndex === index)); }); });
    button.addEventListener('click', () => runCommand(item)); results.appendChild(button);
  });
  results.querySelector('.command-item.active')?.scrollIntoView({ block: 'nearest' });
}

function openCommandPalette() {
  commandPaletteOpen = true;
  const backdrop = byId('commandBackdrop');
  backdrop.classList.add('open'); backdrop.setAttribute('aria-hidden', 'false');
  byId('commandInput').value = ''; commandSelection = 0; renderCommandResults(); byId('commandInput').focus();
}

function closeCommandPalette() {
  commandPaletteOpen = false;
  byId('commandBackdrop').classList.remove('open'); byId('commandBackdrop').setAttribute('aria-hidden', 'true');
  editor?.focus();
}

async function runCommand(command) {
  closeCommandPalette();
  try { await command.run(); }
  catch (error) { toast(error.message || `Could not run ${command.label}`); }
}

function emmetRange(cm) {
  const cursor = cm.getCursor(), line = cm.getLine(cursor.line);
  let start = cursor.ch, square = 0, paren = 0, brace = 0;
  while (start > 0) {
    const char = line[start - 1];
    if (/\s/.test(char) && brace === 0 && square === 0) break;
    if (char === ']') square++;
    else if (char === '[') { if (!square) break; square--; }
    else if (char === ')') paren++;
    else if (char === '(') { if (!paren) break; paren--; }
    else if (char === '}') brace++;
    else if (char === '{') { if (!brace) break; brace--; }
    else if (!/[\w.#>+^*\[\]()="':{}%/-]/.test(char)) break;
    if (char === '<' || char === ';') break;
    start--;
  }
  return start < cursor.ch ? { from: CodeMirror.Pos(cursor.line, start), to: cursor, text: line.slice(start, cursor.ch) } : null;
}

function expandEmmetAtCursor(cm) {
  if (!window.dreamEmmet || !cm || cm.isReadOnly()) return false;
  const range = emmetRange(cm);
  if (!range) return false;
  const token = cm.getTokenAt(range.to);
  if (/string|comment/.test(token.type || '')) return false;
  const ext = extension(activePath);
  try {
    let expanded;
    if (['html', 'htm', 'vue', 'svg'].includes(ext)) {
      if (completionMode(cm) !== 'htmlmixed' && completionMode(cm) !== 'xml') return false;
      expanded = window.dreamEmmet.expandHtml(range.text);
    } else if (['css', 'scss', 'sass', 'less'].includes(ext) && completionMode(cm) === 'css') expanded = window.dreamEmmet.expandCss(range.text);
    else return false;
    cm.replaceRange(expanded, range.from, range.to, '+emmet');
    cm.focus();
    return true;
  } catch { return false; }
}

editor = CodeMirror.fromTextArea(textarea, {
  theme: 'dreamcraft',
  mode: 'htmlmixed',
  lineNumbers: true,
  lineWrapping: false,
  tabSize: 2,
  indentUnit: 2,
  indentWithTabs: false,
  matchBrackets: true,
  gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
  foldGutter: {
    rangeFinder(cm, start) {
      const mode = cm.getModeAt(start);
      if (mode?.name === 'xml' && CodeMirror.fold.xml) return CodeMirror.fold.xml(cm, start);
      return CodeMirror.fold.auto(cm, start);
    }
  },
  autofocus: false,
  extraKeys: {
    'Ctrl-S': () => save(), 'Cmd-S': () => save(),
    'Ctrl-Z': cm => cm.undo(), 'Cmd-Z': cm => cm.undo(),
    'Ctrl-Y': cm => cm.redo(), 'Cmd-Shift-Z': cm => cm.redo(),
    'Ctrl-F': () => openSearch(), 'Cmd-F': () => openSearch(),
    'Shift-Alt-F': () => formatCurrentFile(),
    'Ctrl-Space': cm => showProjectHints(cm),
    'Cmd-Space': cm => showProjectHints(cm),
    'Ctrl-Q': cm => cm.foldCode(cm.getCursor()),
    'Ctrl-E': cm => expandEmmetAtCursor(cm),
    'Cmd-E': cm => expandEmmetAtCursor(cm),
    Tab: cm => { if (!expandEmmetAtCursor(cm)) cm.execCommand('indentMore'); },
    'Shift-Tab': cm => cm.execCommand('indentLess')
  }
});

const codeViewSecond = document.createElement('div');
codeViewSecond.className = 'code-view code-view-secondary';
codeViewSecond.id = 'codeViewSecond';
codeViewSecond.setAttribute('aria-label', 'Second source editor pane');
const secondEditorMount = document.createElement('textarea');
secondEditorMount.spellcheck = false;
secondEditorMount.setAttribute('aria-label', 'Second source code pane');
codeViewSecond.appendChild(secondEditorMount);
byId('codeView').insertAdjacentElement('afterend', codeViewSecond);
const secondEditor = CodeMirror.fromTextArea(secondEditorMount, {
  theme: 'dreamcraft', mode: editorMode(activePath), lineNumbers: true, lineWrapping: false,
  tabSize: 2, indentUnit: 2, indentWithTabs: false, matchBrackets: true,
  gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
  foldGutter: { rangeFinder: (cm, start) => CodeMirror.fold.auto(cm, start) },
  extraKeys: {
    'Ctrl-Space': cm => showProjectHints(cm), 'Cmd-Space': cm => showProjectHints(cm),
    'Ctrl-E': cm => expandEmmetAtCursor(cm), 'Cmd-E': cm => expandEmmetAtCursor(cm),
    Tab: cm => { if (!expandEmmetAtCursor(cm)) cm.execCommand('indentMore'); },
    'Ctrl-Q': cm => cm.foldCode(cm.getCursor())
  }
});
secondEditor.swapDoc(editor.getDoc().linkedDoc({ sharedHist: true }));
secondEditor.on('inputRead', (cm, change) => {
  const typed = change.text.join('\n');
  if (!typed || typed.includes('\n')) return;
  const prefix = cm.getLine(cm.getCursor().line).slice(0, cm.getCursor().ch);
  const mode = completionMode(cm);
  const suggest = mode === 'htmlmixed'
    ? /[<.#/="']$/.test(prefix) || /<([a-zA-Z][\w-]*)\s+[\w:-]*$/.test(prefix) || /\b(?:class|id|src|href)\s*=\s*["'][^"']*$/.test(prefix)
    : mode === 'css' ? /[.#:]$/.test(prefix) || /^\s*[\w-]+\s*:\s*$/.test(prefix) : /[.$]$/.test(prefix);
  if (suggest) requestAnimationFrame(() => { if (cm.hasFocus()) showProjectHints(cm); });
});
secondEditor.on('beforeChange', (_cm, change) => {
  if (loading) return;
  if (!templateSelectionAllowed(change.from, change.to)) {
    change.cancel();
    toast('This is a locked template region. Edit it in the source template.');
  }
});
secondEditor.on('cursorActivity', cm => {
  const pos = cm.getCursor();
  byId('cursorPosition').textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
});
const codeSplitButton = document.createElement('button');
codeSplitButton.type = 'button';
codeSplitButton.id = 'codeSplitMode';
codeSplitButton.textContent = 'Code / Code';
codeSplitButton.title = 'Show two synchronized source panes';
byId('codeMode').insertAdjacentElement('afterend', codeSplitButton);
codeSplitButton.addEventListener('click', () => setView('code-split'));

editor.on('inputRead', (cm, change) => {
  const typed = change.text.join('\n');
  if (!typed || typed.includes('\n')) return;
  const cursor = cm.getCursor(), prefix = cm.getLine(cursor.line).slice(0, cursor.ch);
  const mode = completionMode(cm);
  const shouldSuggest = mode === 'htmlmixed'
    ? /[<.#/="']$/.test(prefix) || /<([a-zA-Z][\w-]*)\s+[\w:-]*$/.test(prefix) || /\b(?:class|id|src|href)\s*=\s*["'][^"']*$/.test(prefix)
    : mode === 'css' ? /[.#:]$/.test(prefix) || /^\s*[\w-]+\s*:\s*$/.test(prefix)
      : /[.$]$/.test(prefix);
  if (shouldSuggest) requestAnimationFrame(() => { if (cm.hasFocus()) showProjectHints(cm); });
});

editor.on('change', () => {
  if (loading) return;
  editVersion += 1;
  historyByPath.set(activePath, editor.getHistory());
  updateHistoryButtons();
  setDirty(true);
  scheduleLiveDiagnostics();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 650);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 180);
  scheduleVisualMediaQueryRefresh();
});

editor.on('cursorActivity', () => {
  const pos = editor.getCursor();
  byId('cursorPosition').textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
  updateTemplateRegionStatus();
});

function templateMarkupState(text, path) {
  const regions = [];
  const matcher = /<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->([\s\S]*?)<!--\s*TemplateEndEditable\s*-->/g;
  for (const found of text.matchAll(matcher)) regions.push({ name: found[1], start: found.index + found[0].indexOf('-->') + 3, end: found.index + found[0].lastIndexOf('<!--') });
  const parameterValues = parseTemplateParameters(text);
  const instancePattern = /<!--\s*InstanceParam\s+name="([^"\r\n]+)"\s+type="boolean"\s+value="(true|false)"/g;
  for (const match of text.matchAll(instancePattern)) parameterValues.set(match[1], match[2] === 'true');
  const parameters = [...parameterValues].map(([name, value]) => ({ name, value }));
  const repeats = findTemplateRepeatBlocks(text);
  const isTemplate = /\.dwt$/i.test(path);
  const isChild = /<!--\s*TemplateBeginInstance\s+template="([^"]+)"\s*-->/i.test(text);
  return isTemplate || isChild ? { isTemplate, isChild, regions, parameters, repeats } : null;
}

function templatePositionAllowed(position) {
  if (!templateRegionState?.isChild) return true;
  const offset = editor.indexFromPos(position);
  return [...templateRegionMarks.values()].some(mark => { const range = mark.find(); return range && offset >= editor.indexFromPos(range.from) && offset <= editor.indexFromPos(range.to); });
}

function templateSelectionAllowed(from, to) {
  if (!templateRegionState?.isChild) return true;
  const start = editor.indexFromPos(from), end = editor.indexFromPos(to);
  if (start === end) return templatePositionAllowed(from);
  return [...templateRegionMarks.values()].some(mark => { const range = mark.find(); return range && start >= editor.indexFromPos(range.from) && end <= editor.indexFromPos(range.to); });
}

editor.on('beforeChange', (_cm, change) => {
  if (loading) return;
  if (!templateSelectionAllowed(change.from, change.to)) {
    change.cancel();
    toast('This is a locked template region. Edit it in the source template.');
  }
});

function updateTemplateRegionStatus() {
  let status = byId('templateRegionStatus');
  if (!status) {
    status = document.createElement('span'); status.id = 'templateRegionStatus'; status.className = 'template-region-status';
    byId('languageStatus').insertAdjacentElement('afterend', status);
  }
  if (!templateRegionState) { status.textContent = ''; status.title = ''; return; }
  const offset = editor.indexFromPos(editor.getCursor());
  const region = [...templateRegionMarks].find(([, mark]) => { const range = mark.find(); return range && offset >= editor.indexFromPos(range.from) && offset <= editor.indexFromPos(range.to); });
  status.textContent = region ? `Editable · ${region[0]}` : templateRegionState.isChild ? 'Locked template region' : 'Template master';
  status.title = region ? `Editing the “${region[0]}” editable region` : templateRegionState.isChild ? 'Edit this content in the source template' : 'Template master source';
  status.classList.toggle('locked', templateRegionState.isChild && !region);
}

function markTemplateRegions() {
  for (const mark of templateRegionMarks.values()) mark.clear();
  templateRegionMarks = new Map();
  if (!templateRegionState) return;
  const occurrences = new Map();
  for (const region of templateRegionState.regions) {
    const occurrence = (occurrences.get(region.name) || 0) + 1; occurrences.set(region.name, occurrence);
    const key = occurrence === 1 ? region.name : `${region.name} (${occurrence})`;
    templateRegionMarks.set(key, editor.markText(editor.posFromIndex(region.start), editor.posFromIndex(region.end), { className: 'template-region-marker', title: `Editable region: ${key}`, inclusiveLeft: true, inclusiveRight: true }));
  }
}

async function fetchText(path) {
  const response = await fetch(apiPath(path));
  if (!response.ok) throw new Error(`Unable to read ${path}`);
  return response.text();
}

async function save() {
  if (!dirty) return true;
  const version = editVersion;
  const content = source();
  try {
    const response = await fetch(apiPath(activePath), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!response.ok) throw new Error('Save failed');
    if (version === editVersion) setDirty(false);
    await loadTree();
  if (['css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs'].includes(extension(activePath))) renderPreview();
    return version === editVersion;
  } catch (error) {
    toast(`Save failed: ${error.message}`);
    return false;
  }
}

function setEditorContent(content, path, preserveHistory = false) {
  const restorePathState = preserveHistory && editorPath !== path;
  if (editorPath && editorPath !== path) {
    historyByPath.set(editorPath, editor.getHistory());
    cursorByPath.set(editorPath, editor.getCursor());
  }
  loading = true;
  editor.setValue(content);
  editor.clearHistory();
  if (restorePathState && historyByPath.has(path)) editor.setHistory(historyByPath.get(path));
  editor.setOption('mode', editorMode(path));
  secondEditor.setOption('mode', editorMode(path));
  loading = false;
  templateRegionState = templateMarkupState(content, path);
  markTemplateRegions();
  editorPath = path;
  historyByPath.set(path, editor.getHistory());
  const savedCursor = restorePathState ? cursorByPath.get(path) : null;
  const line = savedCursor ? Math.min(savedCursor.line, editor.lastLine()) : 0;
  editor.setCursor({ line, ch: savedCursor ? Math.min(savedCursor.ch, editor.getLine(line).length) : 0 });
  editor.scrollTo(0, 0);
  setDirty(false);
  editor.refresh();
  syncPageProperties(content);
  updateHistoryButtons();
  updateTemplateRegionStatus();
}

function syncPageProperties(content) {
  const templateLocked = Boolean(templateRegionState?.isChild);
  byId('pageTitle').disabled = templateLocked;
  byId('pageDescription').disabled = templateLocked;
  byId('pageTitle').title = templateLocked ? 'Edit document metadata in the template source.' : '';
  byId('pageDescription').title = templateLocked ? 'Edit document metadata in the template source.' : '';
  const documentPage = new DOMParser().parseFromString(content, 'text/html');
  const title = documentPage.querySelector('title')?.textContent;
  const description = documentPage.querySelector('meta[name="description"]')?.content;
  if (title !== undefined) byId('pageTitle').value = title;
  if (description !== undefined) byId('pageDescription').value = description;
}

async function openFile(path) {
  if (path === activePath && dirty) return;
  if (dirty && !(await save())) return;
  try {
    const content = await fetchText(path);
    const preserveHistory = openTabs.includes(path);
    activePath = path;
    if (!preserveHistory) openTabs.push(path);
    renderTabs();
    setEditorContent(content, path, preserveHistory);
    renderRelatedFiles(content, path);
    if (templateRegionState?.isChild && activeView !== 'code') setView('code');
    scheduleCompletionIndexRefresh(projectEntries);
    document.querySelector('.crumb-mini strong').textContent = path;
    byId('topFilePath').textContent = path;
    byId('languageStatus').textContent = languageName(path);
    document.querySelectorAll('.tree-item').forEach(row => row.classList.toggle('selected', row.dataset.path === path));
    await renderPreview();
    scheduleVisualMediaQueryRefresh();
    scheduleLiveDiagnostics();
  } catch (error) { toast(error.message); }
}

function renderRelatedFiles(content, path) {
  const bar = byId('relatedFiles');
  if (!bar) return;
  bar.replaceChildren();
  if (!['html', 'htm', 'php', 'vue'].includes(extension(path))) { bar.classList.add('workspace-hidden'); return; }
  const page = new DOMParser().parseFromString(content, 'text/html');
  const references = [
    ...[...page.querySelectorAll('link[rel~="stylesheet"][href]')].map(node => node.getAttribute('href')),
    ...[...page.querySelectorAll('script[src]')].map(node => node.getAttribute('src'))
  ].map(href => resolveProjectHref(path, href || '')).filter((item, index, all) => item && all.indexOf(item) === index && projectEntries.some(entry => entry.kind === 'file' && entry.path === item));
  if (!references.length) { bar.classList.add('workspace-hidden'); return; }
  bar.classList.remove('workspace-hidden');
  const label = document.createElement('span'); label.className = 'related-files-label'; label.textContent = 'RELATED'; bar.appendChild(label);
  for (const file of references) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'related-file'; button.textContent = file.split('/').pop(); button.title = file;
    button.addEventListener('click', () => openFile(file));
    bar.appendChild(button);
  }
}

function renderTabs() {
  const list = byId('tabList');
  list.replaceChildren();
  openTabs.forEach(path => {
    const tab = document.createElement('div');
    tab.className = `tab ${path === activePath ? 'active' : ''}`;
    tab.title = path;
    const icon = document.createElement('span');
    icon.className = `file-ico ${extension(path)}`;
    icon.textContent = extension(path) === 'html' ? '▤' : extension(path) === 'css' ? '◈' : extension(path) === 'js' ? '◉' : '≡';
    const name = document.createElement('span');
    name.textContent = path.split('/').pop();
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close document';
    close.onclick = async event => { event.stopPropagation(); await closeTab(path); };
    tab.append(icon, name, close);
    tab.onclick = () => openFile(path);
    list.appendChild(tab);
  });
}

async function closeTab(path) {
  if (openTabs.length <= 1) return toast('Keep one document open');
  if (path === activePath && dirty && !(await save())) return;
  const index = openTabs.indexOf(path);
  openTabs = openTabs.filter(item => item !== path);
  historyByPath.delete(path);
  cursorByPath.delete(path);
  if (activePath === path) {
    const next = openTabs[Math.max(0, index - 1)];
    await openFile(next);
  }
  renderTabs();
}

function injectDesignBridge(html) {
  const directory = relativeDirectory(previewBasePath);
  const base = `<base data-dreamcraft-injected href="${location.origin}/site/${directory}index.html">`;
  const bridge = `<script id="dreamcraft-bridge">(()=>{
    let design=${isVisualDocument()}, selected=null, selectedId='';
    const style=document.createElement('style'); style.id='dreamcraft-overlay';
    style.textContent='[data-dc-selected]{outline:2px solid #a17bff!important;outline-offset:2px!important;cursor:pointer!important} [data-dc-hover]:not([data-dc-selected]){outline:1px dashed #a17bff!important;outline-offset:2px!important}';
    document.head.appendChild(style);
    const elements=[...document.querySelectorAll('body *')];
    elements.forEach((el,i)=>el.setAttribute('data-dc-id',String(i+1)));
    const summary=elements.slice(0,250).map(el=>({id:el.getAttribute('data-dc-id'),tag:el.tagName.toLowerCase(),text:(el.innerText||el.alt||'').trim().replace(/\\s+/g,' ').slice(0,48),depth:(()=>{let n=0,p=el.parentElement;while(p&&p!==document.body){n++;p=p.parentElement}return n})()}));
    function linkedStylesheets(){return [...document.querySelectorAll('link[rel~="stylesheet"]')].map(link=>{try{const url=new URL(link.href);if(url.origin!==new URL(document.baseURI).origin||!url.pathname.startsWith('/site/'))return null;return url.pathname.slice(6).split('/').map(decodeURIComponent).join('/')}catch{return null}}).filter(Boolean)}
    function choose(el){if(!el)return;if(selected)selected.removeAttribute('data-dc-selected');selected=el;selectedId=el.getAttribute('data-dc-id')||'';el.setAttribute('data-dc-selected','');const s=getComputedStyle(el);parent.postMessage({type:'dc-select',id:selectedId,tag:el.tagName.toLowerCase(),elementId:el.id||'',classes:el.getAttribute('class')||'',text:(el.innerText||el.alt||'').trim().replace(/\\s+/g,' ').slice(0,120),color:s.color,background:s.backgroundColor,padding:parseFloat(s.paddingTop)||0,margin:parseFloat(s.marginTop)||0,width:el.style.width,height:el.style.height,fontSize:parseFloat(s.fontSize)||0,fontFamily:s.fontFamily,textAlign:el.style.textAlign,display:el.style.display,borderRadius:parseFloat(s.borderTopLeftRadius)||0,cssPaths:linkedStylesheets()},'*')}
    function serialize(){const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('[data-dreamcraft-original-url-attrs]').forEach(el=>{try{const originals=JSON.parse(el.getAttribute('data-dreamcraft-original-url-attrs'));for(const [name,value] of Object.entries(originals))el.setAttribute(name,value)}catch{}el.removeAttribute('data-dreamcraft-original-url-attrs')});clone.querySelectorAll('[data-dreamcraft-original-css]').forEach(el=>{el.textContent=el.getAttribute('data-dreamcraft-original-css')||'';el.removeAttribute('data-dreamcraft-original-css')});clone.querySelectorAll('[data-dreamcraft-injected]').forEach(el=>el.remove());clone.querySelectorAll('[data-dc-id],[data-dc-selected],[data-dc-hover],[contenteditable]').forEach(el=>{el.removeAttribute('data-dc-id');el.removeAttribute('data-dc-selected');el.removeAttribute('data-dc-hover');el.removeAttribute('contenteditable')});clone.querySelector('#dreamcraft-bridge')?.remove();clone.querySelector('#dreamcraft-overlay')?.remove();parent.postMessage({type:'dc-html',html:'<!doctype html>\\n'+clone.outerHTML},'*')}
    document.addEventListener('pointerover',e=>{if(!design)return;const el=e.target.closest('body *');if(el&&el!==selected)el.setAttribute('data-dc-hover','')},true);
    document.addEventListener('pointerout',e=>{e.target.closest('body *')?.removeAttribute('data-dc-hover')},true);
    document.addEventListener('click',e=>{if(!design)return;const el=e.target.closest('body *');if(!el)return;choose(el);if(!el.matches('input,textarea,select')){e.preventDefault();e.stopPropagation()}},true);
    document.addEventListener('dblclick',e=>{if(!design||!selected)return;if(selected.matches('input,textarea,select,button,a')||selected.children.length===0){selected.contentEditable='true';selected.focus()}},true);
    document.addEventListener('input',e=>{if(design&&selected&&selected.contains(e.target))serialize()},true);
    addEventListener('message',e=>{const d=e.data||{};if(d.type==='dc-mode'){design=!!d.design;document.body.style.cursor=design?'default':'';return}if(d.type==='dc-select-id'){const el=document.querySelector('[data-dc-id="'+CSS.escape(String(d.id))+'"]');if(el)choose(el);return}if(d.type==='dc-match-css'&&selected&&String(d.id)===selectedId){const rules=(d.rules||[]).filter(rule=>{try{return selected.matches(rule.selector)&&String(rule.context||'').split(' > ').every(condition=>{if(condition.startsWith('@media '))return matchMedia(condition.slice(7)).matches;if(condition.startsWith('@supports '))return CSS.supports(condition.slice(10));return true})}catch{return false}});parent.postMessage({type:'dc-css-matches',id:selectedId,rules},'*');return}if(!selected)return;if(d.type==='dc-style'){selected.style[d.property]=d.value;serialize()}if(d.type==='dc-classes'){selected.setAttribute('class',d.value);serialize()}if(d.type==='dc-text'){if(!selected.children.length)selected.textContent=d.value;else{const text=[...selected.childNodes].find(n=>n.nodeType===3);if(text)text.textContent=d.value;else selected.insertBefore(document.createTextNode(d.value),selected.firstChild)}serialize()}if(d.type==='dc-clear'){selected.removeAttribute('data-dc-selected');selected=null;selectedId=''}});
    parent.postMessage({type:'dc-layers',items:summary},'*');
  })();</script>`;
  let previewHtml = html;
  if (/<head\b[^>]*>/i.test(previewHtml)) previewHtml = previewHtml.replace(/<head\b[^>]*>/i, match => `${match}${base}`);
  else previewHtml = `${base}${previewHtml}`;
  const scriptAt = previewHtml.search(/<\/body\s*>/i);
  if (scriptAt >= 0) previewHtml = `${previewHtml.slice(0, scriptAt)}${bridge}${previewHtml.slice(scriptAt)}`;
  else previewHtml += bridge;
  return previewHtml;
}

function projectPreviewUrl(reference) {
  if (!reference.startsWith('/') || reference.startsWith('//')) return null;
  try {
    const url = new URL(reference, 'http://dreamcraft.local/');
    if (url.origin !== 'http://dreamcraft.local') return null;
    let path = url.pathname.replace(/^\/+/, '');
    if (!path || url.pathname.endsWith('/')) path += 'index.html';
    path = decodeURIComponent(path);
    return `${location.origin}/site/${encodeProjectPath(path)}${url.search}${url.hash}`;
  } catch { return null; }
}

function rewriteProjectCssRootUrls(css) {
  return css.replace(/url\(\s*(['"]?)(\/(?!\/)[^)'\"]+)\1\s*\)/gi, (match, quote, url) => {
    const target = projectPreviewUrl(url);
    return target ? `url(${quote}${target}${quote})` : match;
  }).replace(/(@import\s+)(['"])(\/(?!\/)[^'"]+)\2/gi, (match, prefix, quote, url) => {
    const target = projectPreviewUrl(url);
    return target ? `${prefix}${quote}${target}${quote}` : match;
  });
}

function rewriteProjectRootUrls(html) {
  const documentCopy = new DOMParser().parseFromString(html, 'text/html');
  const urlAttributes = ['href', 'src', 'poster', 'data', 'action', 'formaction', 'cite', 'background', 'manifest', 'xlink:href'];
  for (const element of documentCopy.querySelectorAll('*')) {
    const originals = {};
    for (const name of urlAttributes) {
      if (!element.hasAttribute(name)) continue;
      const original = element.getAttribute(name);
      let targetReference = original.trim();
      if (name === 'href' && element.tagName === 'LINK' && /(?:^|\s)stylesheet(?:\s|$)/i.test(element.getAttribute('rel') || '')) {
        const preprocessorPath = resolveProjectHref(previewBasePath, targetReference);
        if (preprocessorPath && isPreprocessorPath(preprocessorPath)) {
          const cssOutput = preprocessorOutput(preprocessorPath);
          if (projectEntries.some(item => item.kind === 'file' && item.path === cssOutput)) {
            const suffix = targetReference.match(/[?#].*$/)?.[0] || '';
            targetReference = relativeProjectPath(previewBasePath, cssOutput) + suffix;
          }
        }
      }
      const rewritten = projectPreviewUrl(targetReference);
      if (rewritten || targetReference !== original.trim()) {
        originals[name] = original;
        element.setAttribute(name, rewritten || targetReference);
      }
    }
    if (element.hasAttribute('srcset') && !/^\s*data:/i.test(element.getAttribute('srcset'))) {
      const original = element.getAttribute('srcset');
      const rewritten = original.split(',').map(candidate => {
        const match = candidate.trim().match(/^(\S+)(\s+.*)?$/);
        if (!match) return candidate;
        const url = projectPreviewUrl(match[1]);
        return url ? `${url}${match[2] || ''}` : candidate;
      }).join(',');
      if (rewritten !== original) { originals.srcset = original; element.setAttribute('srcset', rewritten); }
    }
    if (element.hasAttribute('style')) {
      const original = element.getAttribute('style');
      const rewritten = rewriteProjectCssRootUrls(original);
      if (rewritten !== original) { originals.style = original; element.setAttribute('style', rewritten); }
    }
    if (Object.keys(originals).length) element.setAttribute('data-dreamcraft-original-url-attrs', JSON.stringify(originals));
  }
  for (const style of documentCopy.querySelectorAll('style')) {
    const original = style.textContent;
    const rewritten = rewriteProjectCssRootUrls(original);
    if (rewritten !== original) { style.setAttribute('data-dreamcraft-original-css', original); style.textContent = rewritten; }
  }
  return `${documentCopy.doctype ? '<!doctype html>\n' : ''}${documentCopy.documentElement.outerHTML}`;
}

async function renderPreview() {
  const ext = extension(activePath);
  let html;
  if (['css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs'].includes(ext)) {
    previewBasePath = 'index.html';
    html = await fetchText('index.html');
  } else if (['html', 'htm', 'svg'].includes(ext)) {
    previewBasePath = activePath;
    html = source();
  } else if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(activePath)) {
    previewBasePath = activePath;
    html = `<body style="margin:0;background:#151620;display:grid;place-items:center;height:100vh"><img style="max-width:94%;max-height:94%;object-fit:contain" src="${location.origin}/site/${activePath.split('/').map(encodeURIComponent).join('/')}"></body>`;
  } else {
    previewBasePath = activePath;
    html = `<body style="margin:0;background:#111219;color:#d4d5e0"><pre style="padding:24px;white-space:pre-wrap;font:13px/1.6 monospace">${escapeHtml(source())}</pre></body>`;
  }
  if (templateRegionState?.isChild && ['html', 'htm'].includes(ext)) {
    try {
      const childSource = source(), templatePath = templateInstancePath(childSource, activePath);
      if (templatePath) {
        html = await fetchText(templatePath);
        const childRegions = extractTemplateRegions(childSource);
        const childParameters = parseTemplateInstanceParameters(childSource);
        if (childParameters.size) {
          const declarations = [...childParameters].map(([name, value]) => `<!-- InstanceParam name="${name}" type="boolean" value="${value}" passthrough="false" -->`).join('\n');
          if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, match => `${match}\n${declarations}`);
          else html = `${declarations}\n${html}`;
        }
        html = html.replace(/<!--\s*TemplateBeginInstance\b[\s\S]*?-->/gi, '').replace(/<!--\s*TemplateEndInstance\s*-->/gi, '');
        for (const [name, body] of childRegions) {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const matcher = new RegExp(`(<!--\\s*TemplateBeginEditable\\s+name="${escaped}"\\s*-->)[\\s\\S]*?(<!--\\s*TemplateEndEditable\\s*-->)`);
          if (!matcher.test(html)) throw new Error(`Template region “${name}” could not be mapped.`);
          html = html.replace(matcher, (_match, open, close) => `${open}${body}${close}`);
        }
        html = adjustTemplateResourcePaths(html, templatePath, activePath);
        previewBasePath = activePath;
      }
    } catch (error) { toast(`Template preview failed: ${error.message}`); }
  }
  try {
    const parameters = parseTemplateParameters(html);
    if (templateRegionState?.isChild) {
      const templatePath = templateInstancePath(source(), activePath);
      if (templatePath) {
        const declarations = parseTemplateParameters(await fetchText(templatePath));
        if (declarations.size) html = applyTemplateParameters(html, declarations);
      }
    } else if (parameters.size) html = applyTemplateParameters(html, parameters);
  } catch (error) { toast(`Template preview failed: ${error.message}`); }
  frame.srcdoc = injectDesignBridge(rewriteProjectRootUrls(html));
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function setView(view) {
  if (templateRegionState?.isChild && !['code', 'code-split'].includes(view)) { toast('Template-based pages use Code view so locked regions stay protected.'); view = 'code'; }
  activeView = view;
  byId('designMode').classList.toggle('on', view === 'design');
  byId('splitMode').classList.toggle('on', view === 'split');
  byId('codeMode').classList.toggle('on', view === 'code');
  codeSplitButton.classList.toggle('on', view === 'code-split');
  frameBox.style.display = ['code', 'code-split'].includes(view) ? 'none' : 'block';
  byId('codeView').style.display = view === 'design' ? 'none' : 'block';
  canvas.classList.toggle('split', view === 'split');
  canvas.classList.toggle('codesplit', view === 'code-split');
  codeViewSecond.style.display = view === 'code-split' ? 'block' : 'none';
  const visualEditing = !['code', 'code-split'].includes(view) && isVisualDocument();
  frame.contentWindow?.postMessage({ type: 'dc-mode', design: visualEditing }, '*');
  if (!['code', 'code-split'].includes(view) && !visualEditing) toast('Visual element editing is available when an HTML document is open.');
  if (view !== 'design') requestAnimationFrame(() => { editor.refresh(); if (view === 'code-split') secondEditor.refresh(); });
  if (view === 'code') editor.focus();
  if (view === 'code-split') secondEditor.focus();
}

function installWorkspaceResizers() {
  const root = document.querySelector('.body');
  const explorer = document.querySelector('.explorer');
  const inspector = document.querySelector('.inspector');
  if (!root || !explorer || !inspector) return;
  const defaults = { explorer: 224, inspector: 256 };
  if (!document.getElementById('workspaceResizerStyles')) {
    const styles = document.createElement('style');
    styles.id = 'workspaceResizerStyles';
    styles.textContent = '.workspace-hidden{display:none!important}.workspace-resizer{position:relative;z-index:3;flex:0 0 5px;width:5px;margin:0 -2px;cursor:col-resize;touch-action:none;outline:none}.workspace-resizer:after{position:absolute;top:0;bottom:0;left:2px;width:1px;background:var(--line);content:"";transition:background .12s,width .12s,left .12s}.workspace-resizer:hover:after,.workspace-resizer:focus-visible:after{left:1px;width:3px;background:#9a7be5}.workspace-resizer[aria-orientation="vertical"]{user-select:none}.related-files{height:29px;flex:0 0 29px;display:flex;align-items:center;gap:5px;padding:0 15px;border-bottom:1px solid var(--line);background:var(--panel);overflow:auto}.related-files-label{padding-right:5px;color:var(--muted);font-size:8px;font-weight:700;letter-spacing:.09em}.related-file{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 8px;border:1px solid var(--line);border-radius:5px;background:transparent;color:var(--muted);font:10px var(--font);cursor:pointer}.related-file:hover{border-color:#9070d5;color:var(--text)}.canvas.codesplit{gap:12px}.canvas.codesplit .code-view,.canvas.codesplit .code-view-secondary{display:block;width:50%;max-width:none}.canvas.codesplit .preview-frame{display:none}@media(max-width:1100px){.workspace-resizer{display:none}}';
    document.head.appendChild(styles);
  }
  if (!byId('relatedFiles')) {
    const tabs = document.querySelector('.tabs');
    if (tabs) { const bar = document.createElement('div'); bar.id = 'relatedFiles'; bar.className = 'related-files workspace-hidden'; bar.setAttribute('aria-label', 'Related local stylesheets and scripts'); tabs.insertAdjacentElement('afterend', bar); }
  }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('dreamcraft.workspace.panels') || '{}'); } catch {}
  const widths = {
    explorer: Number.isFinite(saved.explorer) ? saved.explorer : defaults.explorer,
    inspector: Number.isFinite(saved.inspector) ? saved.inspector : defaults.inspector
  };
  const collapsed = { explorer: saved.explorerHidden === true, inspector: saved.inspectorHidden === true };
  const layouts = {
    standard: { explorer: 1, explorerHandle: 2, main: 3, inspectorHandle: 4, inspector: 5 },
    'inspector-left': { inspectorHandle: 1, inspector: 2, explorerHandle: 3, explorer: 4, main: 5 },
    'panels-right': { main: 1, inspectorHandle: 2, inspector: 3, explorerHandle: 4, explorer: 5 }
  };
  let dockLayout = Object.hasOwn(layouts, saved.layout) ? saved.layout : 'standard';
  const clampWidth = (side, value) => {
    const maximum = Math.max(280, Math.min(520, root.clientWidth * 0.36));
    return Math.round(Math.max(side === 'explorer' ? 168 : 220, Math.min(maximum, value)));
  };
  const apply = side => {
    const pane = side === 'explorer' ? explorer : inspector;
    const width = clampWidth(side, widths[side]);
    widths[side] = width;
    pane.style.flex = `0 0 ${width}px`;
    pane.style.width = `${width}px`;
    const handle = side === 'explorer' ? explorer.nextElementSibling : inspector.previousElementSibling;
    handle?.setAttribute('aria-valuenow', String(width));
  };
  const persist = () => {
    try { localStorage.setItem('dreamcraft.workspace.panels', JSON.stringify({ ...widths, explorerHidden: collapsed.explorer, inspectorHidden: collapsed.inspector, layout: dockLayout })); } catch {}
  };
  const applyDockLayout = layout => {
    if (!Object.hasOwn(layouts, layout)) throw new Error('Choose a valid workspace docking layout.');
    dockLayout = layout;
    root.dataset.workspaceLayout = layout;
    const handles = { explorerHandle: explorer.nextElementSibling, inspectorHandle: inspector.previousElementSibling };
    for (const [key, element] of Object.entries({ explorer, inspector, main: root.querySelector('.main'), ...handles })) {
      element.style.order = String(layouts[layout][key]);
    }
    persist();
  };
  window.applyWorkspaceLayout = applyDockLayout;
  window.getWorkspaceLayoutState = () => ({ layout: dockLayout, explorer: widths.explorer, inspector: widths.inspector, explorerHidden: collapsed.explorer, inspectorHidden: collapsed.inspector });
  window.restoreWorkspaceLayoutState = state => {
    if (!state || !Object.hasOwn(layouts, state.layout)) throw new Error('This saved workspace layout is invalid.');
    widths.explorer = clampWidth('explorer', Number(state.explorer) || defaults.explorer);
    widths.inspector = clampWidth('inspector', Number(state.inspector) || defaults.inspector);
    collapsed.explorer = state.explorerHidden === true;
    collapsed.inspector = state.inspectorHidden === true;
    explorer.classList.toggle('workspace-hidden', collapsed.explorer);
    inspector.classList.toggle('workspace-hidden', collapsed.inspector);
    applyDockLayout(state.layout);
    apply('explorer'); apply('inspector');
    explorer.nextElementSibling?.classList.toggle('workspace-hidden', collapsed.explorer);
    inspector.previousElementSibling?.classList.toggle('workspace-hidden', collapsed.inspector);
  };
  const setPanelVisibility = side => {
    const pane = side === 'explorer' ? explorer : inspector;
    const handle = side === 'explorer' ? explorer.nextElementSibling : inspector.previousElementSibling;
    collapsed[side] = !collapsed[side];
    pane.classList.toggle('workspace-hidden', collapsed[side]);
    handle?.classList.toggle('workspace-hidden', collapsed[side]);
    persist();
  };
  window.toggleWorkspacePanel = setPanelVisibility;
  window.resetWorkspacePanelSizes = () => {
    widths.explorer = defaults.explorer;
    widths.inspector = defaults.inspector;
    collapsed.explorer = false; collapsed.inspector = false;
    explorer.classList.remove('workspace-hidden'); inspector.classList.remove('workspace-hidden');
    explorer.nextElementSibling?.classList.remove('workspace-hidden');
    inspector.previousElementSibling?.classList.remove('workspace-hidden');
    apply('explorer'); apply('inspector'); persist();
  };
  const makeHandle = (side, pane) => {
    const handle = document.createElement('div');
    handle.className = 'workspace-resizer';
    handle.role = 'separator';
    handle.tabIndex = 0;
    handle.dataset.side = side;
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize ${side} panel`);
    handle.title = 'Drag to resize · arrow keys adjust · double-click resets';
    const change = value => {
      widths[side] = clampWidth(side, value);
      apply(side);
      persist();
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = event.clientX, initial = widths[side];
      handle.setPointerCapture(event.pointerId);
      const move = current => change(initial + (side === 'explorer' ? 1 : -1) * (current.clientX - start));
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = (event.key === 'ArrowRight' ? 1 : -1) * (side === 'explorer' ? 1 : -1);
      change(widths[side] + direction * (event.shiftKey ? 40 : 12));
    });
    handle.addEventListener('dblclick', () => { widths[side] = defaults[side]; apply(side); persist(); });
    pane.insertAdjacentElement(side === 'explorer' ? 'afterend' : 'beforebegin', handle);
    return handle;
  };
  makeHandle('explorer', explorer);
  makeHandle('inspector', inspector);
  apply('explorer'); apply('inspector');
  applyDockLayout(dockLayout);
  explorer.classList.toggle('workspace-hidden', collapsed.explorer);
  inspector.classList.toggle('workspace-hidden', collapsed.inspector);
  explorer.nextElementSibling?.classList.toggle('workspace-hidden', collapsed.explorer);
  inspector.previousElementSibling?.classList.toggle('workspace-hidden', collapsed.inspector);
  window.addEventListener('resize', () => { apply('explorer'); apply('inspector'); });
}

installWorkspaceResizers();

const workspaceLayoutStorageKey = 'dreamcraft.workspace.namedLayouts';
function readNamedWorkspaceLayouts() {
  try {
    const value = JSON.parse(localStorage.getItem(workspaceLayoutStorageKey) || '[]');
    return Array.isArray(value) ? value.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && item.state) : [];
  } catch { return []; }
}
function renderNamedWorkspaceLayouts() {
  const list = byId('workspaceLayoutsList');
  if (!list) return;
  const layouts = readNamedWorkspaceLayouts();
  byId('workspaceLayoutsCount').textContent = `${layouts.length} saved`;
  list.replaceChildren();
  if (!layouts.length) {
    const empty = document.createElement('div'); empty.className = 'workspace-layout-empty';
    empty.textContent = 'Your saved workspace arrangements will appear here.'; list.append(empty); return;
  }
  for (const layout of layouts) {
    const row = document.createElement('div'); row.className = 'workspace-layout-entry';
    const title = document.createElement('div'); title.className = 'workspace-layout-entry-name'; title.textContent = layout.name;
    const detail = document.createElement('small'); detail.textContent = `${layout.state.layout.replaceAll('-', ' ')} · ${layout.state.explorerHidden ? 'Files hidden' : 'Files visible'} · ${layout.state.inspectorHidden ? 'Inspector hidden' : 'Inspector visible'}`;
    title.append(detail);
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'btn'; apply.textContent = 'Apply';
    apply.addEventListener('click', () => {
      try { window.restoreWorkspaceLayoutState(layout.state); byId('workspaceLayoutSelect').value = layout.state.layout; workspaceLayoutMessage(`${layout.name} is now active.`); }
      catch (error) { workspaceLayoutMessage(error.message, true); }
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn'; remove.textContent = 'Delete'; remove.setAttribute('aria-label', `Delete saved workspace ${layout.name}`);
    remove.addEventListener('click', () => {
      try { localStorage.setItem(workspaceLayoutStorageKey, JSON.stringify(readNamedWorkspaceLayouts().filter(item => item.id !== layout.id))); renderNamedWorkspaceLayouts(); workspaceLayoutMessage(`Deleted ${layout.name}.`); }
      catch { workspaceLayoutMessage('Could not update saved workspaces in local storage.', true); }
    });
    row.append(title, apply, remove); list.append(row);
  }
}
function workspaceLayoutMessage(message, error = false) {
  const status = byId('workspaceLayoutsMessage'); status.textContent = message; status.classList.toggle('error', error);
}
function openWorkspaceLayouts() {
  byId('workspaceLayoutSelect').value = window.getWorkspaceLayoutState().layout;
  renderNamedWorkspaceLayouts(); workspaceLayoutMessage('Panel positions, widths, and visibility are saved on this computer.');
  byId('workspaceLayoutsModal').style.display = 'grid';
}
function closeWorkspaceLayouts() { byId('workspaceLayoutsModal').style.display = 'none'; }
byId('workspaceLayoutsBtn').addEventListener('click', openWorkspaceLayouts);
byId('workspaceLayoutsClose').addEventListener('click', closeWorkspaceLayouts);
byId('workspaceLayoutsCloseTop').addEventListener('click', closeWorkspaceLayouts);
byId('workspaceLayoutsModal').addEventListener('click', event => { if (event.target === byId('workspaceLayoutsModal')) closeWorkspaceLayouts(); });
byId('workspaceLayoutApply').addEventListener('click', () => {
  try { window.applyWorkspaceLayout(byId('workspaceLayoutSelect').value); workspaceLayoutMessage('Panel docking updated and saved.'); }
  catch (error) { workspaceLayoutMessage(error.message, true); }
});
byId('workspaceLayoutReset').addEventListener('click', () => {
  window.restoreWorkspaceLayoutState({ layout: 'standard', explorer: 224, inspector: 256, explorerHidden: false, inspectorHidden: false });
  byId('workspaceLayoutSelect').value = 'standard'; workspaceLayoutMessage('Default panel positions, sizes, and visibility restored.');
});
byId('workspaceLayoutSave').addEventListener('click', () => {
  const name = byId('workspaceLayoutName').value.trim();
  if (!name) { workspaceLayoutMessage('Enter a name for this workspace first.', true); byId('workspaceLayoutName').focus(); return; }
  const layouts = readNamedWorkspaceLayouts();
  const existing = layouts.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  const entry = { id: existing?.id || crypto.randomUUID(), name, state: window.getWorkspaceLayoutState() };
  const next = existing ? layouts.map(item => item.id === existing.id ? entry : item) : [...layouts, entry];
  try { localStorage.setItem(workspaceLayoutStorageKey, JSON.stringify(next)); byId('workspaceLayoutName').value = ''; renderNamedWorkspaceLayouts(); workspaceLayoutMessage(`${existing ? 'Updated' : 'Saved'} workspace ${name}.`); }
  catch { workspaceLayoutMessage('Could not save the workspace. Browser storage may be full.', true); }
});
byId('workspaceLayoutName').addEventListener('keydown', event => { if (event.key === 'Enter') byId('workspaceLayoutSave').click(); });

function insertMarkup(kind) {
  const snippets = {
    section: '<section class="section">\n  <h2>Overview</h2>\n  <p>We create thoughtful digital experiences that help people get things done.</p>\n</section>\n',
    heading: '<h2>Overview</h2>',
    paragraph: '<p>We create thoughtful digital experiences that help people get things done.</p>',
    link: '<a href="https://developer.mozilla.org/en-US/docs/Web/HTML/Element/a">HTML link reference</a>',
    button: '<a class="button" href="https://developer.mozilla.org/en-US/docs/Web/HTML">Explore HTML</a>',
    list: '<ul>\n  <li>Research</li>\n  <li>Design</li>\n  <li>Development</li>\n</ul>',
    container: '<div class="container">\n</div>\n'
  };
  if (!['html', 'htm', 'svg'].includes(extension(activePath))) {
    toast('Open an HTML document to insert page elements');
    return;
  }
  if (kind === 'image') {
    insertUploadedImage = true;
    byId('assetInput').accept = 'image/*';
    byId('assetInput').click();
    return;
  }
  setView('code');
  editor.replaceSelection(snippets[kind]);
  editor.focus();
}

function bootstrapComponentMarkup(kind) {
  const id = `dreamcraft-${kind}-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const components = {
    navbar: `<nav class="navbar navbar-expand-lg bg-body-tertiary border-bottom" aria-label="Main navigation">\n  <div class="container">\n    <a class="navbar-brand fw-semibold" href="#home">Northline</a>\n    <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#${id}" aria-controls="${id}" aria-expanded="false" aria-label="Toggle navigation"><span class="navbar-toggler-icon"></span></button>\n    <div class="collapse navbar-collapse" id="${id}">\n      <ul class="navbar-nav ms-auto"><li class="nav-item"><a class="nav-link" href="#services">Services</a></li><li class="nav-item"><a class="nav-link" href="#about">About</a></li><li class="nav-item"><a class="nav-link" href="#contact">Contact</a></li></ul>\n    </div>\n  </div>\n</nav>\n`,
    hero: `<section class="container py-5" id="home" aria-labelledby="${id}">\n  <div class="row align-items-center g-4 py-lg-5">\n    <div class="col-lg-8"><p class="text-uppercase fw-semibold text-primary mb-2">Thoughtful digital work</p><h1 class="display-3 fw-semibold" id="${id}">A clearer path from idea to impact.</h1><p class="lead text-body-secondary">We help good teams make useful, accessible experiences for the people they serve.</p><a class="btn btn-primary btn-lg" href="#contact">Start a conversation</a></div>\n  </div>\n</section>\n`,
    cards: `<section class="container py-5" id="services" aria-labelledby="${id}">\n  <h2 class="h1 mb-4" id="${id}">Ways we can help</h2>\n  <div class="row row-cols-1 row-cols-md-3 g-4">\n    <div class="col"><article class="card h-100"><div class="card-body"><h3 class="h5 card-title">Strategy</h3><p class="card-text">A clear plan shaped around real audience needs and measurable goals.</p><a class="card-link" href="#contact">Discuss strategy</a></div></article></div>\n    <div class="col"><article class="card h-100"><div class="card-body"><h3 class="h5 card-title">Design</h3><p class="card-text">An accessible visual system that makes every page feel connected.</p><a class="card-link" href="#contact">Discuss design</a></div></article></div>\n    <div class="col"><article class="card h-100"><div class="card-body"><h3 class="h5 card-title">Development</h3><p class="card-text">Responsive, maintainable websites built to support the next stage.</p><a class="card-link" href="#contact">Discuss development</a></div></article></div>\n  </div>\n</section>\n`,
    accordion: `<div class="accordion" id="${id}">\n  <div class="accordion-item"><h3 class="accordion-header"><button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#${id}-one" aria-expanded="true" aria-controls="${id}-one">What does the process include?</button></h3><div id="${id}-one" class="accordion-collapse collapse show" data-bs-parent="#${id}"><div class="accordion-body">We align on goals, shape the experience, build the site, and review it together before launch.</div></div></div>\n  <div class="accordion-item"><h3 class="accordion-header"><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#${id}-two" aria-expanded="false" aria-controls="${id}-two">How do we get started?</button></h3><div id="${id}-two" class="accordion-collapse collapse" data-bs-parent="#${id}"><div class="accordion-body">Share your goals and timeline, and we will map out the right first step.</div></div></div>\n</div>\n`,
    alert: `<div class="alert alert-success alert-dismissible fade show" role="status">\n  <strong>Changes saved.</strong> Your latest updates are ready to review.\n  <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Dismiss notification"></button>\n</div>\n`,
    modal: `<button type="button" class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#${id}">Open project details</button>\n<div class="modal fade" id="${id}" tabindex="-1" aria-labelledby="${id}-title" aria-hidden="true"><div class="modal-dialog modal-dialog-centered"><div class="modal-content"><div class="modal-header"><h2 class="modal-title fs-5" id="${id}-title">Project details</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body">Review the project scope, milestones, and next steps.</div><div class="modal-footer"><button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button><a class="btn btn-primary" href="#contact" data-bs-dismiss="modal">Contact the team</a></div></div></div></div>\n`,
    buttonGroup: `<div class="btn-group" role="group" aria-label="Explore project sections">\n  <a class="btn btn-outline-primary" href="#services">Services</a>\n  <a class="btn btn-outline-primary" href="#about">About</a>\n  <a class="btn btn-outline-primary" href="#contact">Contact</a>\n</div>\n`,
    container: `<div class="container py-4">\n  <div class="row g-4">\n    <div class="col-12 col-md-6"><section class="p-4 border rounded-3 h-100"><h2 class="h4">First column</h2><p class="mb-0">Content stays readable from phones to desktop displays.</p></section></div>\n    <div class="col-12 col-md-6"><section class="p-4 border rounded-3 h-100"><h2 class="h4">Second column</h2><p class="mb-0">The grid stacks columns on narrow screens and pairs them at medium widths.</p></section></div>\n  </div>\n</div>\n`
  };
  return components[kind] || '';
}

function insertBootstrapComponent(kind) {
  if (!['html', 'htm'].includes(extension(activePath))) return toast('Open an HTML page before inserting a Bootstrap component.');
  if (!/<link\b[^>]*href=["'][^"']*bootstrap[^"']*\.css/i.test(source())) {
    return toast('This page does not load Bootstrap CSS. Create a Bootstrap starter page, or link Bootstrap 5 CSS in the document first.');
  }
  const markup = bootstrapComponentMarkup(kind);
  if (!markup) return;
  setView('code');
  editor.replaceSelection(markup);
  editor.focus();
  byId('bootstrapComponentsModal').style.display = 'none';
  toast('Bootstrap component inserted · save to update the live preview');
}

async function formatCurrentFile() {
  const button = byId('formatPage');
  if (!window.dreamFormatter) { toast('The local formatter is still loading'); return; }
  button.disabled = true;
  const original = source();
  const cursor = editor.getCursor();
  try {
    const formatted = await window.dreamFormatter.format(original, activePath);
    if (formatted !== original) {
      replaceEditorDocument(formatted, 'format');
      editor.setCursor({ line: Math.min(cursor.line, editor.lineCount() - 1), ch: cursor.ch });
      editor.focus();
      toast(`${activePath} formatted · saving changes`);
    } else toast(`${activePath} is already formatted`);
  } catch (error) { toast(error.message || 'Could not format this file'); }
  finally { button.disabled = false; }
}

function showModal({ title, description, value = '', confirmLabel = 'Save', action }) {
  modalAction = action;
  byId('modalTitle').textContent = title;
  byId('modalDesc').textContent = description;
  byId('newFileName').value = value;
  byId('confirmModal').textContent = confirmLabel;
  byId('modal').style.display = 'grid';
  byId('newFileName').focus();
  byId('newFileName').select();
}

function hideModal() { byId('modal').style.display = 'none'; modalAction = null; }

async function loadTree() {
  try {
    const entries = await (await fetch('/api/files')).json();
    projectEntries = entries.filter(item => !item.path.split('/').some(part => part.startsWith('.')));
    scheduleCompletionIndexRefresh(projectEntries);
    const tree = byId('fileTree');
    tree.replaceChildren();
    const visible = entries.filter(item => item.path !== '.dreamcraft' && !item.path.startsWith('.dreamcraft/'));
    const files = visible.filter(item => item.kind === 'file');
    for (const item of visible) {
      const path = item.path;
      if (path.startsWith('.') || path.includes('/target/')) continue;
      const parentParts = path.split('/').slice(0, -1);
      if (parentParts.some((_, index) => collapsedFolders.has(parentParts.slice(0, index + 1).join('/')))) continue;
      if (filterAssets && item.kind === 'file' && !/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/i.test(path)) continue;
      const depth = path.split('/').length - 1;
      const row = document.createElement('div');
      row.className = `tree-item ${item.kind === 'directory' ? 'folder' : ''} ${path === activePath ? 'selected' : ''}`;
      row.dataset.path = path;
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const icon = item.kind === 'directory' ? '▰' : item.name.endsWith('.html') ? '▤' : item.name.endsWith('.css') ? '◈' : item.name.endsWith('.js') ? '◉' : /\.(png|jpe?g|svg|webp|gif)$/i.test(path) ? '▧' : '≡';
      const size = item.size < 1024 ? `${item.size} B` : `${(item.size / 1024).toFixed(1)} KB`;
      row.innerHTML = `<span class="file-ico ${extension(path)}">${icon}</span><span>${escapeHtml(item.name)}</span>${item.kind === 'file' ? `<span class="tree-tail">${size}</span>` : ''}`;
      row.addEventListener('click', () => {
        if (item.kind === 'directory') {
          if (collapsedFolders.has(path)) collapsedFolders.delete(path); else collapsedFolders.add(path);
          loadTree();
        } else openFile(path);
      });
      row.addEventListener('contextmenu', event => { event.preventDefault(); showContextMenu(event.clientX, event.clientY, item); });
      tree.appendChild(row);
    }
    byId('fileCount').textContent = `${files.length} files · local`;
    if (files.length && !files.some(item => item.path === activePath)) await openFile(files.some(item => item.path === 'index.html') ? 'index.html' : files[0].path);
  } catch { byId('fileCount').textContent = 'Server unavailable'; }
}

function assetKind(path) {
  if (/\.(avif|bmp|gif|jpe?g|png|svg|webp|ico)$/i.test(path)) return 'image';
  if (/\.(woff2?|ttf|otf|eot)$/i.test(path)) return 'font';
  return 'other';
}

async function openAssetLibrary() {
  byId('assetLibraryModal').style.display = 'grid';
  byId('assetLibrarySearch').value = '';
  byId('assetLibraryType').value = 'all';
  byId('assetLibraryStatus').textContent = 'Loading project assets…';
  byId('assetLibraryStatus').classList.remove('error');
  try {
    const response = await fetch('/api/files');
    if (!response.ok) throw new Error('Could not read project files.');
    const entries = await response.json();
    assetLibraryEntries = entries.filter(entry => {
      if (entry.kind !== 'file' || entry.path.split('/').some(part => part.startsWith('.'))) return false;
      return assetKind(entry.path) !== 'other' || entry.path.split('/').includes('assets') || /\.(pdf|mp4|webm|mp3|wav|json|txt)$/i.test(entry.path);
    });
    renderAssetLibrary();
    byId('assetLibrarySearch').focus();
  } catch (error) {
    byId('assetLibraryGrid').replaceChildren();
    byId('assetLibraryStatus').textContent = error.message;
    byId('assetLibraryStatus').classList.add('error');
  }
}

function renderAssetLibrary() {
  const grid = byId('assetLibraryGrid');
  grid.replaceChildren();
  const query = byId('assetLibrarySearch').value.trim().toLocaleLowerCase();
  const type = byId('assetLibraryType').value;
  const matching = assetLibraryEntries.filter(entry => {
    const kind = assetKind(entry.path);
    return (type === 'all' || type === kind || type === 'other' && kind === 'other') && (!query || entry.path.toLocaleLowerCase().includes(query));
  });
  byId('assetLibraryCount').textContent = `${matching.length} of ${assetLibraryEntries.length} assets`;
  byId('assetLibraryStatus').textContent = matching.length ? 'Select an action on an asset. Image dimensions are read from the actual project file.' : 'No assets match this search and type filter.';
  if (!matching.length) {
    const empty = document.createElement('div'); empty.className = 'asset-empty'; empty.textContent = assetLibraryEntries.length ? 'Try a different search or filter.' : 'This project has no image, font, or media assets yet. Add assets to use them in your pages.'; grid.appendChild(empty); return;
  }
  for (const entry of matching) {
    const kind = assetKind(entry.path);
    const card = document.createElement('article'); card.className = 'asset-card';
    const preview = document.createElement('div'); preview.className = 'asset-preview';
    if (kind === 'image') {
      const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.src = apiPath(entry.path);
      image.addEventListener('load', () => { meta.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${formatAssetSize(entry.size)}`; }, { once: true });
      image.addEventListener('error', () => { image.remove(); const mark = document.createElement('span'); mark.className = 'asset-file-mark'; mark.textContent = '▧'; preview.appendChild(mark); }, { once: true });
      preview.appendChild(image);
    } else {
      const mark = document.createElement('span'); mark.className = kind === 'font' ? 'asset-font-mark' : 'asset-file-mark'; mark.textContent = kind === 'font' ? 'Ag' : /\.(mp4|webm|mp3|wav)$/i.test(entry.path) ? '♫' : '▤'; preview.appendChild(mark);
    }
    const info = document.createElement('div'); info.className = 'asset-info';
    const name = document.createElement('div'); name.className = 'asset-name'; name.textContent = entry.name; name.title = entry.path;
    const meta = document.createElement('div'); meta.className = 'asset-meta'; meta.textContent = `${kind} · ${formatAssetSize(entry.size)}`;
    info.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'asset-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn'; copy.textContent = 'Copy path'; copy.title = 'Copy path relative to the open document';
    copy.addEventListener('click', async () => {
      const path = encodeProjectPath(relativeProjectPath(activePath, entry.path));
      try { await navigator.clipboard.writeText(path); byId('assetLibraryStatus').textContent = `Copied ${path}`; byId('assetLibraryStatus').classList.remove('error'); }
      catch { byId('assetLibraryStatus').textContent = `Path: ${path}`; }
    });
    const open = document.createElement('button'); open.type = 'button'; open.className = 'btn'; open.textContent = 'Open'; open.title = 'Open this file in the editor';
    open.addEventListener('click', async () => { byId('assetLibraryModal').style.display = 'none'; await openFile(entry.path); });
    actions.append(copy, open);
    if (kind === 'image' && ['html', 'htm', 'xhtml'].includes(extension(activePath))) {
      const insert = document.createElement('button'); insert.type = 'button'; insert.className = 'btn primary'; insert.textContent = 'Insert'; insert.title = 'Insert an image with accessible alternative text';
      insert.addEventListener('click', () => insertLibraryImage(entry)); actions.appendChild(insert);
    } else if (['css', 'scss', 'sass', 'less'].includes(extension(activePath))) {
      const insert = document.createElement('button'); insert.type = 'button'; insert.className = 'btn primary'; insert.textContent = 'Insert URL'; insert.title = 'Insert this asset as a CSS url() value';
      insert.addEventListener('click', () => insertLibraryCssUrl(entry)); actions.appendChild(insert);
    }
    card.append(preview, info, actions); grid.appendChild(card);
  }
}

function formatAssetSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function insertLibraryImage(entry) {
  const imagePath = encodeProjectPath(relativeProjectPath(activePath, entry.path));
  byId('assetLibraryModal').style.display = 'none';
  showModal({ title: 'Describe this image', description: 'Write alternative text that conveys the image’s purpose. Leave it empty only when the image is decorative.', value: '', confirmLabel: 'Insert image', action: () => {
    const alt = byId('newFileName').value.trim();
    setView('code'); editor.replaceSelection(`<img src="${escapeHtml(imagePath)}" alt="${escapeHtml(alt)}">`); editor.focus(); hideModal();
  } });
}

function insertLibraryCssUrl(entry) {
  const path = encodeProjectPath(relativeProjectPath(activePath, entry.path)).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  setView('code'); editor.replaceSelection(`url("${path}")`); editor.focus();
  byId('assetLibraryModal').style.display = 'none';
}

async function createFile() {
  const path = byId('newFileName').value.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) {
    toast('Enter a project-relative path');
    return;
  }
  const entries = await (await fetch('/api/files')).json();
  if (entries.some(item => item.path === path)) {
    toast('That path already exists');
    return;
  }
  const ext = extension(path);
  let content = '';
  if (['html', 'htm'].includes(ext)) {
    const pageTitle = path.split('/').pop().replace(/\.[^.]+$/, '').replace(/^\.+/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, letter => letter.toUpperCase()) || 'Website';
    const projectTitle = byId('projectName').textContent.trim();
    const styleSheet = entries.find(item => item.kind === 'file' && !item.path.split('/').some(part => part.startsWith('.')) && /\.css$/i.test(item.path));
    const link = styleSheet ? `  <link rel="stylesheet" href="${escapeHtml(encodeProjectPath(relativeProjectPath(path, styleSheet.path)))}">\n` : '';
    content = `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${escapeHtml(pageTitle)}${projectTitle ? ` · ${escapeHtml(projectTitle)}` : ''}</title>\n${link}</head>\n<body>\n  <main id="main"></main>\n</body>\n</html>\n`;
  }
  if (ext === 'js') content = "'use strict';\n\n";
  const response = await fetch(apiPath(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
  if (!response.ok) { toast('Could not create the file'); return; }
  hideModal();
  await loadTree();
  await openFile(path);
  toast(`Created ${path}`);
}

async function createFolder() {
  const path = byId('newFileName').value.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) return toast('Enter a valid project-relative path');
  const response = await fetch('/api/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  if (!response.ok) return toast('Could not create the folder');
  hideModal();
  await loadTree();
  toast(`Created folder ${path}`);
}

function showContextMenu(x, y, item) {
  document.querySelector('.context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${Math.min(x, innerWidth - 165)}px`;
  menu.style.top = `${Math.min(y, innerHeight - 90)}px`;
  for (const [label, action] of [['Rename', () => renameItem(item)], ['Delete', () => deleteItem(item)]]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = async () => { menu.remove(); await action(); };
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function renameItem(item) {
  if (item.path === activePath && dirty && !(await save())) return;
  showModal({ title: 'Rename item', description: 'Choose a new path inside this project.', value: item.path, confirmLabel: 'Rename', action: async () => {
    const to = byId('newFileName').value.trim().replaceAll('\\', '/');
    if (!to || to.split('/').some(part => part === '..' || part === '.')) return toast('Enter a valid project path');
    const response = await fetch('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: item.path, to }) });
    if (!response.ok) return toast('Rename failed. The destination may already exist.');
    if (activePath === item.path) activePath = to;
    await loadTree();
    if (activePath === to) await openFile(to);
  }});
}

async function deleteItem(item) {
  const confirmed = window.confirm(`Delete ${item.path}? This removes the item from the project folder.`);
  if (!confirmed) return;
  const response = await fetch(apiPath(item.path), { method: 'DELETE' });
  if (!response.ok) { toast('Delete failed. Folders must be empty.'); return; }
  if (activePath === item.path) { activePath = ''; setDirty(false); }
  await loadTree();
  toast(`Deleted ${item.path}`);
}

function searchPattern(query) {
  let expression = byId('searchRegex').checked ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (byId('searchWords').checked) expression = `(?<![\\w$])(?:${expression})(?![\\w$])`;
  return new RegExp(expression, `g${byId('searchRegex').checked ? 'm' : ''}${byId('searchCase').checked ? '' : 'i'}`);
}

async function searchProject(query) {
  const requestId = ++searchRequestId;
  const resultsEl = byId('searchResults');
  const summary = byId('searchSummary');
  resultsEl.replaceChildren(); summary.textContent = '';
  searchMatches = []; replacePreview = []; byId('replacePreviewList').replaceChildren();
  byId('replaceApply').disabled = true;
  const needle = query.trim();
  if (!needle) return;
  let pattern;
  try { pattern = searchPattern(needle); }
  catch (error) { resultsEl.textContent = `Invalid regular expression: ${error.message}`; return; }
  resultsEl.textContent = 'Searching project…';
  try {
    const response = await fetch('/api/files');
    if (!response.ok) throw new Error('Could not list project files.');
    const files = (await response.json()).filter(item => item.kind === 'file' && !item.path.split('/').some(part => part.startsWith('.')) && /\.(html?|css|scss|less|js|mjs|cjs|ts|jsx|tsx|json|md|svg|xml|txt|vue|php|py|rs)$/i.test(item.path));
    const matches = [];
    for (const file of files) {
      if (requestId !== searchRequestId) return;
      let text;
      try { text = file.path === activePath && dirty ? source() : await fetchText(file.path); } catch { continue; }
      const lines = text.split('\n'), lineStarts = [0];
      for (let offset = 0; (offset = text.indexOf('\n', offset)) >= 0; offset++) lineStarts.push(offset + 1);
      const counts = new Map(); pattern.lastIndex = 0;
      for (const occurrence of text.matchAll(pattern)) {
        let low = 0, high = lineStarts.length;
        while (low < high) { const mid = (low + high) >>> 1; if (lineStarts[mid] <= occurrence.index) low = mid + 1; else high = mid; }
        const lineIndex = Math.max(0, low - 1); counts.set(lineIndex, (counts.get(lineIndex) || 0) + 1);
      }
      counts.forEach((count, index) => matches.push({ path: file.path, line: index + 1, count, text: lines[index].trim().slice(0, 180) }));
    }
    if (requestId !== searchRequestId) return;
    searchMatches = matches;
    resultsEl.replaceChildren();
    const occurrenceCount = matches.reduce((count, match) => count + match.count, 0);
    summary.textContent = `${occurrenceCount} match${occurrenceCount === 1 ? '' : 'es'} in ${new Set(matches.map(match => match.path)).size} file${new Set(matches.map(match => match.path)).size === 1 ? '' : 's'}`;
    if (!matches.length) { resultsEl.textContent = 'No matches'; return; }
    matches.slice(0, 200).forEach(match => {
      const row = document.createElement('div');
      row.className = 'search-result';
      row.innerHTML = `<strong>${escapeHtml(match.path)}:${match.line} · ${match.count}</strong><small>${escapeHtml(match.text)}</small>`;
      row.onclick = async () => { byId('searchModal').style.display = 'none'; await openFile(match.path); setView('code'); editor.setCursor({ line: match.line - 1, ch: 0 }); editor.focus(); };
      resultsEl.appendChild(row);
    });
    if (matches.length > 200) { const more = document.createElement('div'); more.className = 'search-summary'; more.textContent = `Showing the first 200 matching lines. Replace preview covers all ${matches.length} matching lines.`; resultsEl.appendChild(more); }
  } catch (error) { if (requestId === searchRequestId) resultsEl.textContent = error.message; }
}

async function replaceMatches() {
  const find = byId('searchInput').value.trim();
  const replacement = byId('replaceInput').value;
  const previewList = byId('replacePreviewList');
  previewList.replaceChildren(); replacePreview = []; byId('replaceApply').disabled = true;
  if (!find || !searchMatches.length) return showReplaceSummary('Search for matching text before previewing replacements.', true);
  let pattern;
  try { pattern = searchPattern(find); } catch (error) { return showReplaceSummary(`Invalid regular expression: ${error.message}`, true); }
  const paths = [...new Set(searchMatches.map(match => match.path))];
  for (const path of paths) {
    let original;
    try { original = path === activePath && dirty ? source() : await fetchText(path); } catch { continue; }
    pattern.lastIndex = 0;
    const matches = [...original.matchAll(pattern)];
    if (!matches.length) continue;
    if (matches.some(match => match[0].length === 0)) return showReplaceSummary(`The expression matches zero-width positions in ${path}. Add a character-consuming pattern before replacing.`, true);
    const updated = byId('searchRegex').checked ? original.replace(pattern, replacement) : original.replace(pattern, () => replacement);
    if (/<!--\s*TemplateBeginInstance\s+template="/i.test(original) && templateLockedProjection(original) !== templateLockedProjection(updated)) {
      return showReplaceSummary(`The replacement would change locked template markup in ${path}. Edit the source template to change shared content.`, true);
    }
    const singlePattern = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    const examples = matches.slice(0, 5).map(match => {
      const start = Math.max(0, match.index - 38), end = Math.min(original.length, match.index + match[0].length + 38);
      const before = original.slice(start, end).replaceAll('\n', '↵');
      const after = before.replace(singlePattern, value => byId('searchRegex').checked ? value.replace(singlePattern, replacement) : replacement);
      return { before, after };
    });
    replacePreview.push({ path, original, updated, count: matches.length, examples });
  }
  previewList.replaceChildren();
  if (!replacePreview.length) return showReplaceSummary('No files have replacements for the current search options.', true);
  replacePreview.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'replace-preview-row';
    const label = document.createElement('label'); label.className = 'replace-preview-head';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.dataset.index = String(index);
    checkbox.addEventListener('change', updateReplaceSelection);
    const path = document.createElement('span'); path.textContent = item.path;
    const count = document.createElement('small'); count.textContent = `${item.count} replacement${item.count === 1 ? '' : 's'}`;
    label.append(checkbox, path, count); row.appendChild(label);
    const details = document.createElement('details'); details.className = 'replace-preview-detail';
    const summary = document.createElement('summary'); summary.textContent = `Review ${item.examples.length} changed ${item.examples.length === 1 ? 'snippet' : 'snippets'}`; details.appendChild(summary);
    item.examples.forEach(example => { const diff = document.createElement('pre'); diff.textContent = `− ${example.before}\n+ ${example.after}`; details.appendChild(diff); });
    row.appendChild(details); previewList.appendChild(row);
  });
  byId('replaceApply').disabled = false;
  updateReplaceSelection();
}

function updateReplaceSelection() {
  const selected = [...byId('replacePreviewList').querySelectorAll('input[type="checkbox"]:checked')];
  const count = selected.reduce((sum, input) => sum + replacePreview[Number(input.dataset.index)].count, 0);
  byId('replaceApply').disabled = !selected.length;
  showReplaceSummary(`${count} replacement${count === 1 ? '' : 's'} selected across ${selected.length} file${selected.length === 1 ? '' : 's'}. A recovery snapshot is created before applying changes.`);
}

function showReplaceSummary(message, error = false) {
  const summary = byId('replaceSummary'); summary.textContent = message; summary.classList.toggle('error', error);
}

function templateLockedProjection(text) {
  return text.replace(/<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->[\s\S]*?<!--\s*TemplateEndEditable\s*-->/g, (_match, name) => `<!-- TemplateBeginEditable name="${name}" -->__EDITABLE_${name}__<!-- TemplateEndEditable -->`)
    .replace(/<!--\s*InstanceParam\s+name="([^"]+)"\s+type="boolean"\s+value="(?:true|false)"\s+passthrough="(?:true|false)"\s*-->/g, (_match, name) => `<!-- InstanceParam name="${name}" type="boolean" value="__PARAM_${name}__" passthrough="false" -->`);
}

async function applyReplacements() {
  const selectedIndices = [...byId('replacePreviewList').querySelectorAll('input[type="checkbox"]:checked')].map(input => Number(input.dataset.index));
  const selected = selectedIndices.map(index => replacePreview[index]).filter(Boolean);
  if (!selected.length) return;
  if (dirty && !(await save())) return showReplaceSummary('Save the current file before applying replacements.', true);
  for (const item of selected) {
    let current;
    try { current = item.path === activePath ? source() : await fetchText(item.path); }
    catch (error) { return showReplaceSummary(`Could not recheck ${item.path}: ${error.message}`, true); }
    if (current !== item.original) {
      await searchProject(byId('searchInput').value);
      return showReplaceSummary(`The project changed after this preview. Review the refreshed results before applying replacements.`, true);
    }
  }
  const apply = byId('replaceApply'); apply.disabled = true;
  try {
    const snapshotResponse = await fetch('/api/snapshots', { method: 'POST' });
    const snapshot = await snapshotResponse.json();
    if (!snapshotResponse.ok) throw new Error(snapshot.error || 'Could not create the recovery snapshot; no files were changed.');
    let changed = 0;
    for (const item of selected) {
      if (item.path === activePath) {
        replaceEditorDocument(item.updated, 'project-replace');
        if (!(await save())) throw new Error(`Could not save ${item.path}. Recovery snapshot: ${snapshot.id}`);
      } else {
        const response = await fetch(apiPath(item.path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: item.updated }) });
        if (!response.ok) throw new Error(`Could not save ${item.path}. Earlier changes are recoverable from snapshot ${snapshot.id}.`);
        historyByPath.delete(item.path); cursorByPath.delete(item.path);
        completionSourceByPath.delete(item.path);
      }
      changed += item.count;
    }
    await loadTree(); await renderPreview();
    replacePreview = [];
    await searchProject(byId('searchInput').value);
    showReplaceSummary(`Replaced ${changed} occurrence${changed === 1 ? '' : 's'} in ${selected.length} file${selected.length === 1 ? '' : 's'}. Recovery snapshot ${snapshot.id} is available in Snapshots.`);
  } catch (error) { showReplaceSummary(error.message, true); }
  finally { apply.disabled = false; }
}

function openSearch() {
  byId('searchModal').style.display = 'grid';
  byId('searchInput').focus();
  byId('searchInput').select();
  searchProject(byId('searchInput').value);
}

async function publishSite(openInNewTab = true) {
  if (!(await save())) return false;
  const newTab = openInNewTab ? window.open('about:blank', '_blank') : null;
  const response = await fetch('/api/publish', { method: 'POST' });
  if (!response.ok) { if (newTab) newTab.close(); toast('Local publish failed'); return false; }
  const result = await response.json();
  lastPublishUrl = new URL(result.url, location.origin).href;
  if (newTab) newTab.location.replace(lastPublishUrl);
  else if (openInNewTab) toast(`Published locally: ${lastPublishUrl}`);
  toast(`Published local snapshot · ${lastPublishUrl}`);
  return true;
}

function deployMessage(text, isError = false) {
  const element = byId('deployMessage');
  element.textContent = text;
  element.classList.remove('hide', 'git-error');
  if (isError) element.classList.add('git-error');
}

async function openPublishDialog() {
  byId('publishModal').style.display = 'grid';
  byId('deployMessage').classList.add('hide');
  sftpComparedTarget = null;
  sftpRemoteDirectory = '';
  sftpRemoteEntries = [];
  byId('sftpRemoteList').replaceChildren(Object.assign(document.createElement('div'), { className: 'sftp-empty', textContent: 'Compare to inspect the configured SFTP folder.' }));
  byId('sftpDownload').disabled = true;
  byId('sftpUpload').disabled = true;
  byId('sftpRename').disabled = true;
  byId('sftpDelete').disabled = true;
  byId('sftpParent').disabled = true;
  try {
    const response = await fetch('/api/deploy/settings');
    const settings = await response.json();
    byId('deployHost').value = settings.host;
    byId('deployUser').value = settings.username;
    byId('deployPath').value = settings.remote_path;
  } catch (error) { deployMessage('Could not load SFTP settings: ' + error.message, true); }
}

async function openSnapshotDialog() {
  byId('snapshotModal').style.display = 'grid';
  await loadSnapshots();
}

async function loadSnapshots() {
  const list = byId('snapshotList');
  list.replaceChildren(Object.assign(document.createElement('div'), { className: 'snapshot-empty', textContent: 'Loading project snapshots…' }));
  byId('snapshotMessage').classList.add('hide');
  try {
    const response = await fetch('/api/snapshots');
    const snapshots = await response.json();
    if (!response.ok) throw new Error(snapshots.error || 'Could not load project snapshots.');
    list.replaceChildren();
    if (!snapshots.length) {
      list.append(Object.assign(document.createElement('div'), { className: 'snapshot-empty', textContent: 'No snapshots exist yet. Create a local publish snapshot or download remote files to add one.' }));
      return;
    }
    for (const snapshot of snapshots) {
      const row = document.createElement('div');
      row.className = 'snapshot-row';
      const details = document.createElement('div');
      const date = new Date(Number(snapshot.created_ms));
      const size = snapshot.bytes < 1024 ? `${snapshot.bytes} B` : snapshot.bytes < 1048576 ? `${(snapshot.bytes / 1024).toFixed(1)} KB` : `${(snapshot.bytes / 1048576).toFixed(1)} MB`;
      details.append(
        Object.assign(document.createElement('div'), { className: 'snapshot-title', textContent: Number.isNaN(date.valueOf()) ? snapshot.id : date.toLocaleString() }),
        Object.assign(document.createElement('div'), { className: 'snapshot-meta', textContent: `${snapshot.files} files · ${size} · ${snapshot.id}` })
      );
      const restore = document.createElement('button');
      restore.className = 'btn';
      restore.textContent = 'Restore';
      restore.addEventListener('click', () => restoreSnapshot(snapshot));
      row.append(details, restore);
      list.append(row);
    }
  } catch (error) {
    list.replaceChildren(Object.assign(document.createElement('div'), { className: 'snapshot-empty', textContent: error.message }));
  }
}

async function restoreSnapshot(snapshot) {
  const accepted = window.confirm(`Restore snapshot from ${new Date(Number(snapshot.created_ms)).toLocaleString()}? DreamCraft will first preserve the current project as a new snapshot.`);
  if (!accepted) return;
  if (dirty && !(await save())) return;
  byId('snapshotMessage').textContent = 'Creating a recovery point and restoring the selected snapshot…';
  byId('snapshotMessage').classList.remove('hide', 'git-error');
  try {
    const response = await fetch(`/api/snapshots/${encodeURIComponent(snapshot.id)}/restore`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Snapshot restore failed.');
    setDirty(false);
    await loadTree();
    if (result.paths.includes(activePath)) await loadFile(activePath);
    else if (result.paths.includes('index.html')) await loadFile('index.html');
    else if (result.paths.length) await loadFile(result.paths[0]);
    await loadSnapshots();
    byId('snapshotMessage').textContent = `Restored ${result.files} files. The previous project state is preserved as snapshot ${result.backup}.`;
    byId('snapshotMessage').classList.remove('hide');
    toast(`Snapshot restored · ${result.files} files`);
  } catch (error) {
    byId('snapshotMessage').textContent = error.message;
    byId('snapshotMessage').classList.add('git-error');
  }
}

async function saveDeploySettings() {
  const response = await fetch('/api/deploy/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: byId('deployHost').value, username: byId('deployUser').value, remote_path: byId('deployPath').value })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'Could not save SFTP settings.');
  }
}

async function deployProject() {
  const button = byId('deployNow');
  button.disabled = true;
  deployMessage('Saving connection and uploading project files…');
  try {
    await saveDeploySettings();
    const response = await fetch('/api/deploy/publish', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'SFTP upload failed.');
    deployMessage(`Uploaded ${result.files} files to ${result.destination}.`);
    toast(`SFTP publish complete · ${result.files} files`);
  } catch (error) { deployMessage(error.message, true); }
  finally { button.disabled = false; }
}

function sftpFormatSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

function sftpFormTarget() {
  return { host: byId('deployHost').value.trim(), username: byId('deployUser').value.trim(), remote_path: byId('deployPath').value.trim() };
}

function openRemoteManagement(transport, action, paths) {
  const modal = byId('remoteActionModal');
  remoteAction = { transport, action, paths };
  byId('remoteActionTitle').textContent = action === 'delete' ? 'Delete remote files?' : 'Rename remote file';
  byId('remoteActionDescription').textContent = action === 'delete'
    ? `Permanently delete ${paths.length} remote file${paths.length === 1 ? '' : 's'}? This cannot be undone. ${paths.join(', ')}`
    : `Rename ${paths[0]} on the remote website. The destination must be in the same folder and must not already exist.`;
  byId('remoteActionLabel').classList.toggle('hide', action !== 'rename');
  byId('remoteActionName').classList.toggle('hide', action !== 'rename');
  byId('remoteActionName').value = action === 'rename' ? paths[0].split('/').pop() : '';
  byId('remoteActionConfirm').textContent = action === 'delete' ? 'Delete files' : 'Rename file';
  byId('remoteActionConfirm').classList.toggle('danger', action === 'delete');
  byId('remoteActionMessage').classList.add('hide');
  modal.style.display = 'grid';
  if (action === 'rename') { byId('remoteActionName').focus(); byId('remoteActionName').select(); }
}

function ftpFormTarget() {
  return { host: byId('ftpHost').value.trim(), port: Number(byId('ftpPort').value), username: byId('ftpUser').value.trim(), secure: byId('ftpSecurity').value === 'ftps', remote_path: byId('ftpPath').value.trim() };
}

function webdavFormTarget() {
  return { endpoint: byId('webdavEndpoint').value.trim(), username: byId('webdavUser').value.trim(), remote_path: byId('webdavPath').value.trim() };
}

function invalidateFtpComparison() {
  if (!ftpComparedTarget) return;
  ftpComparedTarget = null;
  ftpCompareEntries = [];
  renderFtpComparison('Connection settings changed. Compare again before synchronizing or managing remote files.');
}

function invalidateWebdavComparison() {
  if (!webdavComparedTarget) return;
  webdavComparedTarget = null;
  webdavCompareEntries = [];
  byId('webdavReviewList').replaceChildren(Object.assign(document.createElement('div'), { className: 'webdav-review-empty', textContent: 'Connection settings changed. Compare again before synchronizing or managing remote files.' }));
  updateWebdavDownloadButton();
}

async function executeRemoteManagement() {
  if (!remoteAction) return;
  const { transport, action, paths } = remoteAction;
  let body;
  if (action === 'rename') {
    const name = byId('remoteActionName').value.trim();
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) {
      byId('remoteActionMessage').textContent = 'Enter a valid file name without folder separators.';
      byId('remoteActionMessage').classList.remove('hide');
      return;
    }
    const folder = paths[0].includes('/') ? paths[0].slice(0, paths[0].lastIndexOf('/') + 1) : '';
    const to = folder + name;
    if (to === paths[0]) return byId('remoteActionModal').style.display = 'none';
    body = { from: paths[0], to };
  } else body = { paths };
  const confirm = byId('remoteActionConfirm');
  confirm.disabled = true;
  byId('remoteActionMessage').textContent = 'Applying the remote file change…';
  byId('remoteActionMessage').classList.remove('hide', 'git-error');
  try {
    if (transport === 'sftp') {
      if (!sftpComparedTarget || JSON.stringify(sftpComparedTarget) !== JSON.stringify(sftpFormTarget())) throw new Error('Connection settings changed. Compare remote again before managing files.');
      await saveDeploySettings();
    } else if (transport === 'ftp') await saveFtpSettings();
    else await saveWebdavSettings();
    if (transport === 'ftp' && (!ftpComparedTarget || JSON.stringify(ftpComparedTarget) !== JSON.stringify(ftpFormTarget()))) throw new Error('Connection settings changed. Compare remote again before managing files.');
    if (transport === 'webdav' && (!webdavComparedTarget || JSON.stringify(webdavComparedTarget) !== JSON.stringify(webdavFormTarget()))) throw new Error('Connection settings changed. Compare remote again before managing files.');
    const response = await fetch(`/api/${transport === 'sftp' ? 'deploy' : transport}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Remote ${action} failed.`);
    byId('remoteActionModal').style.display = 'none';
    toast(action === 'delete' ? `Deleted ${paths.length} remote file${paths.length === 1 ? '' : 's'}` : `Renamed remote file to ${body.to}`);
    if (transport === 'sftp') await loadSftpDirectory();
    if (transport === 'ftp') await compareFtp();
    if (transport === 'webdav') await compareWebdav();
  } catch (error) {
    byId('remoteActionMessage').textContent = error.message;
    byId('remoteActionMessage').classList.remove('hide');
    byId('remoteActionMessage').classList.add('git-error');
  } finally { confirm.disabled = false; }
}

function selectedSftpRemoteFiles() {
  return [...byId('sftpRemoteList').querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => sftpRemoteEntries.find(entry => entry.path === input.dataset.path))
    .filter(entry => entry && entry.kind === 'file' && entry.status !== 'local-only');
}

function invalidateSftpComparison() {
  if (!sftpComparedTarget) return;
  sftpComparedTarget = null;
  sftpRemoteDirectory = '';
  sftpRemoteEntries = [];
  byId('sftpRemoteList').replaceChildren(Object.assign(document.createElement('div'), { className: 'sftp-empty', textContent: 'Connection settings changed. Compare remote again before synchronizing.' }));
  byId('sftpRemotePath').textContent = byId('deployPath').value.trim() || 'Remote folder not configured';
  byId('sftpDownload').disabled = true;
  byId('sftpUpload').disabled = true;
  byId('sftpParent').disabled = true;
}

function updateSftpSelection() {
  const selected = [...byId('sftpRemoteList').querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => sftpRemoteEntries.find(entry => entry.path === input.dataset.path))
    .filter(Boolean);
  byId('sftpDownload').disabled = !selected.some(entry => entry.downloadable);
  byId('sftpUpload').disabled = !selected.some(entry => entry.uploadable);
  const remoteFiles = selectedSftpRemoteFiles();
  byId('sftpDelete').disabled = !remoteFiles.length;
  byId('sftpRename').disabled = remoteFiles.length !== 1;
}

function renderSftpEntries() {
  const list = byId('sftpRemoteList');
  list.replaceChildren();
  if (!sftpRemoteEntries.length) {
    list.append(Object.assign(document.createElement('div'), { className: 'sftp-empty', textContent: 'This remote folder contains no regular files or folders.' }));
  }
  for (const entry of sftpRemoteEntries) {
    const row = document.createElement('div');
    row.className = 'sftp-row';
    const select = document.createElement('input');
    select.type = 'checkbox';
    select.dataset.path = entry.path;
    select.disabled = entry.kind === 'directory';
    select.checked = ['remote-only', 'local-only', 'different-size', 'different'].includes(entry.status);
    select.setAttribute('aria-label', `Select ${entry.path}`);
    select.addEventListener('change', updateSftpSelection);
    const openableFolder = entry.kind === 'directory' && entry.navigable;
    const name = document.createElement(openableFolder ? 'button' : 'span');
    name.className = openableFolder ? 'sftp-folder' : 'sftp-name';
    name.textContent = entry.kind === 'directory' ? `▸ ${entry.name}` : entry.name;
    name.title = entry.path;
    if (openableFolder) name.addEventListener('click', () => { sftpRemoteDirectory = entry.path; loadSftpDirectory(); });
    const status = document.createElement('span');
    status.className = `sftp-state ${entry.status}`;
    status.textContent = ({ folder: 'Folder', 'remote-only': 'Remote only', 'local-only': 'Local only', 'different-size': 'Size differs', 'same-size-unverified': 'Same size · unverified', identical: 'Identical', different: 'Content differs' })[entry.status] || entry.status;
    const size = document.createElement('span');
    size.className = 'sftp-size';
    size.textContent = entry.kind === 'directory' ? '—' : `${sftpFormatSize(entry.size)}${entry.local_size !== null && entry.local_size !== undefined ? ` / ${sftpFormatSize(entry.local_size)}` : ''}`;
    row.append(select, name, status, size);
    list.append(row);
  }
  byId('sftpParent').disabled = !sftpRemoteDirectory;
  updateSftpSelection();
}

async function loadSftpDirectory() {
  const list = byId('sftpRemoteList');
  list.replaceChildren(Object.assign(document.createElement('div'), { className: 'sftp-empty', textContent: 'Reading remote folder…' }));
  byId('sftpDownload').disabled = true;
  byId('sftpUpload').disabled = true;
  byId('sftpRemotePath').textContent = [byId('deployPath').value.trim().replace(/\/$/, ''), sftpRemoteDirectory].filter(Boolean).join('/') || '/';
  try {
    const response = await fetch('/api/deploy/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: sftpRemoteDirectory }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not read the remote folder.');
    sftpRemoteEntries = result;
    renderSftpEntries();
    return true;
  } catch (error) {
    sftpRemoteEntries = [];
    list.replaceChildren(Object.assign(document.createElement('div'), { className: 'sftp-empty', textContent: error.message }));
    deployMessage(error.message, true);
    return false;
  }
}

async function compareSftpRemote() {
  const button = byId('sftpCompare');
  button.disabled = true;
  deployMessage('Saving the SFTP connection and comparing this folder…');
  try {
    await saveDeploySettings();
    sftpComparedTarget = sftpFormTarget();
    sftpRemoteDirectory = '';
    if (await loadSftpDirectory()) byId('deployMessage').classList.add('hide');
  } catch (error) { deployMessage(error.message, true); }
  finally { button.disabled = false; }
}

async function transferSftpSelection(direction) {
  const selected = [...byId('sftpRemoteList').querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => sftpRemoteEntries.find(entry => entry.path === input.dataset.path))
    .filter(Boolean);
  const entries = selected.filter(entry => direction === 'download' ? entry.downloadable : entry.uploadable);
  if (!entries.length) return deployMessage(`Select at least one ${direction === 'download' ? 'remote' : 'local'} file first.`, true);
  if (!sftpComparedTarget || JSON.stringify(sftpComparedTarget) !== JSON.stringify(sftpFormTarget())) {
    return deployMessage('Connection settings changed. Compare remote again before synchronizing.', true);
  }
  const button = byId(direction === 'download' ? 'sftpDownload' : 'sftpUpload');
  button.disabled = true;
  deployMessage(`${direction === 'download' ? 'Downloading remote files' : 'Uploading local files'}…`);
  try {
    if (!(await save())) throw new Error('Save the open file before synchronizing the website.');
    const response = await fetch(`/api/deploy/sync${direction === 'upload' ? '-upload' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: entries.map(entry => entry.path) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'SFTP synchronization failed.');
    if (direction === 'download') {
      for (const entry of entries) { historyByPath.delete(entry.path); cursorByPath.delete(entry.path); }
      await loadTree();
      const activeDownloaded = entries.find(entry => entry.path === activePath);
      if (activeDownloaded) {
        const content = await fetchText(activePath);
        setEditorContent(content, activePath, false);
        await renderPreview();
      }
    }
    deployMessage(`${direction === 'download' ? 'Downloaded' : 'Uploaded'} ${result.files} files. Recovery snapshot: ${result.backup}.`);
    toast(`SFTP ${direction} complete · ${result.files} files`);
    await loadSftpDirectory();
  } catch (error) { deployMessage(error.message, true); }
  finally { button.disabled = false; }
}

function webdavMessage(text, isError = false) {
  const element = byId('webdavMessage');
  element.textContent = text;
  element.classList.remove('hide', 'git-error');
  if (isError) element.classList.add('git-error');
}

async function openWebdavDialog() {
  byId('webdavModal').style.display = 'grid';
  byId('webdavMessage').classList.add('hide');
  webdavComparedTarget = null;
  webdavCompareEntries = [];
  renderWebdavComparison();
  try {
    const response = await fetch('/api/webdav/settings');
    const settings = await response.json();
    byId('webdavEndpoint').value = settings.endpoint;
    byId('webdavUser').value = settings.username;
    byId('webdavPassword').value = '';
    byId('webdavPath').value = settings.remote_path;
    if (settings.password_set) webdavMessage('A password is stored for this endpoint and username. Leave the password field empty to keep it.');
  } catch (error) { webdavMessage('Could not load WebDAV settings: ' + error.message, true); }
}

async function saveWebdavSettings() {
  const response = await fetch('/api/webdav/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: byId('webdavEndpoint').value,
      username: byId('webdavUser').value,
      password: byId('webdavPassword').value,
      remote_path: byId('webdavPath').value
    })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'Could not save WebDAV settings.');
  }
  byId('webdavPassword').value = '';
}

async function testWebdav() {
  const button = byId('webdavTest');
  button.disabled = true;
  webdavMessage('Saving settings and checking the WebDAV collection…');
  try {
    await saveWebdavSettings();
    const response = await fetch('/api/webdav/test', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'WebDAV connection failed.');
    webdavMessage('Connection reached the WebDAV collection.');
  } catch (error) { webdavMessage(error.message, true); }
  finally { button.disabled = false; }
}

async function publishWebdav() {
  const button = byId('webdavPublish');
  button.disabled = true;
  webdavMessage('Saving settings and uploading an immutable site snapshot…');
  try {
    await saveWebdavSettings();
    const response = await fetch('/api/webdav/publish', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'WebDAV upload failed.');
    webdavMessage(`Uploaded ${result.files} files to ${result.destination}.`);
    toast(`WebDAV publish complete · ${result.files} files`);
  } catch (error) { webdavMessage(error.message, true); }
  finally { button.disabled = false; }
}

function ftpMessage(text, isError = false) {
  const element = byId('ftpMessage');
  element.textContent = text;
  element.classList.remove('hide', 'git-error');
  if (isError) element.classList.add('git-error');
}

async function openFtpDialog() {
  byId('ftpModal').style.display = 'grid';
  byId('ftpMessage').classList.add('hide');
  ftpCompareEntries = [];
  ftpComparedTarget = null;
  renderFtpComparison();
  try {
    const response = await fetch('/api/ftp/settings');
    const settings = await response.json();
    byId('ftpHost').value = settings.host;
    byId('ftpPort').value = settings.port;
    byId('ftpUser').value = settings.username;
    byId('ftpPassword').value = '';
    byId('ftpSecurity').value = settings.secure ? 'ftps' : 'ftp';
    byId('ftpPath').value = settings.remote_path || '/public_html';
    byId('ftpSecurity').dispatchEvent(new Event('change'));
    if (settings.password_set) ftpMessage('A password is stored for this exact server configuration. Leave its field empty to keep it.');
  } catch (error) { ftpMessage('Could not load FTP settings: ' + error.message, true); }
}

async function saveFtpSettings() {
  const response = await fetch('/api/ftp/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      host: byId('ftpHost').value,
      port: Number(byId('ftpPort').value),
      username: byId('ftpUser').value,
      password: byId('ftpPassword').value,
      secure: byId('ftpSecurity').value === 'ftps',
      remote_path: byId('ftpPath').value
    })
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'Could not save FTP settings.');
  }
  byId('ftpPassword').value = '';
}

async function testFtpConnection() {
  const button = byId('ftpTest');
  button.disabled = true;
  ftpMessage('Saving settings and checking the FTP server…');
  try {
    await saveFtpSettings();
    const response = await fetch('/api/ftp/test', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'FTP connection failed.');
    ftpMessage('Connected, authenticated, and confirmed the remote working directory.');
  } catch (error) { ftpMessage(error.message, true); }
  finally { button.disabled = false; }
}

async function publishFtp() {
  const button = byId('ftpPublish');
  button.disabled = true;
  ftpMessage('Saving settings and uploading the immutable project snapshot…');
  try {
    await saveFtpSettings();
    const response = await fetch('/api/ftp/publish', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'FTP upload failed.');
    ftpMessage(`Uploaded ${result.files} files to ${result.destination}. Snapshot ${result.snapshot} is stored locally.`);
    toast(`FTP publish complete · ${result.files} files`);
  } catch (error) { ftpMessage(error.message, true); }
  finally { button.disabled = false; }
}

async function compareFtp() {
  const button = byId('ftpCompare'); button.disabled = true;
  ftpComparedTarget = null;
  ftpCompareEntries = [];
  byId('ftpReviewList').replaceChildren(Object.assign(document.createElement('div'), { className: 'webdav-review-empty', textContent: 'Comparing the complete remote site and verifying matching files…' }));
  ftpMessage('Saving settings and comparing the FTP site byte-for-byte…');
  try {
    if (!(await save())) throw new Error('Save the open file before comparing the website.');
    await saveFtpSettings();
    const response = await fetch('/api/ftp/compare', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'FTP comparison failed.');
    ftpCompareEntries = result;
    ftpComparedTarget = ftpFormTarget();
    renderFtpComparison();
    const differences = result.filter(entry => !['identical', 'folder'].includes(entry.status)).length;
    ftpMessage(`Compared ${result.filter(entry => entry.kind === 'file').length} files; ${differences} need review.`);
  } catch (error) {
    ftpCompareEntries = [];
    renderFtpComparison(error.message);
    ftpMessage(error.message, true);
  } finally { button.disabled = false; }
}

function renderFtpComparison(error = '') {
  const list = byId('ftpReviewList'); list.replaceChildren();
  if (error) list.append(Object.assign(document.createElement('div'), { className: 'webdav-review-empty', textContent: error }));
  else if (!ftpCompareEntries.length) list.append(Object.assign(document.createElement('div'), { className: 'webdav-review-empty', textContent: 'No files found. Compare to check the configured FTP site.' }));
  else for (const entry of ftpCompareEntries) {
    const row = document.createElement('label'); row.className = 'webdav-row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.ftpPath = entry.path;
    checkbox.checked = ['remote-only', 'local-only', 'different', 'different-size'].includes(entry.status);
    checkbox.disabled = entry.kind !== 'file';
    checkbox.addEventListener('change', updateFtpSyncButtons);
    const path = Object.assign(document.createElement('span'), { className: 'webdav-file', textContent: entry.path, title: entry.path });
    const status = Object.assign(document.createElement('span'), { className: `webdav-state ${entry.status}`, textContent: entry.status.replaceAll('-', ' ') });
    row.append(checkbox, path, status); list.append(row);
  }
  updateFtpSyncButtons();
}

function selectedFtpPaths(direction) {
  const uploadable = new Set(['local-only', 'different', 'different-size']);
  const downloadable = new Set(['remote-only', 'different', 'different-size']);
  return [...byId('ftpReviewList').querySelectorAll('input[type="checkbox"]:checked')]
    .filter(input => (direction === 'upload' ? uploadable : downloadable).has(ftpCompareEntries.find(entry => entry.path === input.dataset.ftpPath)?.status))
    .map(input => input.dataset.ftpPath);
}

function updateFtpSyncButtons() {
  byId('ftpDownload').disabled = !selectedFtpPaths('download').length;
  byId('ftpUpload').disabled = !selectedFtpPaths('upload').length;
  const remoteFiles = [...byId('ftpReviewList').querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => ftpCompareEntries.find(entry => entry.path === input.dataset.ftpPath))
    .filter(entry => entry && entry.kind === 'file' && entry.status !== 'local-only');
  byId('ftpDelete').disabled = !remoteFiles.length;
  byId('ftpRename').disabled = remoteFiles.length !== 1;
}

function selectedFtpPathsForManagement() {
  return [...byId('ftpReviewList').querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => ftpCompareEntries.find(entry => entry.path === input.dataset.ftpPath))
    .filter(entry => entry && entry.kind === 'file' && entry.status !== 'local-only')
    .map(entry => entry.path);
}

async function syncFtp(direction) {
  const paths = selectedFtpPaths(direction);
  if (!paths.length) return;
  if (!ftpComparedTarget || JSON.stringify(ftpComparedTarget) !== JSON.stringify(ftpFormTarget())) return ftpMessage('Connection settings changed. Compare again before synchronizing.', true);
  const button = byId(direction === 'download' ? 'ftpDownload' : 'ftpUpload'); button.disabled = true;
  ftpMessage(`${direction === 'download' ? 'Downloading' : 'Uploading'} ${paths.length} selected FTP files…`);
  try {
    await saveFtpSettings();
    const response = await fetch(`/api/ftp/${direction === 'download' ? 'sync' : 'sync-upload'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `FTP ${direction} failed.`);
    ftpMessage(`${direction === 'download' ? 'Downloaded' : 'Uploaded'} ${result.files} files. A recovery snapshot was created.`);
    await loadTree();
    if (direction === 'download' && paths.includes(activePath)) await loadFile(activePath);
    await compareFtp();
  } catch (error) { ftpMessage(error.message, true); }
  finally { button.disabled = false; updateFtpSyncButtons(); }
}

async function compareWebdav() {
  const button = byId('webdavCompare');
  button.disabled = true;
  webdavComparedTarget = null;
  webdavCompareEntries = [];
  byId('webdavDownload').disabled = true;
  byId('webdavReviewList').replaceChildren(Object.assign(document.createElement('div'), { className: 'webdav-review-empty', textContent: 'Comparing the complete local and remote project…' }));
  webdavMessage('Saving connection and comparing remote files byte-for-byte…');
  try {
    if (!(await save())) throw new Error('Save the open file before comparing the website.');
    await saveWebdavSettings();
    const response = await fetch('/api/webdav/compare', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'WebDAV comparison failed.');
    webdavCompareEntries = result;
    webdavComparedTarget = webdavFormTarget();
    renderWebdavComparison();
    const differences = result.filter(entry => entry.status !== 'identical').length;
    webdavMessage(`Compared ${result.length} files. ${differences} file${differences === 1 ? '' : 's'} differ between local and remote.`);
  } catch (error) {
    webdavCompareEntries = [];
    byId('webdavReviewList').replaceChildren(Object.assign(document.createElement('div'), { className: 'webdav-review-empty', textContent: error.message }));
    webdavMessage(error.message, true);
  } finally { button.disabled = false; }
}

function renderWebdavComparison() {
  const list = byId('webdavReviewList');
  list.replaceChildren();
  if (!webdavCompareEntries.length) {
    list.append(Object.assign(document.createElement('div'), { className: 'webdav-review-empty', textContent: 'No files found in the configured project.' }));
    updateWebdavDownloadButton();
    return;
  }
  for (const entry of webdavCompareEntries) {
    const row = document.createElement('label');
    row.className = 'webdav-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = ['remote-only', 'local-only', 'different', 'different-size'].includes(entry.status);
    checkbox.disabled = entry.status === 'local-only';
    checkbox.dataset.remotePath = entry.path;
    checkbox.addEventListener('change', updateWebdavDownloadButton);
    const path = Object.assign(document.createElement('span'), { className: 'webdav-file', textContent: entry.path, title: entry.path });
    const status = Object.assign(document.createElement('span'), { className: `webdav-state ${entry.status}`, textContent: entry.status.replaceAll('-', ' ') });
    row.append(checkbox, path, status);
    list.append(row);
  }
  updateWebdavDownloadButton();
}

function updateWebdavDownloadButton() {
  byId('webdavDownload').disabled = !selectedWebdavPaths('download').length;
  byId('webdavUpload').disabled = !selectedWebdavPaths('upload').length;
  const remoteFiles = [...byId('webdavReviewList').querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => webdavCompareEntries.find(entry => entry.path === input.dataset.remotePath))
    .filter(entry => entry && entry.kind === 'file' && entry.status !== 'local-only');
  byId('webdavDelete').disabled = !remoteFiles.length;
  byId('webdavRename').disabled = remoteFiles.length !== 1;
}

function selectedWebdavPathsForManagement() {
  return [...byId('webdavReviewList').querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => webdavCompareEntries.find(entry => entry.path === input.dataset.remotePath))
    .filter(entry => entry && entry.kind === 'file' && entry.status !== 'local-only')
    .map(entry => entry.path);
}

function selectedWebdavPaths(direction) {
  const eligible = new Set(direction === 'download' ? ['remote-only', 'different', 'different-size'] : ['local-only', 'different', 'different-size']);
  return [...byId('webdavReviewList').querySelectorAll('input[type="checkbox"]:checked')]
    .filter(input => eligible.has(webdavCompareEntries.find(entry => entry.path === input.dataset.remotePath)?.status))
    .map(input => input.dataset.remotePath);
}

async function downloadWebdavSelection() {
  const button = byId('webdavDownload');
  const paths = selectedWebdavPaths('download');
  if (!paths.length) return;
  if (!webdavComparedTarget || JSON.stringify(webdavComparedTarget) !== JSON.stringify(webdavFormTarget())) return webdavMessage('Connection settings changed. Compare again before synchronizing.', true);
  button.disabled = true;
  webdavMessage(`Downloading ${paths.length} selected remote file${paths.length === 1 ? '' : 's'}…`);
  try {
    if (!(await save())) throw new Error('Save the open file before synchronizing the website.');
    await saveWebdavSettings();
    const response = await fetch('/api/webdav/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'WebDAV download failed.');
    webdavMessage(`Downloaded ${result.files} files.${result.backup_created ? ' An immutable snapshot preserves the previous local files.' : ''}`);
    toast(`WebDAV download complete · ${result.files} files`);
    await loadTree();
    const active = paths.includes(activePath);
    if (active) await loadFile(activePath);
    await compareWebdav();
  } catch (error) { webdavMessage(error.message, true); }
  finally { button.disabled = false; updateWebdavDownloadButton(); }
}

async function uploadWebdavSelection() {
  const button = byId('webdavUpload');
  const paths = selectedWebdavPaths('upload');
  if (!paths.length) return;
  if (!webdavComparedTarget || JSON.stringify(webdavComparedTarget) !== JSON.stringify(webdavFormTarget())) return webdavMessage('Connection settings changed. Compare again before synchronizing.', true);
  button.disabled = true;
  webdavMessage(`Uploading ${paths.length} selected file${paths.length === 1 ? '' : 's'} from the recoverable site snapshot…`);
  try {
    if (!(await save())) throw new Error('Save the open file before synchronizing the website.');
    await saveWebdavSettings();
    const response = await fetch('/api/webdav/sync-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'WebDAV upload failed.');
    webdavMessage(`Uploaded ${result.files} files. Recovery snapshot: ${result.backup}.`);
    toast(`WebDAV upload complete · ${result.files} files`);
    await compareWebdav();
  } catch (error) { webdavMessage(error.message, true); }
  finally { button.disabled = false; updateWebdavDownloadButton(); }
}

async function uploadAssets(files) {
  if (insertUploadedImage && [...files].some(file => !file.type.startsWith('image/') && !/\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(file.name))) {
    insertUploadedImage = false;
    toast('Image insertion accepts image files. Use Add image or font for other assets.');
    return;
  }
  const form = new FormData();
  [...files].forEach(file => form.append('files', file, file.name));
  const response = await fetch('/api/upload', { method: 'POST', body: form });
  if (!response.ok) { insertUploadedImage = false; toast('Asset upload failed'); return; }
  filterAssets = true;
  byId('assetsBtn').classList.add('active');
  await loadTree();
  if (byId('assetLibraryModal').style.display === 'grid') await openAssetLibrary();
  if (insertUploadedImage) {
    insertUploadedImage = false;
    showImageDescriptionDialog([...files]);
  }
  toast(`Added ${files.length} asset${files.length === 1 ? '' : 's'} to site/assets`);
}

function showImageDescriptionDialog(files) {
  document.getElementById('imageDescriptionBackdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop image-description-backdrop';
  backdrop.id = 'imageDescriptionBackdrop';
  backdrop.style.display = 'grid';
  const dialog = document.createElement('section');
  dialog.className = 'modal image-description-modal';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'imageDescriptionTitle');
  const title = document.createElement('h2'); title.id = 'imageDescriptionTitle'; title.textContent = 'Describe the images';
  const description = document.createElement('p'); description.textContent = 'Add alternative text for each image. Leave a field empty only when that image is decorative. The files are already in the project; canceling skips markup insertion.';
  const fields = document.createElement('div'); fields.className = 'image-description-fields';
  const inputs = files.map(file => {
    const row = document.createElement('div'); row.className = 'image-description-row';
    const label = document.createElement('label'); label.className = 'prop-label'; label.textContent = file.name;
    const input = document.createElement('input'); input.type = 'text'; input.className = 'input'; input.autocomplete = 'off'; input.setAttribute('aria-label', `Alternative text for ${file.name}`);
    row.append(label, input); fields.appendChild(row); return { file, input };
  });
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel'; cancel.onclick = () => { backdrop.remove(); toast('Uploaded assets remain available in the project.'); };
  const insert = document.createElement('button'); insert.type = 'button'; insert.className = 'btn primary'; insert.textContent = 'Insert images';
  insert.onclick = () => {
    const markup = inputs.map(({ file, input }) => {
      const imagePath = encodeProjectPath(relativeProjectPath(activePath, `assets/${file.name.replaceAll('\\', '/')}`));
      return `<img src="${escapeHtml(imagePath)}" alt="${escapeHtml(input.value.trim())}">`;
    }).join('\n');
    backdrop.remove(); setView('code'); editor.replaceSelection(markup); editor.focus();
  };
  actions.append(cancel, insert); dialog.append(title, description, fields, actions); backdrop.appendChild(dialog);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) cancel.click(); });
  document.body.appendChild(backdrop); inputs[0]?.input.focus();
}

function openTemplateDialog() {
  byId('templateModal').style.display = 'grid';
  updateTemplateDetails();
  byId('templatePath').focus();
}

function updateTemplateDetails() {
  const choice = starterPages[byId('templateChoice').value];
  byId('templateDetails').textContent = choice.description;
  byId('templatePath').value = choice.path;
}

async function createTemplatePage() {
  const path = byId('templatePath').value.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) {
    toast('Enter a project-relative page path');
    return;
  }
  const entries = await (await fetch('/api/files')).json();
  if (entries.some(item => item.path === path)) {
    toast('That path already exists');
    return;
  }
  const templateId = byId('templateChoice').value;
  const response = await fetch('/starters/' + templateId + '.html');
  if (!response.ok) { toast('The selected starter page could not be loaded'); return; }
  const content = await response.text();
  const saveResponse = await fetch(apiPath(path), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (!saveResponse.ok) { toast('Could not create the starter page'); return; }
  byId('templateModal').style.display = 'none';
  await loadTree();
  await openFile(path);
  toast('Created ' + path);
}

function gitMessage(message, isError = false) {
  const el = byId('gitMessage');
  el.textContent = message;
  el.classList.remove('hide', 'git-error');
  if (isError) el.classList.add('git-error');
}

async function gitRequest(path, method = 'GET', body = undefined) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.error || 'Git request failed.');
  return result;
}

function gitActionButton(label, action, confirmMessage = '') {
  const button = document.createElement('button');
  button.className = 'btn';
  button.textContent = label;
  button.addEventListener('click', async () => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    button.disabled = true;
    try {
      if (action === 'commit') {
        const message = byId('gitCommitMessage').value.trim();
        await gitRequest('/api/git/commit', 'POST', { message });
        byId('gitCommitMessage').value = '';
        gitMessage('Commit created.');
      } else {
        const result = await gitRequest('/api/git/action', 'POST', { action });
        gitMessage(result.output || action[0].toUpperCase() + action.slice(1) + ' completed.');
      }
      await loadGitStatus();
    } catch (error) {
      gitMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

async function showGitDiff(path, staged = false) {
  try {
    byId('gitDiffTitle').textContent = (staged ? 'Staged diff · ' : 'Working diff · ') + path;
    const result = await gitRequest('/api/git/diff/' + path.split('/').map(encodeURIComponent).join('/') + '?staged=' + staged);
    byId('gitDiff').textContent = result.diff || 'No line diff is available for this file.';
  } catch (error) {
    byId('gitDiff').textContent = error.message;
  }
}

function renderGitFiles(files) {
  const root = byId('gitFiles');
  root.replaceChildren();
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'git-empty';
    empty.textContent = 'Working tree clean. Your project changes will appear here.';
    root.appendChild(empty);
    return;
  }
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'git-file';
    const status = document.createElement('span');
    status.className = 'git-file-status';
    status.textContent = file.status;
    const name = document.createElement('button');
    name.className = 'git-file-name';
    name.title = file.path + ' — show diff';
    name.textContent = file.path;
    const worktreeChanged = file.status[1] !== ' ' || file.status === '??';
    const stagedChanged = file.status[0] !== ' ' && file.status[0] !== '?';
    name.addEventListener('click', () => showGitDiff(file.path, stagedChanged && !worktreeChanged));
    const stage = document.createElement('button');
    const shouldUnstage = stagedChanged && !worktreeChanged;
    stage.title = shouldUnstage ? 'Unstage' : 'Stage';
    stage.textContent = shouldUnstage ? '−' : '+';
    stage.addEventListener('click', async () => {
      try {
        await gitRequest('/api/git/' + (stage.textContent === '+' ? 'stage' : 'unstage'), 'POST', { path: file.path });
        await loadGitStatus();
      } catch (error) {
        gitMessage(error.message, true);
      }
    });
    row.append(status, name, stage);
    root.appendChild(row);
  }
}

async function loadGitStatus() {
  try {
    const status = await gitRequest('/api/git/status');
    gitRepository = status.repository;
    const branch = byId('gitBranch');
    branch.replaceChildren();
    const label = document.createElement('span');
    label.textContent = status.repository ? 'Branch' : 'Repository';
    const value = document.createElement('strong');
    value.textContent = status.repository ? status.branch : 'not initialized';
    branch.append(label, value);
    renderGitBranchControls(status);
    renderGitTagControls(status);
    const initArea = byId('gitInitArea');
    initArea.replaceChildren();
    if (!status.repository) {
      const init = document.createElement('button');
      init.className = 'btn primary';
      init.textContent = 'Initialize repository';
      init.addEventListener('click', async () => {
        if (!window.confirm('Initialize Git version control in this website project?')) return;
        try {
          await gitRequest('/api/git/init', 'POST');
          gitMessage('Git repository initialized.');
          await loadGitStatus();
        } catch (error) { gitMessage(error.message, true); }
      });
      initArea.appendChild(init);
    }
    const actions = byId('gitActions');
    actions.replaceChildren();
    if (status.repository) {
      const buttons = [
        gitActionButton('Fetch', 'fetch'),
        gitActionButton('Pull', 'pull', 'Pull the current branch and update local files?'),
        gitActionButton('Push', 'push', 'Push local commits to the configured remote? This sends committed project changes to that remote.')
      ];
      if (status.tags?.length) buttons.push(gitActionButton('Push tags', 'push-tags', 'Push local Git tags to the configured remote?'));
      actions.append(...buttons);
    }
    byId('gitStageAll').disabled = !status.repository || status.files.length === 0;
    byId('gitCommit').disabled = !status.repository;
    byId('gitRemoteSection').classList.toggle('hide', !status.repository);
    byId('gitRemoteUrl').value = status.remote || '';
    renderGitFiles(status.files);
    const history = byId('gitHistory');
    history.replaceChildren();
    for (const item of status.history) {
      const row = document.createElement('div');
      row.className = 'git-history-row';
      const hash = document.createElement('strong');
      hash.textContent = item.hash;
      const subject = document.createElement('div');
      subject.textContent = item.subject;
      const date = document.createElement('span');
      date.textContent = item.date;
      const revert = document.createElement('button');
      revert.className = 'btn'; revert.type = 'button'; revert.textContent = 'Revert'; revert.title = `Create a new commit that reverses ${item.hash}`;
      revert.addEventListener('click', () => runGitRevert(item.hash, item.subject));
      row.append(hash, subject, date, revert);
      history.appendChild(row);
    }
    if (!status.history.length) history.innerHTML = '<div class="git-empty">No commits yet.</div>';
  } catch (error) {
    gitMessage(error.message, true);
    byId('gitBranch').textContent = 'Git is unavailable';
  }
}

function renderGitTagControls(status) {
  let panel = byId('gitTagControls');
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'gitTagControls'; panel.className = 'git-section';
    panel.innerHTML = '<div class="git-section-head">Release tags</div><div class="git-commit-box"><input class="input" id="gitTagName" aria-label="Annotated tag name" placeholder="v1.0.0"><button class="btn" id="gitTagCreate">Tag current commit</button></div><div class="git-hint">Creates an annotated local tag at the current commit. Push tags to share them with origin.</div><div id="gitTagList"></div>';
    byId('gitRemoteSection').insertAdjacentElement('afterend', panel);
    byId('gitTagCreate').addEventListener('click', () => runGitTag('create', byId('gitTagName').value.trim()));
    byId('gitTagName').addEventListener('keydown', event => { if (event.key === 'Enter') runGitTag('create', event.currentTarget.value.trim()); });
  }
  panel.classList.toggle('hide', !status.repository);
  const list = byId('gitTagList'); list.replaceChildren();
  for (const name of status.tags || []) {
    const row = document.createElement('div'); row.className = 'git-file';
    const label = document.createElement('span'); label.className = 'git-file-status'; label.textContent = 'tag';
    const value = document.createElement('span'); value.className = 'git-file-name'; value.textContent = name; value.title = name;
    const remove = document.createElement('button'); remove.className = 'git-file-action'; remove.type = 'button'; remove.textContent = '×'; remove.title = `Delete local tag ${name}`;
    remove.addEventListener('click', () => runGitTag('delete', name));
    row.append(label, value, remove); list.appendChild(row);
  }
  if (!status.tags?.length) list.append(Object.assign(document.createElement('div'), { className: 'git-empty', textContent: 'No local tags yet.' }));
}

async function runGitTag(action, name) {
  if (!name) return gitMessage('Enter a tag name.', true);
  if (action === 'delete' && !window.confirm(`Delete the local tag ${name}? This does not remove a tag already pushed to a remote.`)) return;
  try {
    const result = await gitRequest('/api/git/tag', 'POST', { action, name, message: name });
    if (action === 'create') byId('gitTagName').value = '';
    await loadGitStatus();
    gitMessage(result.output || (action === 'create' ? `Created annotated tag ${name}.` : `Deleted local tag ${name}.`));
  } catch (error) { gitMessage(error.message, true); }
}

async function runGitRevert(hash, subject) {
  if (!window.confirm(`Create a new commit that reverses “${subject}” (${hash})? Existing history will remain unchanged.`)) return;
  try {
    const result = await gitRequest('/api/git/revert', 'POST', { hash });
    await loadGitStatus();
    gitMessage(result.output || `Created a revert commit for ${hash}.`);
  } catch (error) {
    gitMessage(error.message, true);
    await loadGitStatus();
  }
}

function renderGitBranchControls(status) {
  let panel = byId('gitBranchControls');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'gitBranchControls';
    panel.className = 'git-section';
    panel.innerHTML = '<div class="git-section-head">Branches</div><div class="git-commit-box"><input class="input" id="gitBranchName" aria-label="New branch name" placeholder="feature/new-page"><button class="btn" id="gitBranchCreate">Create and switch</button></div><div class="git-commit-box" style="margin-top:7px"><select class="input" id="gitBranchSelect" aria-label="Local Git branch"></select><button class="btn" id="gitBranchSwitch">Switch</button><button class="btn" id="gitBranchMerge">Merge into current</button></div>';
    byId('gitBranch').insertAdjacentElement('afterend', panel);
    byId('gitBranchCreate').addEventListener('click', () => runGitBranch('create'));
    byId('gitBranchName').addEventListener('keydown', event => { if (event.key === 'Enter') runGitBranch('create'); });
    byId('gitBranchName').addEventListener('input', () => updateGitBranchButtons());
    byId('gitBranchSwitch').addEventListener('click', () => runGitBranch('switch'));
    byId('gitBranchMerge').addEventListener('click', () => runGitBranch('merge'));
    byId('gitBranchSelect').addEventListener('change', updateGitBranchButtons);
  }
  panel.classList.toggle('hide', !status.repository);
  const select = byId('gitBranchSelect');
  select.replaceChildren();
  for (const name of status.branches || []) {
    const option = document.createElement('option'); option.value = name; option.textContent = name;
    option.selected = name === status.branch;
    select.appendChild(option);
  }
  updateGitBranchButtons(status.branch);
}

function updateGitBranchButtons(currentBranch = byId('gitBranch')?.querySelector('strong')?.textContent || '') {
  const select = byId('gitBranchSelect');
  if (!select) return;
  const hasSelection = Boolean(select.value);
  const isCurrent = select.value === currentBranch;
  byId('gitBranchSwitch').disabled = !hasSelection || isCurrent;
  byId('gitBranchMerge').disabled = !hasSelection || isCurrent;
  byId('gitBranchCreate').disabled = !byId('gitBranchName').value.trim();
}

async function runGitBranch(action) {
  const name = action === 'create' ? byId('gitBranchName').value.trim() : byId('gitBranchSelect').value;
  if (!name) return gitMessage('Enter or select a branch name.', true);
  if (action === 'merge' && !window.confirm(`Merge ${name} into the current branch? Resolve any conflicts in the editor, then commit to complete the merge.`)) return;
  if (action === 'switch' && document.querySelectorAll('#gitFiles .git-file').length && !window.confirm(`Switch to ${name}? Git may carry non-conflicting uncommitted edits to the other branch.`)) return;
  try {
    const result = await gitRequest('/api/git/branch', 'POST', { action, name });
    byId('gitBranchName').value = '';
    await loadGitStatus();
    gitMessage(result.output || (action === 'merge' ? `Merged ${name}.` : `${action === 'create' ? 'Created and switched to' : 'Switched to'} ${name}.`));
  } catch (error) {
    gitMessage(error.message, true);
    await loadGitStatus();
  }
}

function openGit() {
  closeAi();
  byId('gitBackdrop').classList.add('open');
  byId('gitBtn').classList.add('active');
  loadGitStatus();
}

function closeGit() {
  byId('gitBackdrop').classList.remove('open');
  byId('gitBtn').classList.remove('active');
}

function setAiSettingsOpen(open) {
  byId('aiSettings').classList.toggle('hide', !open);
  if (open) byId('aiEndpoint').focus();
}

async function loadAiSettings() {
  try {
    const response = await fetch('/api/ai/settings');
    const settings = await response.json();
    aiConfigured = settings.configured;
    byId('aiEndpoint').value = settings.endpoint;
    byId('aiModel').value = settings.model;
    byId('aiKey').value = '';
    updateAiStatus(settings);
  } catch {
    byId('aiStatus').textContent = 'Dream AI settings could not be loaded from the local app server.';
  }
}

function updateAiStatus(settings) {
  const status = byId('aiStatus');
  status.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'ai-dot' + (settings.configured ? ' ready' : '');
  status.appendChild(dot);
  const strong = document.createElement('strong');
  strong.textContent = settings.configured ? settings.model + ' · Configured' : 'No AI connection configured';
  status.appendChild(strong);
  const detail = document.createElement('span');
  detail.textContent = settings.configured ? ' at ' + settings.endpoint : ' · Open connection settings to connect a local or hosted model.';
  status.appendChild(detail);
}

function openAi() {
  byId('aiBackdrop').classList.add('open');
  byId('aiBtn').classList.add('active');
  renderAiContext();
  loadAiSettings();
  if (!aiConfigured) setAiSettingsOpen(true);
  else byId('aiPrompt').focus();
}

function closeAi() {
  cancelAiRequest();
  byId('aiBackdrop').classList.remove('open');
  byId('aiBtn').classList.remove('active');
}

function setAiMode(mode) {
  aiMode = mode;
  byId('aiChatMode').classList.toggle('selected', mode === 'chat');
  byId('aiEditMode').classList.toggle('selected', mode === 'edit');
  byId('aiPrompt').placeholder = mode === 'edit' ? `Describe the changes for ${activePath}…` : 'Ask Dream AI about this page…';
  byId('aiDisclosure').textContent = mode === 'edit'
    ? `Edit mode sends the complete ${activePath} file for a single-file change. The result is reviewed before it is applied.`
    : 'Ask mode sends your prompt, the open file, selected project context, and recent conversation to your configured endpoint.';
  byId('aiActiveFile').textContent = activePath;
  renderAiContext();
}

async function renderAiContext() {
  const root = byId('aiContextOptions');
  if (!root) return;
  try {
    const response = await fetch('/api/files');
    if (!response.ok) throw new Error('Could not list project files');
    aiContextEntries = (await response.json()).filter(entry => entry.kind === 'file' && entry.path !== activePath && entry.size <= 120000 && !['png','jpg','jpeg','gif','webp','ico','woff','woff2','ttf','otf','pdf','zip','gz','mp4','webm'].includes(extension(entry.path)));
    root.replaceChildren();
    if (!aiContextEntries.length) {
      const empty = document.createElement('span');
      empty.className = 'ai-small';
      empty.textContent = 'No additional text files are available in this website.';
      root.appendChild(empty);
      return;
    }
    for (const entry of aiContextEntries) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = entry.path;
      checkbox.checked = ['.html','.htm','.css','.scss','.js','.mjs','.json','.md','.svg'].includes('.' + extension(entry.path));
      label.append(checkbox, document.createTextNode(entry.path));
      root.appendChild(label);
    }
  } catch {
    root.replaceChildren();
    const message = document.createElement('span');
    message.className = 'ai-small';
    message.textContent = 'Project context files could not be loaded.';
    root.appendChild(message);
  }
}

function aiDiff(before, after) {
  const oldLines = before.split('\n'), newLines = after.split('\n');
  if (oldLines.length * newLines.length > 160000) return 'File is too large for an inline diff. Use the reviewed replacement preview above.';
  const rows = Array.from({length: oldLines.length + 1}, () => new Uint32Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i--) for (let j = newLines.length - 1; j >= 0; j--) rows[i][j] = oldLines[i] === newLines[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const changes = [];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) { changes.push([' ', oldLines[i++]]); j++; }
    else if (j < newLines.length && (i === oldLines.length || rows[i][j + 1] >= rows[i + 1][j])) changes.push(['+', newLines[j++]]);
    else changes.push(['-', oldLines[i++]]);
  }
  const changed = changes.map((item, index) => item[0] !== ' ' ? index : -1).filter(index => index >= 0);
  const keep = new Set();
  for (const index of changed) for (let n = Math.max(0, index - 3); n <= Math.min(changes.length - 1, index + 3); n++) keep.add(n);
  let previous = -1;
  const lines = [];
  [...keep].sort((a,b) => a-b).forEach(index => {
    if (index > previous + 1) lines.push(['…','unchanged lines']);
    lines.push(changes[index]); previous = index;
  });
  return lines.map(([kind, line]) => `${kind} ${line}`).join('\n');
}

function addAiMessage(role, content, code = null, codePath = activePath, before = null) {
  const messages = byId('aiMessages');
  messages.querySelector('.ai-welcome')?.remove();
  const bubble = document.createElement('div');
  bubble.className = 'ai-message ' + role;
  bubble.textContent = content;
  if (role === 'assistant' && code !== null) {
    if (before !== null) {
      const summary = document.createElement('p');
      summary.textContent = `Complete replacement preview · ${codePath}`;
      bubble.appendChild(summary);
      const preview = document.createElement('pre');
      preview.className = 'ai-code';
      preview.textContent = code;
      bubble.appendChild(preview);
      const details = document.createElement('details');
      details.className = 'ai-review';
      const summaryDiff = document.createElement('summary');
      summaryDiff.textContent = 'Review line changes';
      const diff = document.createElement('pre');
      diff.className = 'ai-diff';
      diff.textContent = aiDiff(before, code);
      details.append(summaryDiff, diff);
      bubble.appendChild(details);
    } else {
      const fence = String.fromCharCode(96).repeat(3);
      const blocks = [...content.matchAll(new RegExp(fence + '[^\\n]*\\n([\\s\\S]*?)' + fence, 'g'))];
      for (const block of blocks) {
        const preview = document.createElement('pre');
        preview.className = 'ai-code';
        preview.textContent = block[1].replace(/\n$/, '');
        bubble.appendChild(preview);
      }
    }
    const apply = document.createElement('button');
    apply.className = 'btn primary ai-apply';
    apply.textContent = 'Review & apply to open file';
    apply.addEventListener('click', async () => {
      if (activePath !== codePath) {
        toast('Open ' + codePath + ' to apply this change');
        return;
      }
      if (before !== null && source() !== before) {
        toast('The open file changed after this suggestion. Ask Dream AI to review the current version again.');
        return;
      }
      if (before !== null) {
        try {
          if (await fetchText(codePath) !== before) {
            toast('The project file changed outside the editor after this suggestion. Reopen it and request a fresh edit.');
            return;
          }
        } catch (error) {
          toast('Could not verify the current project file before applying the AI edit: ' + error.message);
          return;
        }
        if (source() !== before) {
          toast('The open file changed during review. Ask Dream AI to review the current version again.');
          return;
        }
      }
      if (!window.confirm('Replace the complete contents of ' + activePath + ' with the reviewed AI edit?')) return;
      const prior = source();
      replaceEditorDocument(code, 'dream-ai');
      setView('code');
      editor.focus();
      if (!(await save())) {
        let persisted = null;
        try { persisted = await fetchText(codePath); } catch {}
        if (persisted === code) toast('The AI edit was saved, but the editor could not refresh the project list.');
        else if (persisted === prior && source() === code) {
          replaceEditorDocument(prior, 'dream-ai-save-rollback');
          toast('The project rejected the AI edit. The editor has been restored to the previous file content.');
        } else toast('The save result could not be confirmed. The proposed edit remains in the editor for review.');
      }
      else toast('Reviewed AI edit applied and saved.');
    });
    apply.textContent = before === null ? 'Review & apply to open file' : 'Apply reviewed file edit';
    if (before !== null) {
      const actions = document.createElement('div');
      actions.className = 'ai-review-actions';
      const dismiss = document.createElement('button');
      dismiss.className = 'btn'; dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => bubble.remove());
      actions.append(apply, dismiss);
      bubble.appendChild(actions);
    } else bubble.appendChild(apply);
  }
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

async function saveAiSettings() {
  const response = await fetch('/api/ai/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: byId('aiEndpoint').value, model: byId('aiModel').value, api_key: byId('aiKey').value })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not save the AI connection.');
  aiConfigured = true;
  byId('aiKey').value = '';
  updateAiStatus(result);
  return result;
}

async function testAiConnection() {
  const button = byId('aiTest');
  button.disabled = true;
  button.textContent = 'Testing…';
  try {
    await saveAiSettings();
    const response = await fetch('/api/ai/test', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Connection test failed.');
    toast('Connected to ' + result.model);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Test connection';
  }
}

async function sendAiMessage() {
  if (aiBusy) return;
  const prompt = byId('aiPrompt').value.trim();
  if (!prompt) { byId('aiPrompt').focus(); return; }
  if (!aiConfigured) { setAiSettingsOpen(true); toast('Connect an AI endpoint before sending a prompt'); return; }
  if (!(await save())) return;
  aiBusy = true;
  const controller = new AbortController();
  aiRequestController = controller;
  byId('aiSend').disabled = true;
  byId('aiSend').textContent = 'Thinking…';
  byId('aiCancel').disabled = false;
  byId('aiPrompt').value = '';
  const requestPath = activePath;
  const requestSource = source();
  const requestMode = aiMode;
  const contextPaths = [...byId('aiContextOptions').querySelectorAll('input:checked')].map(input => input.value).slice(0, 40);
  addAiMessage('user', prompt);
  const thinking = document.createElement('div');
  thinking.className = 'ai-message assistant';
  thinking.textContent = 'Dream AI is working…';
  byId('aiMessages').appendChild(thinking);
  byId('aiMessages').scrollTop = byId('aiMessages').scrollHeight;
  try {
    const response = await fetch('/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, path: requestPath, source: requestSource, mode: requestMode, context_paths: contextPaths, history: aiHistory.slice(-12) }),
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'AI request failed (' + response.status + ')');
    const content = result.content;
    if (requestMode === 'edit' && ['length', 'max_tokens'].includes(result.finish_reason)) {
      throw new Error('The AI provider truncated the file. Increase its output token limit or choose a model with a larger context window; no changes were applied.');
    }
    if (requestMode === 'chat') aiHistory.push({ role: 'user', content: prompt }, { role: 'assistant', content: content });
    thinking.remove();
    if (requestMode === 'edit') {
      let code = String(content).trim();
      const fence = String.fromCharCode(96).repeat(3);
      const wrapped = code.match(new RegExp('^' + fence + '[^\\n]*\\n([\\s\\S]*?)\\n' + fence + '\\s*$'));
      if (wrapped) code = wrapped[1];
      if (code === 'DREAMCRAFT_EDIT_UNAVAILABLE' || !code.trim() || code.length > 1_000_000) {
        addAiMessage('error', code === 'DREAMCRAFT_EDIT_UNAVAILABLE' ? 'Dream AI could not safely produce a complete file. No changes were applied.' : 'Dream AI returned an empty or oversized file. No changes were applied.');
      } else if (code.includes('DREAMCRAFT_EDIT_UNAVAILABLE') || /^(?:Here(?: is|'s)|I (?:updated|changed)|```|The complete file)/i.test(code)) {
        addAiMessage('error', 'Dream AI did not return only complete file contents. No changes were applied.');
      } else addAiMessage('assistant', 'Review the complete proposed file and its line changes before applying.', code, requestPath, requestSource);
    } else {
      const fence = String.fromCharCode(96).repeat(3);
      const fenced = new RegExp(fence + '[^\\n]*\\n([\\s\\S]*?)' + fence, 'g');
      const blocks = [...String(content).matchAll(fenced)];
      const code = blocks.length === 1 ? blocks[0][1].replace(/\n$/, '') : null;
      const clean = code === null ? content : String(content).replace(fenced, 'Complete file contents are available for review below.');
      addAiMessage('assistant', clean, code, requestPath, code === null ? null : requestSource);
    }
  } catch (error) {
    thinking.className = 'ai-message error';
    thinking.textContent = error.name === 'AbortError' ? 'Request cancelled. Your project file was not changed.' : error.message;
  } finally {
    aiBusy = false;
    aiRequestController = null;
    byId('aiCancel').disabled = true;
    byId('aiSend').disabled = false;
    byId('aiSend').textContent = 'Send message ↗';
  }
}

function cancelAiRequest() {
  if (aiRequestController) aiRequestController.abort();
}

function clearAiConversation() {
  cancelAiRequest();
  aiHistory = [];
  byId('aiMessages').innerHTML = '<div class="ai-welcome"><strong>Make your next idea real.</strong>Ask for design feedback, accessibility improvements, responsive layouts, or a complete code change. Dream AI includes your open file as context.</div>';
}

function updateInspector(data) {
  selectedNode = Number(data.id) || 0;
  byId('selectedElement').textContent = `${data.tag}${data.classes ? `.${String(data.classes).trim().split(/\s+/).join('.')}` : ''}`;
  byId('currentElement').textContent = data.tag.toUpperCase();
  byId('elementText').value = data.text || '';
  byId('textColor').value = colorHex(data.color);
  byId('elementColor').value = colorHex(data.background);
  byId('elementPadding').value = data.padding || 0;
  byId('elementMargin').value = data.margin || 0;
  byId('elementClasses').value = data.classes || '';
  byId('elementWidth').value = data.width || '';
  byId('elementHeight').value = data.height || '';
  byId('elementFontSize').value = data.fontSize || '';
  byId('elementFontFamily').value = data.fontFamily || '';
  byId('elementAlign').value = data.textAlign || '';
  byId('elementDisplay').value = data.display || '';
  byId('elementRadius').value = data.borderRadius || 0;
  cssTargetData = data;
  cssMatchedRules = [];
  cssWorkingRule = null;
  const suggested = data.elementId ? `#${data.elementId}` : data.classes ? `.${String(data.classes).trim().split(/\s+/).join('.')}` : data.tag || '';
  byId('cssTarget').textContent = `${data.tag}${data.elementId ? `#${data.elementId}` : ''}${data.classes ? `.${String(data.classes).trim().split(/\s+/).join('.')}` : ''}`;
  byId('cssSelector').value = cssMatchedRules[0]?.selector || suggested;
  renderCssMatches();
  byId('cssMatchList').innerHTML = '<div class="empty-selection">Inspecting linked stylesheets…</div>';
  cssDeclarations = []; byId('cssRuleContext').textContent = ''; renderCssDeclarations();
  discoverCssMatches(data);
  document.querySelectorAll('#layerTree .layer').forEach(layer => layer.classList.toggle('selected', layer.dataset.id === String(selectedNode)));
}

function colorHex(value) {
  if (!value || value === 'rgba(0, 0, 0, 0)') return '#ffffff';
  const m = value.match(/\d+/g);
  return m && m.length >= 3 ? `#${m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('')}` : '#ffffff';
}

function applyStyle(property, value) { frame.contentWindow?.postMessage({ type: 'dc-style', property, value }, '*'); }

let cssTargetData = null;
let cssMatchedRules = [];
let cssWorkingRule = null;
let cssDeclarations = [];
let cssFiles = [];
let cssEditingContext = '';

function findCssToken(text, from, end, token) {
  let quote = '', comment = false, parens = 0;
  for (let i = from; i < end; i++) {
    const c = text[i], n = text[i + 1];
    if (comment) { if (c === '*' && n === '/') { comment = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '*') { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') { parens++; continue; }
    if (c === ')' || c === ']') { parens = Math.max(0, parens - 1); continue; }
    if (!parens && c === token) return i;
  }
  return -1;
}

function findCssClose(text, open, end) {
  let depth = 1, quote = '', comment = false;
  for (let i = open + 1; i < end; i++) {
    const c = text[i], n = text[i + 1];
    if (comment) { if (c === '*' && n === '/') { comment = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && n === '*') { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

function scanCssRules(text, start = 0, end = text.length, context = []) {
  const found = [];
  let cursor = start;
  while (cursor < end) {
    const open = findCssToken(text, cursor, end, '{');
    const semi = findCssToken(text, cursor, end, ';');
    if (semi >= 0 && (open < 0 || semi < open)) { cursor = semi + 1; continue; }
    if (open < 0) break;
    const close = findCssClose(text, open, end);
    if (close < 0) break;
    const selector = text.slice(cursor, open).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (selector.startsWith('@')) {
      if (!/@(?:-[\w]+-)?keyframes\b/i.test(selector) && !/^@(font-face|page|property|counter-style)\b/i.test(selector))
        found.push(...scanCssRules(text, open + 1, close, context.concat(selector)));
    } else if (selector) found.push({ selector, context: context.join(' > '), open, close });
    cursor = close + 1;
  }
  return found;
}

function splitCssContext(context) {
  const parts = []; let start = 0, depth = 0, quote = '';
  for (let i = 0; i < context.length; i++) {
    const c = context[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (!depth && context.slice(i, i + 3) === ' > ') { parts.push(context.slice(start, i)); i += 2; start = i + 1; }
  }
  if (start < context.length) parts.push(context.slice(start));
  return parts;
}

function canonicalCssContext(context) {
  return splitCssContext(context).map(segment => {
    if (!/^@media\b/i.test(segment)) return segment.trim().replace(/\s+/g, ' ');
    try { const parsed = new CSSStyleSheet(); parsed.replaceSync(`${segment} {}`); return `@media ${parsed.cssRules[0].conditionText}`; }
    catch { return segment.trim().replace(/\s+/g, ' '); }
  }).join(' > ');
}

function findCssContextRange(text, wanted, start = 0, end = text.length, parent = []) {
  if (!wanted) return { open: -1, close: text.length };
  let cursor = start;
  while (cursor < end) {
    const open = findCssToken(text, cursor, end, '{');
    const semi = findCssToken(text, cursor, end, ';');
    if (semi >= 0 && (open < 0 || semi < open)) { cursor = semi + 1; continue; }
    if (open < 0) break;
    const close = findCssClose(text, open, end);
    if (close < 0) break;
    const selector = text.slice(cursor, open).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (selector.startsWith('@') && !/@(?:-[\w]+-)?keyframes\b/i.test(selector) && !/^@(font-face|page|property|counter-style)\b/i.test(selector)) {
      const chain = parent.concat(selector);
      if (chain.join(' > ') === wanted || canonicalCssContext(chain.join(' > ')) === canonicalCssContext(wanted)) return { open, close, selector };
      const nested = findCssContextRange(text, wanted, open + 1, close, chain);
      if (nested) return nested;
    }
    cursor = close + 1;
  }
  return null;
}

function scanCssContexts(text, start = 0, end = text.length, parent = [], found = []) {
  let cursor = start;
  while (cursor < end) {
    const open = findCssToken(text, cursor, end, '{');
    const semi = findCssToken(text, cursor, end, ';');
    if (semi >= 0 && (open < 0 || semi < open)) { cursor = semi + 1; continue; }
    if (open < 0) break;
    const close = findCssClose(text, open, end);
    if (close < 0) break;
    const selector = text.slice(cursor, open).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
    if (selector.startsWith('@') && !/@(?:-[\w]+-)?keyframes\b/i.test(selector) && !/^@(font-face|page|property|counter-style)\b/i.test(selector)) {
      const chain = parent.concat(selector);
      found.push(chain.join(' > '));
      scanCssContexts(text, open + 1, close, chain, found);
    }
    cursor = close + 1;
  }
  return found;
}

async function renderCssContexts(preferred = cssEditingContext) {
  const select = byId('cssRuleContextSelect');
  if (!select) return;
  const path = byId('cssStylesheet').value;
  let text = '';
  try { if (path) text = path === activePath ? source() : await fetchText(path); } catch (error) { showCssMessage(error.message, true); }
  const contexts = text ? [...new Set(scanCssContexts(text))] : [];
  if (preferred && findCssContextRange(text, preferred) && !contexts.some(context => canonicalCssContext(context) === canonicalCssContext(preferred))) contexts.push(preferred);
  select.replaceChildren();
  const rootOption = document.createElement('option'); rootOption.value = ''; rootOption.textContent = 'Stylesheet root'; select.appendChild(rootOption);
  contexts.forEach(context => { const option = document.createElement('option'); option.value = context; option.textContent = context; select.appendChild(option); });
  select.value = contexts.find(context => canonicalCssContext(context) === canonicalCssContext(preferred)) || '';
  cssEditingContext = select.value;
}

function installCssContextControls() {
  if (byId('cssRuleContextSelect')) return;
  const createSource = document.createElement('button');
  createSource.id = 'cssCreateSource'; createSource.className = 'btn css-create-source'; createSource.type = 'button'; createSource.textContent = '＋ Create and attach stylesheet';
  createSource.addEventListener('click', openCreateCssStylesheet);
  byId('cssStylesheet').insertAdjacentElement('afterend', createSource);
  const section = document.createElement('section');
  section.className = 'inspect-section';
  section.innerHTML = '<div class="section-title">Responsive rules</div><label class="prop-label" for="cssRuleContextSelect">Selector context</label><select class="input" id="cssRuleContextSelect" aria-label="CSS selector context"></select><label class="prop-label" for="cssMediaQuery">Create media query</label><div class="css-add-row"><input class="input" id="cssMediaQuery" aria-label="CSS media query" autocomplete="off" placeholder="(max-width: 700px)"><button class="btn" id="cssCreateMedia" type="button" title="Create media query">＋</button></div>';
  byId('cssDesignerPane').insertBefore(section, byId('cssDeclarations').closest('.inspect-section'));
  byId('cssRuleContextSelect').addEventListener('change', () => {
    cssEditingContext = byId('cssRuleContextSelect').value;
    cssWorkingRule = null; cssDeclarations = [];
    byId('cssRuleContext').textContent = cssEditingContext || 'stylesheet';
    renderCssDeclarations(); renderCssMatches();
  });
  byId('cssCreateMedia').addEventListener('click', createCssMediaQuery);
  byId('cssMediaQuery').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); createCssMediaQuery(); } });
}

async function openCreateCssStylesheet() {
  try {
    const entries = await (await fetch('/api/files')).json();
    const taken = new Set(entries.map(item => item.path.toLowerCase()));
    let path = 'styles.css', suffix = 2;
    while (taken.has(path.toLowerCase())) path = `styles-${suffix++}.css`;
    showModal({
      title: 'Create and attach stylesheet',
      description: 'Create a project CSS file and link it from the open HTML page. Enter a project-relative .css path.',
      value: path,
      confirmLabel: 'Create stylesheet',
      action: createCssStylesheet
    });
  } catch (error) { showCssMessage(error.message || 'Could not inspect project files.', true); }
}

function stylesheetLinkDocument(html, pagePath, stylesheetPath) {
  const href = encodeProjectPath(relativeProjectPath(pagePath, stylesheetPath));
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]);
  const alreadyLinked = links.some(tag => {
    const rel = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const target = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return rel?.slice(1).filter(Boolean).join('').toLowerCase().split(/\s+/).includes('stylesheet') && target?.slice(1).filter(Boolean).some(value => resolveProjectHref(pagePath, value) === stylesheetPath);
  });
  if (alreadyLinked) return html;
  const link = `  <link rel="stylesheet" href="${escapeHtml(href)}">`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, match => `${match}\n${link}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, match => `${match}\n<head>\n${link}\n</head>`);
  return `${link}\n${html}`;
}

async function createCssStylesheet() {
  const path = byId('newFileName').value.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (!path || !/\.css$/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    toast('Enter a valid project-relative CSS path.'); return;
  }
  let createdPath = false, pagePath = '', originalPage = '';
  try {
    const entries = await (await fetch('/api/files')).json();
    if (entries.some(item => item.path.toLowerCase() === path.toLowerCase())) { toast('That project path already exists.'); return; }
    if (!(await save())) return;
    const pages = entries.filter(item => item.kind === 'file' && /\.html?$/i.test(item.path));
    pagePath = ['html', 'htm'].includes(extension(activePath)) ? activePath
      : pages.some(item => item.path === previewBasePath) ? previewBasePath
        : pages.find(item => item.path.toLowerCase() === 'index.html')?.path || pages[0]?.path || '';
    originalPage = pagePath ? (pagePath === activePath ? source() : await fetchText(pagePath)) : '';
    const created = await fetch(apiPath(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '' }) });
    if (!created.ok) throw new Error('Could not create the stylesheet.');
    createdPath = true;
    if (pagePath) {
      if (pagePath !== activePath) await openFile(pagePath);
      if (activePath !== pagePath) throw new Error('The stylesheet exists, but the HTML page could not be opened for attachment.');
      const updatedPage = stylesheetLinkDocument(originalPage, pagePath, path);
      if (updatedPage !== originalPage) {
        replaceEditorDocument(updatedPage, 'css-create-attach');
        if (!(await save())) throw new Error('The stylesheet exists, but its page link could not be saved.');
      }
    }
    hideModal();
    cssWorkingRule = null; cssDeclarations = []; cssEditingContext = '';
    await loadTree(); await refreshCssFiles(path);
    if (pagePath) toast(`Created ${path} and attached it to ${pagePath}.`);
    else toast(`Created ${path}. Open an HTML page to attach it.`);
  } catch (error) {
    let safeToRemoveStylesheet = !(pagePath && activePath === pagePath && originalPage && source() !== originalPage);
    if (createdPath && pagePath && activePath === pagePath && originalPage && source() !== originalPage) {
      replaceEditorDocument(originalPage, 'css-create-rollback');
      safeToRemoveStylesheet = await save();
    }
    if (createdPath && safeToRemoveStylesheet) await fetch(apiPath(path), { method: 'DELETE' }).catch(() => {});
    showCssMessage(error.message || 'Could not create the stylesheet.', true); toast(error.message || 'Could not create the stylesheet.');
  }
}

async function createCssMediaQuery() {
  const path = byId('cssStylesheet').value;
  const query = byId('cssMediaQuery').value.trim();
  if (!path || !cssFiles.includes(path)) return showCssMessage('Choose a project stylesheet first.', true);
  const generatedBy = preprocessorSourceForOutput(path);
  if (generatedBy) {
    showCssMessage(`${path} is generated. Edit ${generatedBy.path}, then compile it again.`, true);
    await openFile(generatedBy.path); setView('code'); return;
  }
  if (!query || /[{};\n\r]/.test(query)) return showCssMessage('Enter a media condition such as (max-width: 700px).', true);
  try {
    const parsed = new CSSStyleSheet();
    parsed.replaceSync(`@media ${query} {}`);
    if (parsed.cssRules.length !== 1 || parsed.cssRules[0].type !== CSSRule.MEDIA_RULE) throw new Error('Enter a valid CSS media query.');
    if (activePath !== path) await openFile(path);
    if (activePath !== path) throw new Error('Could not open the selected stylesheet.');
    const text = source(), atRule = parsed.cssRules[0].conditionText ? `@media ${parsed.cssRules[0].conditionText}` : `@media ${query}`;
    const found = findCssContextRange(text, atRule);
    if (!found) {
      const next = `${text.trimEnd()}\n\n${atRule} {\n}\n`;
      replaceEditorDocument(next, 'css-designer-media');
      if (!(await save())) throw new Error('The media query could not be saved.');
    }
    cssEditingContext = atRule;
    cssWorkingRule = null; cssDeclarations = [];
    byId('cssRuleContextSelect').value = atRule;
    byId('cssMediaQuery').value = '';
    byId('cssRuleContext').textContent = atRule;
    renderCssDeclarations(); await renderCssContexts(atRule);
    showCssMessage(found ? `Selected ${atRule}.` : `Created ${atRule} in ${path}.`);
  } catch (error) { showCssMessage(error.message || 'Could not create the media query.', true); }
}

function scanCssDeclarations(text, start, end) {
  const rows = [];
  let segment = start;
  while (segment < end) {
    let semi = findCssToken(text, segment, end, ';');
    if (semi < 0) semi = end;
    const colon = findCssToken(text, segment, semi, ':');
    if (colon >= 0) {
      const rawProp = text.slice(segment, colon), rawValue = text.slice(colon + 1, semi);
      const prop = rawProp.trim(), value = rawValue.trim();
      if (prop && value) {
        const propStart = segment + rawProp.indexOf(prop);
        const valueStart = colon + 1 + rawValue.indexOf(value);
        rows.push({ property: prop, value, segmentStart: segment, segmentEnd: semi, propStart, propEnd: propStart + prop.length, valueStart, valueEnd: valueStart + value.length, terminated: semi < end, originalProperty: prop, originalValue: value });
      }
    }
    segment = semi + 1;
  }
  return rows;
}

function cssSpecificity(selector) {
  return Math.max(...selector.split(/,(?![^()]*\))/).map(part => {
    const normalized = part.replace(/\[[^\]]*\]/g, ' [attribute]').replace(/:where\([^)]*\)/g, ' ');
    const ids = (normalized.match(/#[\w-]+/g) || []).length;
    const classes = (normalized.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
    const types = (normalized.replace(/::[\w-]+/g, '').match(/(?:^|[\s>+~])(?:[a-zA-Z][\w-]*|\*)/g) || []).filter(item => item.trim() !== '*').length;
    return ids * 1000000 + classes * 1000 + types;
  }));
}

async function refreshCssFiles(preferred = '') {
  try {
    const entries = await (await fetch('/api/files')).json();
    cssFiles = entries.filter(item => item.kind === 'file' && item.path.toLowerCase().endsWith('.css')).map(item => item.path);
    const select = byId('cssStylesheet'), prior = preferred || select.value || (extension(activePath) === 'css' ? activePath : '');
    select.replaceChildren();
    if (!cssFiles.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = 'No CSS files in this project'; select.appendChild(option);
      select.disabled = true;
    } else {
      cssFiles.forEach(path => { const option = document.createElement('option'); option.value = path; option.textContent = path; select.appendChild(option); });
      select.disabled = false;
      select.value = cssFiles.includes(prior) ? prior : cssFiles.includes(activePath) ? activePath : cssFiles[0];
    }
    await renderCssContexts(cssEditingContext);
  } catch (error) { showCssMessage(error.message, true); }
}

async function discoverCssMatches(data) {
  const linkedPaths = [...new Set((data.cssPaths || []).filter(path => typeof path === 'string' && path.toLowerCase().endsWith('.css')))];
  if (!linkedPaths.length) return frame.contentWindow?.postMessage({ type: 'dc-match-css', id: String(data.id), rules: [] }, '*');
  const candidates = [];
  for (const path of linkedPaths) {
    try { const text = path === activePath ? source() : await fetchText(path); for (const rule of scanCssRules(text)) candidates.push({ path, selector: rule.selector, context: rule.context }); }
    catch (error) { showCssMessage(`Unable to inspect ${path}: ${error.message}`, true); }
    if (candidates.length >= 3000) break;
  }
  frame.contentWindow?.postMessage({ type: 'dc-match-css', id: String(data.id), rules: candidates.slice(0, 3000) }, '*');
}

function showCssMessage(message, error = false) {
  const node = byId('cssMessage'); node.textContent = message; node.classList.remove('hide');
  node.classList.toggle('error', error); node.classList.add('css-message');
}

function renderCssMatches() {
  const root = byId('cssMatchList'); root.replaceChildren();
  if (!cssTargetData) { root.innerHTML = '<div class="empty-selection">Select an element in the page to inspect its matching CSS rules.</div>'; return; }
  if (!cssMatchedRules.length) { root.innerHTML = '<div class="empty-selection">No linked stylesheet rules match this element. Choose a project stylesheet and create a selector rule below.</div>'; return; }
  if (!cssWorkingRule) cssWorkingRule = cssMatchedRules[0];
  cssMatchedRules.forEach((rule, index) => {
    const active = cssWorkingRule && cssWorkingRule.path === rule.path && cssWorkingRule.selector === rule.selector && (cssWorkingRule.context || '') === (rule.context || '');
    const button = document.createElement('button'); button.className = `css-match${active ? ' active' : ''}`; button.type = 'button';
    button.textContent = rule.selector;
    const detail = document.createElement('small'); detail.textContent = `${rule.path}${rule.context ? ` · ${rule.context}` : ''}`; button.appendChild(detail);
    button.onclick = async () => { cssWorkingRule = rule; cssEditingContext = rule.context || ''; byId('cssStylesheet').value = rule.path; byId('cssSelector').value = rule.selector; await renderCssContexts(cssEditingContext); await loadCssDeclarations(rule); renderCssMatches(); };
    root.appendChild(button);
  });
}

async function loadCssDeclarations(rule) {
  byId('cssMessage').classList.add('hide');
  try {
    const text = rule.path === activePath ? source() : await fetchText(rule.path);
    const match = scanCssRules(text).find(item => item.selector === rule.selector && item.context === (rule.context || ''));
    if (!match) throw new Error('The matched rule could not be located in the stylesheet source.');
    cssWorkingRule = { ...rule, open: match.open, close: match.close };
    cssDeclarations = scanCssDeclarations(text, match.open + 1, match.close).map(item => ({ ...item, dirty: false, removed: false }));
    byId('cssRuleContext').textContent = match.context || 'stylesheet';
    renderCssDeclarations();
  } catch (error) { cssDeclarations = []; renderCssDeclarations(); showCssMessage(error.message, true); }
}

function renderCssDeclarations() {
  const root = byId('cssDeclarations'); root.replaceChildren();
  cssDeclarations.forEach((declaration, index) => {
    if (declaration.removed) return;
    const row = document.createElement('div'); row.className = 'css-declaration';
    const property = document.createElement('input'); property.className = 'input'; property.value = declaration.property; property.setAttribute('aria-label', 'CSS property');
    const value = document.createElement('input'); value.className = 'input'; value.value = declaration.value; value.setAttribute('aria-label', `Value for ${declaration.property}`);
    property.oninput = () => { declaration.property = property.value; declaration.dirty = true; };
    value.oninput = () => { declaration.value = value.value; declaration.dirty = true; };
    const remove = document.createElement('button'); remove.className = 'css-remove'; remove.type = 'button'; remove.textContent = '×'; remove.title = `Remove ${declaration.property}`; remove.onclick = () => { declaration.removed = true; renderCssDeclarations(); };
    row.append(property, value, remove); root.appendChild(row);
  });
}

function addCssDeclaration() {
  const property = byId('cssNewProperty').value.trim(), value = byId('cssNewValue').value.trim();
  if (!/^--[\w-]+$|^-?[a-zA-Z][\w-]*$/.test(property)) return showCssMessage('Enter a valid CSS property name.', true);
  if (!value || /[;{}]/.test(value)) return showCssMessage('Enter a CSS value without rule delimiters.', true);
  const current = cssDeclarations.find(item => item.property.toLowerCase() === property.toLowerCase() && !item.removed);
  if (current) { current.value = value; current.dirty = true; }
  else cssDeclarations.push({ property, value, added: true, dirty: true, removed: false });
  byId('cssNewProperty').value = ''; byId('cssNewValue').value = ''; renderCssDeclarations();
}

async function saveCssRule() {
  const path = byId('cssStylesheet').value, selector = byId('cssSelector').value.trim();
  if (!path || !cssFiles.includes(path)) return showCssMessage('Create or select a project CSS file first.', true);
  const generatedBy = preprocessorSourceForOutput(path);
  if (generatedBy) {
    showCssMessage(`${path} is generated. Edit ${generatedBy.path}, then compile it again.`, true);
    await openFile(generatedBy.path); setView('code'); return;
  }
  if (!selector || /[{}\n\r;]/.test(selector)) return showCssMessage('Enter a valid CSS selector.', true);
  if (cssDeclarations.some(item => !item.removed && (!/^--[\w-]+$|^-?[a-zA-Z][\w-]*$/.test(item.property) || !item.value.trim() || /[;{}]/.test(item.value)))) return showCssMessage('Review property names and values before saving.', true);
  try {
    if (activePath !== path) await openFile(path);
    if (activePath !== path) throw new Error('Could not open the selected stylesheet.');
    let text = source();
    const target = cssWorkingRule && cssWorkingRule.path === path && cssWorkingRule.selector === selector ? cssWorkingRule : null;
    const parsedRules = scanCssRules(text);
    const context = target?.context || cssEditingContext;
    const block = parsedRules.find(item => item.selector === selector && item.context === context) || null;
    if (block) {
      const edits = [];
      const base = block.open + 1;
      cssDeclarations.forEach(item => {
        if (item.added) return;
        if (item.removed) edits.push({ start: item.segmentStart, end: item.segmentEnd + (item.terminated ? 1 : 0), text: '' });
        else if (item.dirty) {
          const next = text.slice(item.segmentStart, item.propStart) + item.property + text.slice(item.propEnd, item.valueStart) + item.value + text.slice(item.valueEnd, item.segmentEnd);
          edits.push({ start: item.segmentStart, end: item.segmentEnd, text: next });
        }
      });
      const additions = cssDeclarations.filter(item => item.added && !item.removed);
      if (additions.length) {
        const body = text.slice(base, block.close), newline = body.includes('\r\n') ? '\r\n' : '\n';
        const indent = (text.slice(0, block.open).match(/(?:^|\n)([ \t]*)[^\n]*$/) || [,''])[1] + '  ';
        const separator = body.trim() ? (body.endsWith('\n') || body.endsWith('\r') ? '' : newline) : newline;
        edits.push({ start: block.close, end: block.close, text: `${separator}${additions.map(item => `${indent}${item.property}: ${item.value};`).join(newline)}${newline}${indent.slice(0, -2)}` });
      }
      edits.sort((a,b) => b.start - a.start).forEach(edit => { text = text.slice(0, edit.start) + edit.text + text.slice(edit.end); });
    } else {
      const additions = cssDeclarations.filter(item => !item.removed);
      if (!additions.length) throw new Error('Add at least one CSS declaration before creating a selector.');
      const declarations = additions.map(item => `  ${item.property}: ${item.value};`).join('\n');
      if (!context) text = `${text.trimEnd()}\n\n${selector} {\n${declarations}\n}\n`;
      else {
        const container = findCssContextRange(text, context);
        if (!container) throw new Error('The selected responsive context no longer exists in this stylesheet.');
        const parentIndent = (text.slice(0, container.open).match(/(?:^|\n)([ \t]*)[^\n]*$/) || [,''])[1];
        const ruleIndent = `${parentIndent}  `, newline = text.includes('\r\n') ? '\r\n' : '\n';
        const body = text.slice(container.open + 1, container.close);
        const leading = body.trim() ? (/\r?\n$/.test(body) ? '' : newline) : (/\r?\n$/.test(body) ? '' : newline);
        const ruleText = `${ruleIndent}${selector} {${newline}${additions.map(item => `${ruleIndent}  ${item.property}: ${item.value};`).join(newline)}${newline}${ruleIndent}}`;
        text = `${text.slice(0, container.close)}${leading}${ruleText}${newline}${parentIndent}${text.slice(container.close)}`;
      }
    }
    if (source() !== text) replaceEditorDocument(text, 'css-designer');
    if (!(await save())) throw new Error('The stylesheet could not be saved.');
    cssWorkingRule = { path, selector, context: block?.context || target?.context || cssEditingContext || '' };
    cssEditingContext = cssWorkingRule.context;
    await renderCssContexts(cssEditingContext);
    cssDeclarations = [];
    await loadCssDeclarations(cssWorkingRule);
    showCssMessage(`Saved ${selector} in ${path}.`);
  } catch (error) { showCssMessage(error.message, true); }
}

function buildLayers(items) {
  const root = byId('layerTree');
  root.replaceChildren();
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = `layer ${String(selectedNode) === item.id ? 'selected' : ''}`;
    row.dataset.id = item.id;
    row.style.paddingLeft = `${7 + Math.min(item.depth, 5) * 9}px`;
    const desc = item.text ? `${item.tag} · ${item.text}` : item.tag;
    row.textContent = desc.slice(0, 42);
    row.title = `${item.tag}${item.text ? `: ${item.text}` : ''}`;
    row.onclick = () => frame.contentWindow?.postMessage({ type: 'dc-select-id', id: item.id }, '*');
    root.appendChild(row);
  });
}

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || !event.data) return;
  if (event.data.type === 'dc-select') updateInspector(event.data);
  if (event.data.type === 'dc-css-matches' && String(event.data.id) === String(selectedNode)) {
    cssMatchedRules = Array.isArray(event.data.rules) ? event.data.rules.sort((a, b) => cssSpecificity(b.selector) - cssSpecificity(a.selector)) : [];
    cssWorkingRule = cssMatchedRules[0] || null;
    renderCssMatches();
    if (cssWorkingRule) {
      byId('cssStylesheet').value = cssWorkingRule.path;
      byId('cssSelector').value = cssWorkingRule.selector;
      loadCssDeclarations(cssWorkingRule);
    } else { cssDeclarations = []; byId('cssRuleContext').textContent = ''; renderCssDeclarations(); }
  }
  if (event.data.type === 'dc-layers') buildLayers(event.data.items);
  if (event.data.type === 'dc-html' && activeView !== 'code' && isVisualDocument()) {
    replaceEditorDocument(event.data.html, 'design');
  }
});

frame.addEventListener('load', () => {
  selectedNode = 0;
  byId('selectedElement').textContent = 'Page body';
  byId('currentElement').textContent = 'Document';
  frame.contentWindow?.postMessage({ type: 'dc-mode', design: activeView !== 'code' && isVisualDocument() }, '*');
});

byId('designMode').onclick = () => setView('design');
byId('splitMode').onclick = () => setView('split');
byId('codeMode').onclick = () => setView('code');
document.querySelectorAll('[data-inspector]').forEach(button => button.addEventListener('click', async () => {
  document.querySelectorAll('[data-inspector]').forEach(tab => tab.classList.toggle('on', tab === button));
  document.querySelectorAll('#propertiesPane,#cssDesignerPane').forEach(pane => pane.classList.toggle('hide', pane.id !== button.dataset.inspector));
  if (button.dataset.inspector === 'cssDesignerPane') await refreshCssFiles(cssMatchedRules[0]?.path || (extension(activePath) === 'css' ? activePath : ''));
}));
installCssContextControls();
byId('cssStylesheet').addEventListener('change', async () => {
  const path = byId('cssStylesheet').value;
  cssEditingContext = '';
  cssWorkingRule = null; cssDeclarations = [];
  const matching = cssMatchedRules.find(rule => rule.path === path && rule.selector === byId('cssSelector').value.trim());
  if (matching) cssWorkingRule = matching;
  await renderCssContexts(matching?.context || '');
  byId('cssRuleContext').textContent = matching?.context || '';
  renderCssDeclarations();
  if (matching) await loadCssDeclarations(matching);
});
byId('cssAddDeclaration').addEventListener('click', addCssDeclaration);
byId('cssNewValue').addEventListener('keydown', event => { if (event.key === 'Enter') addCssDeclaration(); });
byId('cssSaveRule').addEventListener('click', saveCssRule);
byId('railDesign').onclick = () => setView('design');
byId('elementsBtn').onclick = () => insertMarkup('section');
document.querySelectorAll('[data-insert]').forEach(button => button.addEventListener('click', () => insertMarkup(button.dataset.insert)));
function setPreviewDevice(device, persist = true) {
  if (!['desktop', 'tablet', 'mobile'].includes(device)) device = 'desktop';
  document.querySelectorAll('[data-device]').forEach(item => {
    const selected = item.dataset.device === device;
    item.classList.toggle('on', selected);
    item.setAttribute('aria-pressed', String(selected));
  });
  frameBox.classList.remove('tablet', 'mobile');
  frameBox.style.width = '';
  frameBox.style.maxWidth = '';
  frameBox.style.height = '';
  frameBox.style.transform = '';
  frameBox.style.flex = '';
  if (device !== 'desktop') frameBox.classList.add(device);
  byId('mqViewport').value = device === 'mobile' ? '390' : device === 'tablet' ? '768' : String(Math.min(1600, Math.max(320, canvas.clientWidth - 44)));
  byId('mqViewportLabel').textContent = `${byId('mqViewport').value} px`;
  if (persist) {
    try { localStorage.setItem('dreamcraft.preview.device', device); } catch {}
  }
}
document.querySelectorAll('[data-device]').forEach(button => button.addEventListener('click', () => setPreviewDevice(button.dataset.device)));
try {
  const savedPreviewDevice = localStorage.getItem('dreamcraft.preview.device') || 'desktop';
  if (savedPreviewDevice === 'custom') setResponsiveViewport(Number(localStorage.getItem('dreamcraft.preview.width')) || 1000);
  else setPreviewDevice(savedPreviewDevice, false);
} catch { setPreviewDevice('desktop', false); }

let visualMediaQueryRefreshTimer = 0;
let visualMediaQueries = [];
let visualMediaQueryDrag = null;

function scheduleVisualMediaQueryRefresh(delay = 250) {
  clearTimeout(visualMediaQueryRefreshTimer);
  visualMediaQueryRefreshTimer = setTimeout(refreshVisualMediaQueries, delay);
}

function mediaQueryWidthBounds(condition) {
  const min = condition.match(/\(\s*min-width\s*:\s*([\d.]+)px\s*\)/i);
  const max = condition.match(/\(\s*max-width\s*:\s*([\d.]+)px\s*\)/i);
  return { min: min ? Number(min[1]) : null, max: max ? Number(max[1]) : null };
}

async function linkedStylesheetPaths() {
  const htmlPath = ['html', 'htm'].includes(extension(activePath)) ? activePath : previewBasePath;
  if (!htmlPath) return [];
  const html = htmlPath === activePath ? source() : await fetchText(htmlPath);
  const documentPage = new DOMParser().parseFromString(html, 'text/html');
  return [...new Set([...documentPage.querySelectorAll('link[rel~="stylesheet"][href]')]
    .map(link => resolveProjectHref(htmlPath, link.getAttribute('href')))
    .filter(path => path && path.toLowerCase().endsWith('.css')))];
}

async function refreshVisualMediaQueries() {
  const status = byId('mqStatus'), track = byId('mqTrack');
  if (!status || !track) return;
  const paths = extension(activePath) === 'css' ? [activePath] : await linkedStylesheetPaths().catch(() => []);
  const found = [], seen = new Set();
  for (const path of paths) {
    let text;
    try { text = path === activePath ? source() : await fetchText(path); }
    catch { continue; }
    for (const context of scanCssContexts(text)) {
      const media = splitCssContext(context).find(segment => /^@media\b/i.test(segment));
      if (!media) continue;
      const key = `${path}\u0000${canonicalCssContext(media)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const range = findCssContextRange(text, context);
      if (!range) continue;
      const headerStart = text.lastIndexOf('@media', range.open);
      if (headerStart < 0) continue;
      const header = text.slice(headerStart, range.open).trimEnd();
      const selector = header.slice(header.indexOf('@media') + 6).trim();
      const bounds = mediaQueryWidthBounds(selector);
      const widthQuery = bounds.min !== null || bounds.max !== null;
      found.push({ path, context, selector, header, headerStart, headerEnd: headerStart + header.length, bounds, text, widthQuery });
    }
  }
  visualMediaQueries = found;
  track.replaceChildren();
  const width = Number(byId('mqViewport').value) || 1000;
  for (const [index, query] of found.entries()) {
    const min = Math.max(320, Math.min(1600, query.bounds.min ?? 320));
    const max = Math.max(320, Math.min(1600, query.bounds.max ?? 1600));
    const left = ((Math.min(min, max) - 320) / 1280) * 100;
    const right = ((Math.max(min, max) - 320) / 1280) * 100;
    const band = document.createElement('button');
    band.type = 'button'; band.className = `mq-band ${query.bounds.min !== null && query.bounds.max !== null ? 'range' : query.bounds.min !== null ? 'min' : query.bounds.max !== null ? 'max' : 'other'}`;
    band.style.left = `${left}%`; band.style.width = `${Math.max(0.5, right - left)}%`; band.style.top = `${(index % 3) * 4}px`;
    band.title = `${query.path} · ${query.selector} · double-click to edit CSS`;
    band.setAttribute('aria-label', `${query.selector} in ${query.path}`);
    band.addEventListener('click', () => {
      const target = query.bounds.min !== null && query.bounds.max !== null ? Math.round((query.bounds.min + query.bounds.max) / 2)
        : query.bounds.max !== null ? Math.max(320, query.bounds.max - 1) : query.bounds.min !== null ? query.bounds.min + 1 : width;
      setResponsiveViewport(target);
      status.textContent = `${query.path} · ${query.selector}`;
    });
    band.addEventListener('dblclick', async event => {
      event.preventDefault();
      await openFile(query.path); setView('code');
      const at = source().indexOf(query.header);
      if (at >= 0) { editor.setCursor(editor.posFromIndex(at)); editor.scrollIntoView(editor.getCursor(), 120); editor.focus(); }
    });
    band.addEventListener('pointerdown', event => beginMediaQueryResize(event, band, query));
    track.appendChild(band);
  }
  if (!found.length) {
    const empty = document.createElement('span'); empty.className = 'mq-empty'; empty.textContent = paths.length ? 'No @media rules in linked CSS' : 'Link a CSS stylesheet to inspect responsive breakpoints'; track.appendChild(empty);
    status.textContent = paths.length ? `${paths.length} linked stylesheet${paths.length === 1 ? '' : 's'} scanned` : 'No linked CSS found';
  } else status.textContent = `${found.length} media quer${found.length === 1 ? 'y' : 'ies'} · drag a breakpoint edge to resize it`;
}

function setResponsiveViewport(width) {
  width = Math.max(320, Math.min(1600, Math.round(width)));
  byId('mqViewport').value = String(width);
  byId('mqViewportLabel').textContent = `${width} px`;
  document.querySelectorAll('[data-device]').forEach(button => { button.classList.remove('on'); button.setAttribute('aria-pressed', 'false'); });
  const scale = Math.min(1, Math.max(0.1, (canvas.clientWidth - 44) / width));
  frameBox.classList.remove('tablet', 'mobile');
  frameBox.style.width = `${width}px`; frameBox.style.maxWidth = 'none'; frameBox.style.height = `${100 / scale}%`;
  frameBox.style.transform = `scale(${scale})`; frameBox.style.flex = '0 0 auto';
  try { localStorage.setItem('dreamcraft.preview.device', 'custom'); localStorage.setItem('dreamcraft.preview.width', String(width)); } catch {}
}

function beginMediaQueryResize(event, band, query) {
  if (!query.widthQuery || event.button !== 0) return;
  const rect = band.getBoundingClientRect();
  const hasMin = query.bounds.min !== null, hasMax = query.bounds.max !== null;
  const atMinEdge = event.clientX - rect.left <= 8, atMaxEdge = rect.right - event.clientX <= 8;
  if (hasMin && hasMax && !atMinEdge && !atMaxEdge || hasMin && !hasMax && !atMinEdge || hasMax && !hasMin && !atMaxEdge) return;
  const resizeMin = hasMin && (!hasMax || atMinEdge || !atMaxEdge && event.clientX - rect.left < rect.right - event.clientX);
  event.preventDefault(); event.stopPropagation();
  visualMediaQueryDrag = { band, query, resizeMin, ruler: byId('mqTrack').getBoundingClientRect() };
  band.setPointerCapture(event.pointerId);
  band.addEventListener('pointermove', moveMediaQueryResize);
  band.addEventListener('pointerup', endMediaQueryResize, { once: true });
  band.addEventListener('pointercancel', endMediaQueryResize, { once: true });
}

function moveMediaQueryResize(event) {
  if (!visualMediaQueryDrag) return;
  const { band, query, resizeMin, ruler } = visualMediaQueryDrag;
  const width = Math.max(320, Math.min(1600, Math.round(320 + (event.clientX - ruler.left) / ruler.width * 1280)));
  if (resizeMin && query.bounds.max !== null) width = Math.min(width, query.bounds.max - 1);
  if (!resizeMin && query.bounds.min !== null) width = Math.max(width, query.bounds.min + 1);
  byId('mqViewport').value = String(width);
  const bounds = { ...query.bounds, [resizeMin ? 'min' : 'max']: width };
  const left = ((Math.max(320, Math.min(1600, Math.min(bounds.min ?? 320, bounds.max ?? 1600)) - 320)) / 1280) * 100;
  const right = ((Math.max(320, Math.min(1600, Math.max(bounds.min ?? 320, bounds.max ?? 1600)) - 320)) / 1280) * 100;
  band.style.left = `${left}%`; band.style.width = `${Math.max(0.5, right - left)}%`;
  setResponsiveViewport(width);
}

async function endMediaQueryResize(event) {
  const drag = visualMediaQueryDrag;
  if (!drag) return;
  drag.band.removeEventListener('pointermove', moveMediaQueryResize);
  visualMediaQueryDrag = null;
  const width = Number(byId('mqViewport').value);
  try {
    if (drag.query.path === activePath && dirty && !(await save())) throw new Error('Save the active stylesheet before resizing a breakpoint.');
    const original = await fetchText(drag.query.path);
    if (original !== drag.query.text) throw new Error('The stylesheet changed during the resize; refresh the breakpoint ruler and retry.');
    const start = drag.query.headerStart;
    if (original.slice(start, start + drag.query.header.length) !== drag.query.header) throw new Error('Could not relocate this media query in its stylesheet.');
    const values = { ...drag.query.bounds, [drag.resizeMin ? 'min' : 'max']: width };
    let updatedHeader = drag.query.header;
    const widthPattern = /\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)/ig;
    const matches = [...updatedHeader.matchAll(widthPattern)];
    const target = drag.resizeMin ? matches.find(match => match[1].toLowerCase() === 'min') : matches.findLast(match => match[1].toLowerCase() === 'max');
    if (target) {
      const valueStart = target.index + target[0].indexOf(target[2]);
      updatedHeader = `${updatedHeader.slice(0, valueStart)}${width}${updatedHeader.slice(valueStart + target[2].length)}`;
    } else {
      const condition = values.min !== null ? `min-width: ${values.min}px` : `max-width: ${values.max}px`;
      updatedHeader = `${updatedHeader} and (${condition})`;
    }
    const valid = new CSSStyleSheet(); valid.replaceSync(`${updatedHeader} {}`);
    if (valid.cssRules.length !== 1 || valid.cssRules[0].type !== CSSRule.MEDIA_RULE) throw new Error('The resized media query is not valid CSS.');
    if (drag.query.path === activePath) {
      const from = editor.posFromIndex(start), to = editor.posFromIndex(start + drag.query.header.length);
      editor.replaceRange(updatedHeader, from, to, 'visual-media-query');
      if (!(await save())) throw new Error('The breakpoint could not be saved.');
    } else {
      const snapshotResponse = await fetch('/api/snapshots', { method: 'POST' }), snapshot = await snapshotResponse.json();
      if (!snapshotResponse.ok) throw new Error(snapshot.error || 'Could not create a recovery snapshot.');
      if (await fetchText(drag.query.path) !== original) throw new Error('The stylesheet changed before the breakpoint could be saved.');
      const response = await fetch(apiPath(drag.query.path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `${original.slice(0, start)}${updatedHeader}${original.slice(start + drag.query.header.length)}` }) });
      if (!response.ok) throw new Error(`Could not save the breakpoint. Recovery snapshot ${snapshot.id} is available.`);
      await loadTree();
    }
    byId('mqStatus').textContent = `Updated ${drag.query.path} · ${updatedHeader.slice(updatedHeader.indexOf('@media') + 6).trim()}`;
    scheduleVisualMediaQueryRefresh(30);
  } catch (error) { byId('mqStatus').textContent = error.message; scheduleVisualMediaQueryRefresh(30); }
}

byId('mqViewport').addEventListener('input', event => setResponsiveViewport(Number(event.target.value)));
byId('mqToggle').addEventListener('click', () => {
  const collapsed = byId('visualMediaQueries').classList.toggle('collapsed');
  byId('mqToggle').textContent = collapsed ? 'Show' : 'Hide';
  byId('mqToggle').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('dreamcraft.media-queries.collapsed', String(collapsed)); } catch {}
});
try {
  const collapsed = localStorage.getItem('dreamcraft.media-queries.collapsed') === 'true';
  byId('visualMediaQueries').classList.toggle('collapsed', collapsed);
  byId('mqToggle').textContent = collapsed ? 'Show' : 'Hide';
  byId('mqToggle').setAttribute('aria-expanded', String(!collapsed));
} catch {}
byId('mqAdd').addEventListener('click', async () => {
  document.querySelector('[data-inspector="cssDesignerPane"]').click();
  await refreshCssFiles(cssFiles[0] || '');
  byId('cssMediaQuery').value = '(max-width: 700px)';
  byId('cssMediaQuery').focus();
  toast('Enter or adjust the condition in CSS Designer, then create the media query.');
});
byId('bootstrapComponentsOpen').addEventListener('click', () => { byId('bootstrapComponentsModal').style.display = 'grid'; });
byId('bootstrapComponentsClose').addEventListener('click', () => { byId('bootstrapComponentsModal').style.display = 'none'; });
byId('bootstrapComponentsModal').addEventListener('click', event => { if (event.target === byId('bootstrapComponentsModal')) byId('bootstrapComponentsModal').style.display = 'none'; });
document.querySelectorAll('[data-bootstrap-component]').forEach(button => button.addEventListener('click', () => insertBootstrapComponent(button.dataset.bootstrapComponent)));
byId('refreshBtn').onclick = renderPreview;
byId('openPreview').onclick = () => publishSite(true);
byId('openExternalPreview').addEventListener('click', openExternalPreviewDialog);
byId('externalPreviewClose').addEventListener('click', () => { byId('externalPreviewModal').style.display = 'none'; });
byId('externalPreviewOpen').addEventListener('click', launchExternalPreview);
byId('externalPreviewModal').addEventListener('click', event => { if (event.target === byId('externalPreviewModal')) event.currentTarget.style.display = 'none'; });
byId('devicePreviewBtn').addEventListener('click', openDevicePreviewDialog);
byId('devicePreviewStart').addEventListener('click', startDevicePreview);
byId('devicePreviewStop').addEventListener('click', stopDevicePreview);
byId('devicePreviewCopy').addEventListener('click', copyDevicePreviewUrl);
byId('devicePreviewClose').addEventListener('click', () => { byId('devicePreviewModal').style.display = 'none'; });
byId('devicePreviewCloseTop').addEventListener('click', () => { byId('devicePreviewModal').style.display = 'none'; });
byId('devicePreviewModal').addEventListener('click', event => { if (event.target === byId('devicePreviewModal')) event.currentTarget.style.display = 'none'; });
byId('testingServerBtn').addEventListener('click', openTestingServerDialog);
byId('databaseBtn').addEventListener('click', openDatabaseDialog);
byId('databaseClose').addEventListener('click', () => { byId('databaseModal').style.display = 'none'; });
byId('databaseModal').addEventListener('click', event => { if (event.target === byId('databaseModal')) byId('databaseModal').style.display = 'none'; });
byId('databaseRefresh').addEventListener('click', () => refreshDatabases().catch(error => databaseMessage(error.message, true)));
byId('databaseSelect').addEventListener('change', loadDatabaseSchema);
byId('remoteDbEngine').addEventListener('change', () => { byId('remoteDbPort').value = byId('remoteDbEngine').value === 'postgres' ? '5432' : '3306'; });
byId('remoteDbConnect').addEventListener('click', connectRemoteDatabase);
byId('remoteDbDisconnect').addEventListener('click', disconnectRemoteDatabase);
byId('databaseCreate').addEventListener('click', createDatabase);
byId('databaseNewPath').addEventListener('keydown', event => { if (event.key === 'Enter') createDatabase(); });
byId('databaseRun').addEventListener('click', runDatabaseQuery);
byId('databaseGeneratePhp').addEventListener('click', generatePhpDataPage);
byId('databaseGenerateAuth').addEventListener('click', generatePhpAuthentication);
byId('databaseAuthFolder').addEventListener('input', () => { const folder = byId('databaseAuthFolder').value.trim().replaceAll('\\', '/').replace(/\/$/, '') || 'auth'; byId('databaseAuthLogout').value = `${folder}/logout.php`; });
byId('databaseSql').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') runDatabaseQuery(); });
byId('preprocessorBtn').addEventListener('click', openPreprocessorDialog);
byId('preprocessorClose').addEventListener('click', closePreprocessorDialog);
byId('preprocessorCloseTop').addEventListener('click', closePreprocessorDialog);
byId('preprocessorModal').addEventListener('click', event => { if (event.target === byId('preprocessorModal')) closePreprocessorDialog(); });
byId('preprocessorRefresh').addEventListener('click', () => refreshPreprocessorSources().then(() => preprocessorStatus('Source list refreshed.')).catch(error => preprocessorStatus(error.message, true)));
byId('preprocessorRun').addEventListener('click', () => runPreprocessorBuild());
byId('preprocessorWatch').addEventListener('change', event => {
  preprocessorWatchEnabled = event.target.checked;
  preprocessorFingerprint = '';
  try { localStorage.setItem('dreamcraft.preprocessor.watch', String(preprocessorWatchEnabled)); } catch {}
  if (preprocessorWatchEnabled) {
    preprocessorStatus('Watching Sass, Less, and imported CSS files.');
    pollPreprocessorWatch();
  } else preprocessorStatus('Automatic builds are paused. Compile all still builds source files on demand.');
});
byId('preprocessorStyle').addEventListener('change', event => {
  try { localStorage.setItem('dreamcraft.preprocessor.style', event.target.value); } catch {}
  preprocessorFingerprint = '';
  if (preprocessorWatchEnabled) pollPreprocessorWatch();
});
byId('testingServerClose').addEventListener('click', () => { byId('testingServerModal').style.display = 'none'; });
byId('testingServerModal').addEventListener('click', event => { if (event.target === byId('testingServerModal')) byId('testingServerModal').style.display = 'none'; });
byId('testingPreset').addEventListener('change', () => {
  const preset = testingPresets[byId('testingPreset').value];
  if (!preset) return;
  byId('testingCommand').value = preset.command;
  byId('testingArguments').value = preset.arguments.join('\n');
});
byId('testingServerSave').addEventListener('click', async () => {
  const button = byId('testingServerSave'); button.disabled = true;
  try { await saveTestingServerSettings(); testingServerMessage('Testing-server command saved for this website.'); }
  catch (error) { testingServerMessage(error.message, true); }
  finally { button.disabled = false; }
});
byId('testingServerStart').addEventListener('click', startTestingServerAndPreview);
byId('testingServerStop').addEventListener('click', stopTestingServer);
byId('publishBtn').onclick = openPublishDialog;
const snapshotButton = document.createElement('button');
snapshotButton.className = 'btn';
snapshotButton.textContent = 'Snapshots';
snapshotButton.addEventListener('click', () => {
  byId('publishModal').style.display = 'none';
  openSnapshotDialog();
});
byId('publishLocal').insertAdjacentElement('beforebegin', snapshotButton);
const webdavOpenRow = document.createElement('div');
webdavOpenRow.className = 'webdav-open';
const webdavOpenButton = document.createElement('button');
webdavOpenButton.className = 'btn';
webdavOpenButton.textContent = 'Configure WebDAV…';
webdavOpenButton.addEventListener('click', () => {
  byId('publishModal').style.display = 'none';
  openWebdavDialog();
});
webdavOpenRow.appendChild(webdavOpenButton);
byId('publishLocal').parentElement.insertAdjacentElement('afterend', webdavOpenRow);
const ftpOpenRow = document.createElement('div');
ftpOpenRow.className = 'webdav-open';
const ftpOpenButton = document.createElement('button');
ftpOpenButton.className = 'btn';
ftpOpenButton.textContent = 'Configure FTP / FTPS…';
ftpOpenButton.addEventListener('click', () => {
  byId('publishModal').style.display = 'none';
  openFtpDialog();
});
ftpOpenRow.appendChild(ftpOpenButton);
webdavOpenRow.insertAdjacentElement('afterend', ftpOpenRow);
byId('publishLocal').addEventListener('click', async () => {
  byId('publishLocal').disabled = true;
  try {
    if (await publishSite(false)) deployMessage(`Local snapshot created: ${lastPublishUrl}`);
  } catch (error) { deployMessage(error.message, true); }
  finally { byId('publishLocal').disabled = false; }
});
byId('publishClose').addEventListener('click', () => { byId('publishModal').style.display = 'none'; });
byId('publishModal').addEventListener('click', event => { if (event.target === byId('publishModal')) byId('publishModal').style.display = 'none'; });
byId('snapshotClose').addEventListener('click', () => { byId('snapshotModal').style.display = 'none'; });
byId('snapshotRefresh').addEventListener('click', loadSnapshots);
byId('snapshotModal').addEventListener('click', event => { if (event.target === byId('snapshotModal')) byId('snapshotModal').style.display = 'none'; });
byId('deploySave').addEventListener('click', async () => {
  const button = byId('deploySave');
  button.disabled = true;
  try { await saveDeploySettings(); deployMessage('SFTP connection saved in memory for this session.'); }
  catch (error) { deployMessage(error.message, true); }
  finally { button.disabled = false; }
});
byId('deployNow').addEventListener('click', deployProject);
byId('sftpCompare').addEventListener('click', compareSftpRemote);
for (const id of ['deployHost', 'deployUser', 'deployPath']) byId(id).addEventListener('input', invalidateSftpComparison);
for (const id of ['ftpHost', 'ftpPort', 'ftpUser', 'ftpPath']) byId(id).addEventListener('input', invalidateFtpComparison);
for (const id of ['webdavEndpoint', 'webdavUser', 'webdavPath']) byId(id).addEventListener('input', invalidateWebdavComparison);
byId('ftpSecurity').addEventListener('change', invalidateFtpComparison);
byId('sftpParent').addEventListener('click', () => {
  sftpRemoteDirectory = sftpRemoteDirectory.includes('/') ? sftpRemoteDirectory.slice(0, sftpRemoteDirectory.lastIndexOf('/')) : '';
  loadSftpDirectory();
});
byId('sftpDownload').addEventListener('click', () => transferSftpSelection('download'));
byId('sftpUpload').addEventListener('click', () => transferSftpSelection('upload'));
byId('sftpRename').addEventListener('click', () => { const files = selectedSftpRemoteFiles(); if (files.length === 1) openRemoteManagement('sftp', 'rename', [files[0].path]); });
byId('sftpDelete').addEventListener('click', () => { const files = selectedSftpRemoteFiles(); if (files.length) openRemoteManagement('sftp', 'delete', files.map(entry => entry.path)); });
byId('ftpClose').addEventListener('click', () => { byId('ftpModal').style.display = 'none'; });
byId('ftpModal').addEventListener('click', event => { if (event.target === byId('ftpModal')) byId('ftpModal').style.display = 'none'; });
byId('ftpSecurity').addEventListener('change', () => {
  const secure = byId('ftpSecurity').value === 'ftps';
  byId('ftpWarning').textContent = secure
    ? 'FTPS encrypts your login, transfer data, and directory commands using certificate-verified TLS.'
    : 'Plain FTP sends your username, password, and project files without encryption. Use it only on a trusted network and server.';
  byId('ftpWarning').classList.toggle('secure', secure);
});
byId('ftpSave').addEventListener('click', async () => {
  const button = byId('ftpSave');
  button.disabled = true;
  try { await saveFtpSettings(); ftpMessage('FTP connection saved in memory for this session.'); }
  catch (error) { ftpMessage(error.message, true); }
  finally { button.disabled = false; }
});
byId('ftpTest').addEventListener('click', testFtpConnection);
byId('ftpPublish').addEventListener('click', publishFtp);
byId('ftpCompare').addEventListener('click', compareFtp);
byId('ftpDownload').addEventListener('click', () => syncFtp('download'));
byId('ftpUpload').addEventListener('click', () => syncFtp('upload'));
byId('ftpRename').addEventListener('click', () => { const paths = selectedFtpPathsForManagement(); if (paths.length === 1) openRemoteManagement('ftp', 'rename', paths); });
byId('ftpDelete').addEventListener('click', () => { const paths = selectedFtpPathsForManagement(); if (paths.length) openRemoteManagement('ftp', 'delete', paths); });
byId('webdavClose').addEventListener('click', () => { byId('webdavModal').style.display = 'none'; });
byId('webdavModal').addEventListener('click', event => { if (event.target === byId('webdavModal')) byId('webdavModal').style.display = 'none'; });
byId('webdavSave').addEventListener('click', async () => {
  const button = byId('webdavSave');
  button.disabled = true;
  try { await saveWebdavSettings(); webdavMessage('WebDAV connection saved in memory for this session.'); }
  catch (error) { webdavMessage(error.message, true); }
  finally { button.disabled = false; }
});
byId('webdavTest').addEventListener('click', testWebdav);
byId('webdavCompare').addEventListener('click', compareWebdav);
byId('webdavDownload').addEventListener('click', downloadWebdavSelection);
byId('webdavUpload').addEventListener('click', uploadWebdavSelection);
byId('webdavRename').addEventListener('click', () => { const paths = selectedWebdavPathsForManagement(); if (paths.length === 1) openRemoteManagement('webdav', 'rename', paths); });
byId('webdavDelete').addEventListener('click', () => { const paths = selectedWebdavPathsForManagement(); if (paths.length) openRemoteManagement('webdav', 'delete', paths); });
byId('remoteActionConfirm').addEventListener('click', executeRemoteManagement);
byId('remoteActionCancel').addEventListener('click', () => { byId('remoteActionModal').style.display = 'none'; remoteAction = null; });
byId('remoteActionModal').addEventListener('click', event => { if (event.target === byId('remoteActionModal')) { event.currentTarget.style.display = 'none'; remoteAction = null; } });
byId('remoteActionName').addEventListener('keydown', event => { if (event.key === 'Enter') executeRemoteManagement(); if (event.key === 'Escape') byId('remoteActionCancel').click(); });
byId('webdavPublish').addEventListener('click', publishWebdav);
byId('shareBtn').onclick = async () => {
  const link = lastPublishUrl || location.origin;
  try { await navigator.clipboard.writeText(link); toast(`Copied ${link}`); }
  catch { toast(`Local site address: ${link}`); }
};
byId('searchBtn').onclick = openSearch;
byId('closeSearch').onclick = () => byId('searchModal').style.display = 'none';
byId('searchInput').addEventListener('input', event => searchProject(event.target.value));
byId('commandInput').addEventListener('input', () => { commandSelection = 0; renderCommandResults(); });
byId('commandInput').addEventListener('keydown', event => {
  const rows = [...byId('commandResults').querySelectorAll('.command-item')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!rows.length) return;
    event.preventDefault(); commandSelection = (commandSelection + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((row, index) => { row.classList.toggle('active', index === commandSelection); row.setAttribute('aria-selected', String(index === commandSelection)); });
    if (rows[commandSelection]) { byId('commandInput').setAttribute('aria-activedescendant', rows[commandSelection].id); rows[commandSelection].scrollIntoView({ block: 'nearest' }); }
  } else if (event.key === 'Enter') { event.preventDefault(); rows[commandSelection]?.click(); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCommandPalette(); }
});
byId('commandBackdrop').addEventListener('click', event => { if (event.target === byId('commandBackdrop')) closeCommandPalette(); });
['searchCase', 'searchWords', 'searchRegex'].forEach(id => byId(id).addEventListener('change', () => searchProject(byId('searchInput').value)));
byId('replaceToggle').onclick = () => { byId('replacePanel').classList.toggle('hide'); byId('replaceInput').focus(); };
byId('replaceAll').onclick = replaceMatches;
byId('replaceApply').onclick = applyReplacements;
byId('newFileBtn').onclick = () => showModal({ title: 'New file', description: 'Create a file in the local website project.', value: 'pages/about.html', confirmLabel: 'Create file', action: createFile });
byId('newFolderBtn').onclick = () => showModal({ title: 'New folder', description: 'Create a folder inside the local website project.', value: 'assets/icons', confirmLabel: 'Create folder', action: createFolder });
byId('cancelModal').onclick = hideModal;
byId('confirmModal').onclick = () => modalAction?.();
byId('newFileName').addEventListener('keydown', event => { if (event.key === 'Enter') modalAction?.(); if (event.key === 'Escape') hideModal(); });
byId('uploadBtn').onclick = () => { insertUploadedImage = false; byId('assetInput').accept = ''; byId('assetInput').click(); };
byId('assetInput').addEventListener('change', event => {
  if (event.target.files.length) uploadAssets([...event.target.files]); else insertUploadedImage = false;
  event.target.value = ''; event.target.accept = '';
});
byId('assetsBtn').onclick = openAssetLibrary;
byId('assetLibraryClose').addEventListener('click', () => { byId('assetLibraryModal').style.display = 'none'; });
byId('assetLibraryDone').addEventListener('click', () => { byId('assetLibraryModal').style.display = 'none'; });
byId('assetLibraryModal').addEventListener('click', event => { if (event.target === byId('assetLibraryModal')) byId('assetLibraryModal').style.display = 'none'; });
byId('assetLibrarySearch').addEventListener('input', renderAssetLibrary);
byId('assetLibraryType').addEventListener('change', renderAssetLibrary);
byId('assetLibraryUpload').addEventListener('click', () => byId('uploadBtn').click());
byId('layersBtn')?.addEventListener('click', () => byId('layerTree').scrollIntoView({ behavior: 'smooth' }));
byId('settingsBtn').onclick = () => toast('Shortcuts: Ctrl+K quick open/commands · Ctrl+S save · Ctrl+Z undo · Ctrl+Y redo · Ctrl+Shift+F find · Shift+Alt+F format · F5 refresh · Ctrl+Space project-aware completion');
byId('checkPage').addEventListener('click', validateCurrentFile);
installLiveDiagnostics();
byId('formatPage').addEventListener('click', formatCurrentFile);
byId('validationClose').addEventListener('click', () => { byId('validationModal').style.display = 'none'; });
byId('validationModal').addEventListener('click', event => { if (event.target === byId('validationModal')) byId('validationModal').style.display = 'none'; });
byId('siteReportsBtn').addEventListener('click', openSiteReports);
byId('snippetsBtn').addEventListener('click', openSnippets);
byId('snippetClose').addEventListener('click', closeSnippets);
byId('snippetModal').addEventListener('click', event => { if (event.target === byId('snippetModal')) closeSnippets(); });
byId('snippetSearch').addEventListener('input', renderSnippetList);
byId('snippetNew').addEventListener('click', newSnippet);
byId('snippetSave').addEventListener('click', saveSnippet);
byId('snippetDelete').addEventListener('click', deleteSnippet);
byId('snippetDiscard').addEventListener('click', discardSnippetChanges);
byId('snippetInsert').addEventListener('click', () => selectedSnippetId && insertSnippet(selectedSnippetId));
byId('snippetExport').addEventListener('click', exportSnippets);
byId('snippetImport').addEventListener('click', () => {
  if (snippetEditorDirty) return snippetMessage('Save or discard the current changes before importing.', true);
  byId('snippetImportFile').click();
});
byId('snippetImportFile').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (file) await importSnippets(file);
  event.target.value = '';
});
for (const id of ['snippetName', 'snippetCategory', 'snippetTrigger', 'snippetDescription', 'snippetSyntax', 'snippetMode', 'snippetCode']) {
  byId(id).addEventListener('input', () => {
    snippetEditorDirty = true; byId('snippetDiscard').disabled = false;
    byId('snippetInsert').disabled = true; byId('snippetSave').textContent = 'Save snippet';
    snippetMessage('Unsaved snippet changes.');
  });
  byId(id).addEventListener('change', () => {
    snippetEditorDirty = true; byId('snippetDiscard').disabled = false;
    byId('snippetInsert').disabled = true; byId('snippetSave').textContent = 'Save snippet';
    snippetMessage('Unsaved snippet changes.');
  });
}
byId('siteReportsRun').addEventListener('click', runSiteReports);
byId('siteReportCancel').addEventListener('click', () => siteReportController?.abort());
byId('siteReportRuntime').addEventListener('change', event => { byId('siteReportBrowser').disabled = !event.target.checked; });
byId('siteReportBrowser').addEventListener('change', event => { try { localStorage.setItem('dreamcraft.runtime-test-browsers', JSON.stringify([...event.target.selectedOptions].map(option => option.value))); } catch {} });
byId('siteReportsClose').addEventListener('click', closeSiteReports);
byId('siteReportsModal').addEventListener('click', event => { if (event.target === byId('siteReportsModal')) closeSiteReports(); });
for (const name of ['chrome', 'edge', 'firefox', 'safari']) byId(`compat${name[0].toUpperCase()}${name.slice(1)}`).addEventListener('input', event => {
  try {
    const saved = JSON.parse(localStorage.getItem('dreamcraft.compat.targets') || '{}');
    const value = event.currentTarget.value.trim();
    if (value) saved[name] = value; else delete saved[name];
    localStorage.setItem('dreamcraft.compat.targets', JSON.stringify(saved));
  } catch {}
});
byId('aiBtn').addEventListener('click', openAi);
byId('aiClose').addEventListener('click', closeAi);
byId('aiSettingsToggle').addEventListener('click', () => setAiSettingsOpen(byId('aiSettings').classList.contains('hide')));
byId('aiSave').addEventListener('click', async () => {
  try { await saveAiSettings(); toast('AI connection saved for this session'); }
  catch (error) { toast(error.message); }
});
byId('aiTest').addEventListener('click', testAiConnection);
byId('aiSend').addEventListener('click', sendAiMessage);
byId('aiChatMode').addEventListener('click', () => setAiMode('chat'));
byId('aiEditMode').addEventListener('click', () => setAiMode('edit'));
byId('aiCancel').addEventListener('click', cancelAiRequest);
byId('aiClear').addEventListener('click', clearAiConversation);
byId('aiPrompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendAiMessage(); }
});
byId('aiBackdrop').addEventListener('click', event => { if (event.target === byId('aiBackdrop')) closeAi(); });
const templateButton = document.createElement('button');
templateButton.className = 'btn';
templateButton.id = 'templatesBtn';
templateButton.textContent = 'Starter pages';
templateButton.addEventListener('click', openTemplateDialog);
document.querySelector('.top-actions').prepend(templateButton);
const siteTemplateButton = document.createElement('button');
siteTemplateButton.className = 'btn';
siteTemplateButton.id = 'manageTemplatesBtn';
siteTemplateButton.textContent = 'Site templates';
siteTemplateButton.addEventListener('click', openTemplates);
document.querySelector('.top-actions').prepend(siteTemplateButton);
for (const [id, label, glyph, method] of [
  ['undoPage', 'Undo last edit', '↶', () => editor.undo()],
  ['redoPage', 'Redo last edit', '↷', () => editor.redo()]
]) {
  const button = document.createElement('button');
  button.className = 'btn history-button';
  button.id = id;
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.textContent = glyph;
  button.addEventListener('click', () => { method(); updateHistoryButtons(); });
  byId('formatPage').insertAdjacentElement('beforebegin', button);
}
updateHistoryButtons();
byId('templateChoice').addEventListener('change', updateTemplateDetails);
byId('templateCancel').addEventListener('click', () => { byId('templateModal').style.display = 'none'; });
byId('templateCreate').addEventListener('click', createTemplatePage);
byId('siteTemplatesClose').addEventListener('click', () => { byId('siteTemplatesModal').style.display = 'none'; });
byId('siteTemplatesModal').addEventListener('click', event => { if (event.target === byId('siteTemplatesModal')) byId('siteTemplatesModal').style.display = 'none'; });
byId('templateRefresh').addEventListener('click', loadTemplateDocuments);
byId('gitBtn').addEventListener('click', openGit);
byId('projectCard').addEventListener('click', openProjectManager);
byId('projectCard').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProjectManager(); } });
byId('projectClose').addEventListener('click', () => { byId('projectModal').style.display = 'none'; });
byId('projectModal').addEventListener('click', event => { if (event.target === byId('projectModal')) byId('projectModal').style.display = 'none'; });
byId('projectOpen').addEventListener('click', () => {
  const path = byId('projectOpenPath').value.trim();
  if (!path) return projectMessage('Enter the full path to an existing website folder.', true);
  switchProject('/api/projects/open', { path });
});
let folderPickerCurrent = '';
function closeFolderPicker() { byId('folderPickerModal').style.display = 'none'; }
function renderFolderPicker(data) {
  folderPickerCurrent = data.current || '';
  byId('folderPickerLocation').textContent = folderPickerCurrent || 'This computer';
  byId('folderPickerUp').disabled = !data.parent;
  byId('folderPickerSelect').disabled = !folderPickerCurrent;
  const list = byId('folderPickerList');
  list.replaceChildren();
  const folders = data.current ? data.folders : (data.roots || []).map(path => ({ name: path, path }));
  if (!folders.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-picker-empty';
    empty.textContent = data.current ? 'This folder contains no subfolders.' : 'No available drives were found.';
    list.append(empty);
  } else {
    for (const folder of folders) {
      const row = document.createElement('button');
      row.className = 'folder-picker-row';
      row.type = 'button';
      row.setAttribute('role', 'option');
      const icon = document.createElement('span');
      icon.className = 'folder-picker-row-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = data.current ? '▰' : '◉';
      const name = document.createElement('span');
      name.className = 'folder-picker-row-name';
      name.textContent = folder.name;
      row.append(icon, name);
      row.addEventListener('click', () => loadFolderPicker(folder.path));
      list.append(row);
    }
  }
  byId('folderPickerStatus').classList.remove('error');
  byId('folderPickerStatus').textContent = data.current ? `${folders.length} folders` : 'Select a drive to browse its folders.';
}
async function loadFolderPicker(path = '') {
  const status = byId('folderPickerStatus');
  status.classList.remove('error');
  status.textContent = 'Loading folders…';
  byId('folderPickerList').replaceChildren();
  try {
    const response = await fetch('/api/folders' + (path ? `?path=${encodeURIComponent(path)}` : ''));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Could not read this folder (${response.status}).`);
    renderFolderPicker(data);
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  }
}
function openFolderPicker() {
  byId('folderPickerModal').style.display = 'grid';
  const currentValue = byId('projectOpenPath').value.trim();
  loadFolderPicker(currentValue);
}
byId('projectBrowse').addEventListener('click', openFolderPicker);
byId('folderPickerClose').addEventListener('click', closeFolderPicker);
byId('folderPickerCancel').addEventListener('click', closeFolderPicker);
byId('folderPickerModal').addEventListener('click', event => { if (event.target === byId('folderPickerModal')) closeFolderPicker(); });
byId('folderPickerRoots').addEventListener('click', () => loadFolderPicker());
byId('folderPickerUp').addEventListener('click', async () => {
  if (!folderPickerCurrent) return;
  try {
    const response = await fetch(`/api/folders?path=${encodeURIComponent(folderPickerCurrent)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not read the current folder.');
    if (data.parent) await loadFolderPicker(data.parent); else await loadFolderPicker();
  } catch (error) {
    byId('folderPickerStatus').classList.add('error');
    byId('folderPickerStatus').textContent = error.message;
  }
});
byId('folderPickerSelect').addEventListener('click', () => {
  if (!folderPickerCurrent) return;
  byId('projectOpenPath').value = folderPickerCurrent;
  projectMessage(`Selected ${folderPickerCurrent}. Choose Open folder to load this website.`);
  closeFolderPicker();
  byId('projectOpenPath').focus();
});
byId('projectCreate').addEventListener('click', () => {
  const path = byId('projectCreatePath').value.trim();
  if (!path) return projectMessage('Enter where the new website folder should be created.', true);
  switchProject('/api/projects/create', { path, name: byId('projectCreateName').value.trim(), starter: byId('projectCreateStarter').value });
});
byId('projectOpenPath').addEventListener('keydown', event => { if (event.key === 'Enter') byId('projectOpen').click(); });
byId('projectCreatePath').addEventListener('keydown', event => { if (event.key === 'Enter') byId('projectCreate').click(); });
byId('gitClose').addEventListener('click', closeGit);
byId('gitBackdrop').addEventListener('click', event => { if (event.target === byId('gitBackdrop')) closeGit(); });
byId('gitRefresh').addEventListener('click', loadGitStatus);
byId('gitStageAll').addEventListener('click', async () => {
  try { await gitRequest('/api/git/stage', 'POST', {}); await loadGitStatus(); }
  catch (error) { gitMessage(error.message, true); }
});
byId('gitRemoteSave').addEventListener('click', async () => {
  const button = byId('gitRemoteSave');
  button.disabled = true;
  try {
    await gitRequest('/api/git/remote', 'POST', { url: byId('gitRemoteUrl').value });
    gitMessage('Origin remote saved.');
    await loadGitStatus();
  } catch (error) { gitMessage(error.message, true); }
  finally { button.disabled = false; }
});
byId('gitCommit').addEventListener('click', async () => {
  if (!byId('gitCommitMessage').value.trim()) return gitMessage('Enter a commit message.', true);
  try {
    await gitRequest('/api/git/commit', 'POST', { message: byId('gitCommitMessage').value });
    byId('gitCommitMessage').value = '';
    gitMessage('Commit created.');
    await loadGitStatus();
  } catch (error) { gitMessage(error.message, true); }
});
byId('clearSelection').onclick = () => { selectedNode = 0; frame.contentWindow?.postMessage({ type: 'dc-clear' }, '*'); byId('selectedElement').textContent = 'Page body'; };
applyTheme(document.documentElement.dataset.theme);
byId('themeToggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
byId('pageTitle').addEventListener('input', event => {
  const value = event.target.value.replaceAll('<', '').replaceAll('>', '');
  let html = source();
  if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)) html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${value}</title>`);
  else html = html.replace(/<head\b[^>]*>/i, match => `${match}<title>${value}</title>`);
  replaceEditorDocument(html, 'page-title');
});
byId('pageDescription').addEventListener('input', event => {
  const value = event.target.value.replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  let html = source();
  if (/<meta\s+name=["']description["'][^>]*>/i.test(html)) html = html.replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${value}">`);
  else html = html.replace(/<head\b[^>]*>/i, match => `${match}<meta name="description" content="${value}">`);
  replaceEditorDocument(html, 'page-description');
});
byId('elementText').addEventListener('input', event => frame.contentWindow?.postMessage({ type: 'dc-text', value: event.target.value }, '*'));
byId('textColor').addEventListener('input', event => applyStyle('color', event.target.value));
byId('elementColor').addEventListener('input', event => applyStyle('backgroundColor', event.target.value));
byId('elementPadding').addEventListener('input', event => applyStyle('padding', `${Math.max(0, Number(event.target.value) || 0)}px`));
byId('elementMargin').addEventListener('input', event => applyStyle('margin', `${Math.max(0, Number(event.target.value) || 0)}px`));
byId('elementClasses').addEventListener('change', event => frame.contentWindow?.postMessage({ type: 'dc-classes', value: event.target.value.trim() }, '*'));
byId('elementWidth').addEventListener('change', event => applyStyle('width', event.target.value.trim()));
byId('elementHeight').addEventListener('change', event => applyStyle('height', event.target.value.trim()));
byId('elementFontSize').addEventListener('input', event => applyStyle('fontSize', `${Math.max(1, Number(event.target.value) || 1)}px`));
byId('elementFontFamily').addEventListener('change', event => applyStyle('fontFamily', event.target.value.trim()));
byId('elementAlign').addEventListener('change', event => applyStyle('textAlign', event.target.value));
byId('elementDisplay').addEventListener('change', event => applyStyle('display', event.target.value));
byId('elementRadius').addEventListener('input', event => applyStyle('borderRadius', `${Math.max(0, Number(event.target.value) || 0)}px`));
byId('refreshBtn').addEventListener('dblclick', () => { frame.srcdoc = ''; renderPreview(); });
const nativeWindowControls = byId('nativeWindowControls');
const nativeWindowCommand = message => window.ipc?.postMessage(message);
if (window.ipc?.postMessage && nativeWindowControls) {
  nativeWindowControls.hidden = false;
  byId('windowMinimize').addEventListener('click', () => nativeWindowCommand('window:minimize'));
  byId('windowMaximize').addEventListener('click', () => {
    nativeWindowCommand('window:toggle-maximize');
    const button = byId('windowMaximize');
    const restore = button.getAttribute('aria-label') === 'Maximize';
    button.innerHTML = restore ? '<svg viewBox="0 0 16 16"><path d="M5.25 5.25h7.5v7.5h-7.5z"/><path d="M3.25 10.75v-7.5h7.5"/></svg>' : '<svg viewBox="0 0 16 16"><rect x="3.25" y="3.25" width="9.5" height="9.5" rx=".7"/></svg>';
    button.title = restore ? 'Restore' : 'Maximize';
    button.setAttribute('aria-label', restore ? 'Restore' : 'Maximize');
  });
  byId('windowClose').addEventListener('click', () => nativeWindowCommand('window:close'));
  byId('windowClose').addEventListener('pointerdown', event => event.stopPropagation());
  byId('windowMinimize').addEventListener('pointerdown', event => event.stopPropagation());
  byId('windowMaximize').addEventListener('pointerdown', event => event.stopPropagation());
  document.querySelector('.topbar').addEventListener('pointerdown', event => {
    if (event.button === 0 && !event.target.closest('button,a,input,select,textarea')) nativeWindowCommand('window:drag');
  });
  document.querySelector('.topbar').addEventListener('dblclick', event => {
    if (!event.target.closest('button,a,input,select,textarea')) nativeWindowCommand('window:toggle-maximize');
  });
  document.querySelectorAll('[data-window-resize]').forEach(edge => edge.addEventListener('pointerdown', event => {
    if (event.button === 0) nativeWindowCommand(`window:resize:${edge.dataset.windowResize}`);
  }));
}
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); return; }
  if (commandPaletteOpen) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); openSearch(); }
  if (event.key === 'F5') { event.preventDefault(); renderPreview(); }
  if (event.key === 'Escape' && byId('snippetModal').style.display === 'grid') { event.preventDefault(); closeSnippets(); return; }
  if (event.key === 'Escape') { byId('searchModal').style.display = 'none'; byId('projectModal').style.display = 'none'; byId('siteTemplatesModal').style.display = 'none'; byId('templateConfirmModal').style.display = 'none'; closePreprocessorDialog(); document.querySelector('.context-menu')?.remove(); closeAi(); closeGit(); closeSiteReports(); }
});

Promise.all([
  loadProjects().catch(error => projectMessage(error.message, true)),
  loadTree().then(() => openFile('index.html'))
]).then(() => { startPreprocessorWatch(); window.ipc?.postMessage('dreamcraft-ready'); });
refreshCssFiles();
refreshVisualMediaQueries();
