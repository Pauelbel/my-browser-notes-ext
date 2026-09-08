import {encode, safeName, matches, setting} from './storage.js';
import {CachedVault} from './cached-vault.js';
import {createEditor} from './vendor/editor.js';
import {parseTags} from './tags.js';
const $ = id => document.getElementById(id);
let vault, vaultId, notes = [], folders = [], current, filter = 'all', tag = '', dirty = false, timer, chain = Promise.resolve();
const clientId = crypto.randomUUID();
const selectedTrash = new Set();
let purgeSnapshot = [];
let folderTrashSnapshot = null;
let autoAccessAttempted = false;
const rich = createEditor($('body'), () => capture(true));
const draftKey = () => `quiet-draft:${vaultId}:${clientId}`;
const message = text => { $('message').textContent = text; $('message').hidden = !text; };
function status(text, state = '') {
  const label = text.replace(/^✓\s*/, '');
  $('status').hidden = state !== 'error'; $('status').dataset.state = state; $('status').title = label;
  $('statusText').textContent = label;
  $('statusMark').hidden = !state; $('statusMark').textContent = state === 'error' ? '!' : '…';
}
function report(error) { console.error(error); message(error.message || String(error)); status('Не сохранено на диск', 'error'); }
function run(fn) { return (...args) => { chain = chain.then(() => fn(...args)).catch(report); return chain; }; }
const locked = fn => navigator.locks.request('quiet-notes-files', fn);
function option(value, text) { const el = document.createElement('option'); el.value = value; el.textContent = text; return el; }
function draftKeys() { return Object.keys(localStorage).filter(k => k.startsWith(`quiet-draft:${vaultId}:`)); }
function recoveryState() { $('recover').hidden = !vault || !draftKeys().length; }
function capture(bodyChanged = false) {
  if (!current || filter === 'trash') return;
  current.title = $('title').value;
  if (bodyChanged) current.body = rich.getMarkdown();
  dirty = true;
  status('Сохранение…', 'pending');
  try { localStorage.setItem(draftKey(), JSON.stringify(current)); }
  catch { message('Не удалось сохранить аварийный черновик в браузере. Не закрывайте панель до сохранения на диск.'); }
  clearTimeout(timer); timer = setTimeout(run(save), 350);
  counts();
}
async function save() {
  clearTimeout(timer);
  if (!dirty || !current) return;
  const target = {...current}, text = encode(target);
  await locked(() => vault.write(target.path, text, target.raw));
  current.raw = text;
  const found = notes.find(n => n.path === target.path);
  if (found) Object.assign(found, target, {raw:text, modified:Date.now()});
  if (encode(current) === text) {
    dirty = false; localStorage.removeItem(draftKey()); syncStatus();
  } else { status('Сохранение…', 'pending'); clearTimeout(timer); timer = setTimeout(run(save), 0); }
  renderList(); recoveryState();
  if (dirty) await save();
}
function counts() {
  const text = rich.getText().trim();
  $('words').textContent = `${text ? text.split(/\s+/).length : 0} слов`;
  $('filename').textContent = current?.path || '';
}
function snippet(markdown) {
  return markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/^\s*(?:#{1,6}\s|>\s?|[-*+]\s(?:\[[ xX]\]\s)?|\d+\.\s)/gm,'')
    .replace(/[*_`~]/g,'').replace(/\s+/g,' ').trim().slice(0,90);
}
function syncStatus() {
  if (!vault) return;
  $('syncNotice').hidden = vault.connected && !vault.error;
  $('syncText').textContent = vault.error ? vault.error.message : 'Заметки доступны. Подключите папку для записи изменений в файлы.';
  $('syncAccess').textContent = vault.error ? 'Повторить запись' : 'Подключить папку';
  $('syncAccess').title = $('syncText').textContent;
  if (vault.pending) status('✓ В браузере · ожидает записи в папку', 'pending');
  else if (!vault.connected) status('Локальная копия · папка отключена', 'pending');
  else status('✓ Сохранено', '');
  $('trashSync').hidden = !vault.pending && !vault.error;
  $('trashSync').textContent = vault.error?.message || 'Изменения сохранены в браузере. Они применятся к файлам после подключения папки.';
}
function renderNoteTags() {
  $('noteTags').replaceChildren();
  for (const value of current?.tags || []) {
    const chip = document.createElement('button'); chip.textContent = value + ' ×'; chip.title = `Удалить тег «${value}»`; chip.setAttribute('aria-label', chip.title);
    chip.disabled = current.path.startsWith('.trash/');
    chip.onclick = () => { current.tags = current.tags.filter(t => t !== value); renderNoteTags(); capture(); };
    $('noteTags').append(chip);
  }
}
function commitTags() {
  if (!current || filter === 'trash') return;
  const values = parseTags($('tags').value);
  if (!values.length) return;
  current.tags = [...new Set([...current.tags,...values])]; $('tags').value = ''; renderNoteTags(); capture();
}
function renderList() {
  const inTrash = filter === 'trash';
  $('workspace').classList.toggle('trash-mode', inTrash);
  $('trashView').hidden = !inTrash;
  $('all').classList.toggle('active', !inTrash); $('trash').classList.toggle('active', inTrash);
  if (inTrash) { $('editor').hidden = true; renderTrash(); return; }
  const list = $('list'); list.replaceChildren();
  const visible = notes.filter(n => (n.path.startsWith('.trash/') === (filter === 'trash')) &&
    (!$('folderFilter').value || n.path.substring(0,n.path.lastIndexOf('/')) === $('folderFilter').value) &&
    (!tag || n.tags.includes(tag)) && matches(n, $('search').value)).sort((a,b) => b.modified - a.modified);
  for (const note of visible) {
    const button = document.createElement('button'); button.className = 'card' + (current?.path === note.path ? ' selected' : '');
    const title = document.createElement('strong'); title.textContent = note.title || 'Без названия';
    const description = document.createElement('small'); description.textContent = [note.tags.map(t => '#'+t).join(' '), snippet(note.body) || 'Пустая заметка'].filter(Boolean).join(' · ');
    button.append(title, description); button.onclick = run(async () => { await save(); select(note); }); list.append(button);
  }
  if (!visible.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = notes.length ? 'Здесь пока нет подходящих заметок' : 'Первая мысль начинается с «＋»'; list.append(p); }
  $('all').classList.toggle('active', filter === 'all'); $('trash').classList.toggle('active', filter === 'trash');
}
function visibleTrash() {
  return notes.filter(n => n.path.startsWith('.trash/') && matches(n,$('trashSearch').value)).sort((a,b) => b.modified-a.modified);
}
function trashSelectionStatus() {
  const visible = visibleTrash();
  $('selectAllTrash').checked = visible.length > 0 && visible.every(n => selectedTrash.has(n.path));
  $('selectAllTrash').indeterminate = selectedTrash.size > 0 && !$('selectAllTrash').checked;
  $('selectAllTrash').disabled = !visible.length;
  $('selectedTrashCount').textContent = selectedTrash.size ? `Выбрано: ${selectedTrash.size}` : '';
  $('restoreSelected').disabled = $('purgeSelected').disabled = !selectedTrash.size;
}
function renderTrash() {
  const all = notes.filter(n => n.path.startsWith('.trash/')), visible = visibleTrash();
  const visiblePaths = new Set(visible.map(n => n.path));
  for (const path of selectedTrash) if (!visiblePaths.has(path)) selectedTrash.delete(path);
  $('trashCount').textContent = `Заметок в корзине: ${all.length}`;
  $('trashList').replaceChildren();
  for (const note of visible) {
    const row = document.createElement('label'); row.className = 'trash-row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedTrash.has(note.path);
    checkbox.setAttribute('aria-label', `Выбрать заметку «${note.title || 'Без названия'}»`);
    row.classList.toggle('selected',checkbox.checked);
    checkbox.onchange = () => {
      if (checkbox.checked) selectedTrash.add(note.path); else selectedTrash.delete(note.path);
      row.classList.toggle('selected',checkbox.checked); trashSelectionStatus();
    };
    const content = document.createElement('span'); content.className = 'trash-row-content';
    const title = document.createElement('strong'); title.textContent = note.title || 'Без названия';
    const preview = document.createElement('span'); preview.className = 'trash-preview'; preview.textContent = snippet(note.body) || 'Пустая заметка';
    const origin = document.createElement('small'); origin.textContent = note.originalPath || 'Корневая папка';
    content.append(title,preview,origin); row.append(checkbox,content); $('trashList').append(row);
  }
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'trash-empty';
    const title = document.createElement('h2'); title.textContent = all.length ? 'Ничего не найдено' : 'Корзина пуста';
    const text = document.createElement('p'); text.textContent = all.length ? 'Попробуйте другой запрос.' : 'Здесь появятся удалённые заметки. Их можно восстановить или удалить навсегда.';
    empty.append(title,text); $('trashList').append(empty);
  }
  trashSelectionStatus();
}
function renderFilters() {
  const selected = $('folderFilter').value;
  $('folderFilter').replaceChildren(option('', 'Все папки'));
  for (const folder of folders.filter(Boolean)) $('folderFilter').append(option(folder, folder));
  if (folders.includes(selected)) $('folderFilter').value = selected;
  $('deleteFolder').disabled = !$('folderFilter').value;
  $('noteFolder').replaceChildren(...folders.map(f => option(f, f || 'Папка')));
  if (current) $('noteFolder').value = current.path.includes('/') ? current.path.slice(0,current.path.lastIndexOf('/')) : '';
  $('tagFilters').replaceChildren();
  const tags = [...new Set(notes.filter(n => !n.path.startsWith('.trash/')).flatMap(n => n.tags))].sort();
  for (const value of tags) {
    const button = document.createElement('button'); button.textContent = '#' + value; button.classList.toggle('active', tag === value);
    button.onclick = () => { tag = tag === value ? '' : value; renderFilters(); renderList(); }; $('tagFilters').append(button);
  }
}
function select(note) {
  current = {...note, tags:[...note.tags]}; dirty = false;
  $('editor').hidden = false; $('title').value = note.title; rich.setContent(note.body); $('tags').value = ''; renderNoteTags();
  localStorage.setItem(`quiet-selected:${vaultId}`, note.path);
  $('noteFolder').value = note.path.includes('/') ? note.path.slice(0,note.path.lastIndexOf('/')) : '';
  const trashed = note.path.startsWith('.trash/');
  for (const id of ['title','tags','noteFolder']) $(id).disabled = trashed;
  rich.setEditable(!trashed);
  document.querySelectorAll('.toolbar button').forEach(b => b.disabled = trashed);
  $('delete').hidden = trashed; $('restore').hidden = !trashed;
  syncStatus(); if (trashed) status('В корзине · можно восстановить'); counts(); renderList();
}
async function scan() {
  const result = await locked(() => vault.scan()); notes = result.notes; folders = result.folders;
  renderFilters(); renderList();
  if (current) {
    const found = notes.find(n => n.path === current.path);
    if (found) select(found); else { current = null; $('editor').hidden = true; }
  }
  recoveryState(); syncStatus();
}
async function activate(root, id) {
  autoAccessAttempted = false;
  selectedTrash.clear(); $('trashSearch').value = '';
  vault = new CachedVault(root, id); vaultId = id; current = null; dirty = false;
  $('editor').hidden = true; $('welcome').hidden = true; $('workspace').hidden = false;
  $('folderInfo').textContent = root.name;
  message('');
  const cached = await vault.cached(); notes = cached.notes; folders = cached.folders; renderFilters(); renderList();
  const lastPath = localStorage.getItem(`quiet-selected:${id}`);
  const initial = notes.find(n => n.path === lastPath && !n.path.startsWith('.trash/')) || notes.find(n => !n.path.startsWith('.trash/'));
  if (initial) select(initial);
  // Do not allow input while a disk refresh could replace the freshly shown cache.
  $('workspace').inert = true;
  try { await scan(); } finally { $('workspace').inert = false; }
  if (!current && notes.length) { const note = notes.find(n => !n.path.startsWith('.trash/')); if (note) select(note); }
  if (draftKeys().length) message('Есть несохранённый черновик. Его можно восстановить отдельной заметкой.');
}
// Call the picker directly in a click handler to preserve browser user activation.
async function choose() {
  if (dirty) { message('Сначала дождитесь сохранения текущей заметки или восстановите черновик.'); return; }
  try {
    const root = await window.showDirectoryPicker({id:'quiet-notes', mode:'readwrite'});
    const known = await setting('vaults') || [];
    let id;
    for (const item of known) if (await item.root.isSameEntry(root)) { id = item.id; break; }
    if (!id) { id = crypto.randomUUID(); known.push({root,id}); await setting('vaults', known); }
    await setting('vault', {root, id}); filter = 'all'; tag = ''; await activate(root, id); $('preferences').close();
  } catch (error) { if (error.name !== 'AbortError') report(error); }
}
$('choose').onclick = choose; $('changeFolder').onclick = choose;
$('settings').onclick = () => $('preferences').showModal();
$('placement').onclick = () => chrome.tabs.create({url:'chrome://settings/appearance'});
$('openTab').onclick = () => chrome.tabs.create({url:chrome.runtime.getURL('index.html')});
$('search').oninput = renderList;
$('folderFilter').onchange = () => { $('deleteFolder').disabled = !$('folderFilter').value; renderList(); };
$('refresh').onclick = run(async () => {
  // On conflict preserve the draft, then explicitly reload the external file.
  try { await save(); } catch (error) { message(error.message); dirty = false; }
  await scan();
});
for (const value of ['all','trash']) $(value).onclick = run(async () => {
  await save(); filter = value; tag = ''; selectedTrash.clear(); message(''); $('folderFilter').value = ''; current = null; $('editor').hidden = true; renderFilters(); renderList();
  if (value === 'all') {
    const last = localStorage.getItem(`quiet-selected:${vaultId}`);
    const note = notes.find(n => n.path === last && !n.path.startsWith('.trash/')) || notes.find(n => !n.path.startsWith('.trash/'));
    if (note) select(note);
  }
});
$('trashSearch').oninput = () => { selectedTrash.clear(); renderTrash(); };
$('selectAllTrash').onchange = () => {
  selectedTrash.clear(); if ($('selectAllTrash').checked) for (const note of visibleTrash()) selectedTrash.add(note.path);
  renderTrash();
};
async function applyTrashAction(action, snapshot) {
  if (!snapshot.length) return;
  $('workspace').inert = true;
  try {
    await locked(() => action === 'restore' ? vault.restoreTrash(snapshot) : vault.purgeTrash(snapshot));
    selectedTrash.clear(); await scan();
    message(vault.error ? vault.error.message : vault.pending
      ? `Обработано заметок: ${snapshot.length}. Изменения на диске ожидают подключения папки.`
      : `${action === 'restore' ? 'Восстановлено' : 'Удалено навсегда'} заметок: ${snapshot.length}.`);
  } finally { $('workspace').inert = false; }
}
$('restoreSelected').onclick = run(() => applyTrashAction('restore',notes.filter(n => selectedTrash.has(n.path))));
$('purgeSelected').onclick = () => {
  purgeSnapshot = notes.filter(n => selectedTrash.has(n.path)).map(n => ({...n}));
  if (!purgeSnapshot.length) return;
  $('purgeDescription').textContent = `Будет удалено заметок: ${purgeSnapshot.length}.`;
  $('purgeNames').replaceChildren(...purgeSnapshot.map(n => { const item = document.createElement('li'); item.textContent = n.title || 'Без названия'; return item; }));
  $('purgeDialog').showModal();
};
$('cancelPurge').onclick = () => { purgeSnapshot = []; $('purgeDialog').close(); };
$('confirmPurge').onclick = run(async () => {
  const snapshot = purgeSnapshot; purgeSnapshot = []; $('purgeDialog').close();
  await applyTrashAction('purge',snapshot);
});
$('new').onclick = run(async () => {
  await save(); filter = 'all'; tag = ''; $('search').value = '';
  const folder = $('folderFilter').value;
  const path = `${folder ? folder+'/' : ''}Заметка-${crypto.randomUUID()}.md`;
  const note = {path, title:'Без названия', tags:[], body:''};
  await locked(() => vault.write(path, encode(note))); await scan(); select(notes.find(n => n.path === path)); $('title').focus(); $('title').select();
});
$('addFolder').onclick = run(async () => {
  await save(); const name = prompt('Название новой папки:'); if (!name?.trim()) return;
  await locked(() => vault.directory(safeName(name), true)); await scan();
});
$('deleteFolder').onclick = run(async () => {
  const path = $('folderFilter').value;
  if (!path) return;
  await save(); await scan();
  if (!folders.includes(path)) throw Error('Папка больше не существует.');
  folderTrashSnapshot = {path, notes:notes.filter(n => n.path.startsWith(path + '/')).map(n => ({path:n.path,raw:n.raw})),
    folders:folders.filter(f => f === path || f.startsWith(path + '/'))};
  $('folderTrashDescription').textContent = `Папка «${path}». Заметок: ${folderTrashSnapshot.notes.length}. Вложенных папок: ${folderTrashSnapshot.folders.length-1}.`;
  $('folderTrashDialog').showModal();
});
$('cancelFolderTrash').onclick = () => { folderTrashSnapshot = null; $('folderTrashDialog').close(); };
$('confirmFolderTrash').onclick = run(async () => {
  const snapshot = folderTrashSnapshot; folderTrashSnapshot = null; $('folderTrashDialog').close();
  if (!snapshot) return;
  $('workspace').inert = true;
  try {
    const result = await locked(() => vault.trashFolder(snapshot.path,snapshot));
    if (current?.path.startsWith(snapshot.path + '/')) { current = null; $('editor').hidden = true; }
    $('folderFilter').value = ''; await scan();
    message(vault.error?.message || result.warning || (vault.pending
      ? `Папка «${snapshot.path}» удалена из списка. Заметок в корзине: ${result.count}. Изменения на диске ожидают подключения папки.`
      : `Папка «${snapshot.path}» удалена. Заметок перемещено в корзину: ${result.count}.`));
  } finally { $('workspace').inert = false; }
});
$('title').addEventListener('input', () => capture());
$('tags').addEventListener('keydown', event => {
  if (!event.isComposing && ['Enter',' ',','].includes(event.key)) { event.preventDefault(); commitTags(); }
});
$('tags').addEventListener('input', event => {
  if (!event.isComposing && /[\s,]/u.test($('tags').value)) commitTags();
});
$('tags').addEventListener('blur', () => { commitTags(); run(async () => { await save(); renderFilters(); })(); });
$('noteFolder').onchange = run(async () => {
  const folder = $('noteFolder').value; await save();
  const destination = (folder ? folder+'/' : '') + current.path.split('/').pop();
  if (destination === current.path) return;
  await locked(() => vault.move(current, destination)); current = null; await scan(); select(notes.find(n => n.path === destination));
});
$('delete').onclick = run(async () => {
  await save(); const destination = `.trash/${crypto.randomUUID()}.md`;
  await locked(() => vault.move(current, destination, {originalPath:current.path}));
  current = null; $('editor').hidden = true; await scan(); message('Заметка в корзине. Её можно восстановить.');
});
$('restore').onclick = run(async () => {
  const destination = current.originalPath || `Восстановленная-${crypto.randomUUID()}.md`;
  if (destination.startsWith('.trash/')) throw new Error('Некорректная папка восстановления');
  await locked(() => vault.move(current, destination, {originalPath:null})); current = null; filter = 'all';
  await scan(); select(notes.find(n => n.path === destination)); message('Заметка восстановлена.');
});
$('recover').onclick = run(async () => {
  clearTimeout(timer);
  const keys = draftKeys(); if (!keys.length) return;
  // Preserve every draft under a new unique name; never overwrite the external file.
  for (const key of keys) {
    const draft = JSON.parse(localStorage.getItem(key));
    const path = `Черновик-${crypto.randomUUID()}.md`;
    await locked(() => vault.write(path, encode(draft))); localStorage.removeItem(key);
  }
  dirty = false; await scan(); message('Черновики сохранены отдельными заметками в корневой папке.');
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); run(save)(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $(filter === 'trash' ? 'trashSearch' : 'search').focus(); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) run(save)(); });
async function init() {
  const stored = await setting('vault');
  if (!stored) return;
  await activate(stored.root, stored.id);
}
$('syncAccess').onclick = async () => {
  try {
    // Browser-controlled persistent permission: request directly from the click.
    if (await vault.root.requestPermission({mode:'readwrite'}) !== 'granted') return;
    await run(async () => { await save(); await scan(); })();
  } catch (error) { report(error); }
};
// Request from an intentional note interaction while browser activation is live.
// One automatic attempt per opening; a refusal leaves the explicit button available.
document.addEventListener('click', async event => {
  if (!event.isTrusted || !vault || vault.connected || autoAccessAttempted ||
      !event.target.closest('#editor, #new')) return;
  autoAccessAttempted = true;
  const targetVault = vault;
  try {
    const permission = await targetVault.root.requestPermission({mode:'readwrite'});
    if (permission !== 'granted' || vault !== targetVault) return;
    await run(async () => {
      if (vault !== targetVault) return;
      await save();
      await locked(() => targetVault.flush());
      syncStatus();
    })();
  } catch (error) {
    // A browser may reject automatic restoration; local saving remains available.
    console.warn('Folder access could not be restored', error);
  }
}, {capture:true});
init().catch(report);
