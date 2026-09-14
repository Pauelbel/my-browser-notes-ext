import {encode, safeName, matches, setting} from './storage.js';
import {CachedVault} from './cached-vault.js';
import {archiveAll} from './manual-archive.js';
import {createEditor} from './vendor/editor.js';
import {parseTags} from './tags.js';
const $ = id => document.getElementById(id);
let vault, vaultId, notes = [], folders = [], current, filter = 'tree', tag = '', dirty = false, timer, chain = Promise.resolve();
let expandedFolders = new Set();
const clientId = crypto.randomUUID();
const selectedTrash = new Set();
let purgeSnapshot = [];
let folderTrashSnapshot = null;
const rich = createEditor($('body'), () => capture(true));
const message = text => { $('message').textContent = text; $('message').hidden = !text; };
const saveTime = value => new Intl.DateTimeFormat('ru', {hour:'2-digit', minute:'2-digit'}).format(value || Date.now());
function editorSaveStatus(state, value) {
  const saving = state === 'saving', trashed = state === 'trash', failed = state === 'error';
  $('editorSaveStatus').dataset.state = state;
  $('editorSaveIcon').textContent = saving ? '◌' : (trashed ? '↶' : (failed ? '!' : '✓'));
  $('editorSaveText').textContent = saving ? 'Сохранение…' : (trashed ? 'Заметка в корзине' : (failed ? 'Не удалось сохранить' : `Сохранено ${saveTime(value)}`));
  document.querySelector('.autosave-hint').hidden = saving || trashed || failed;
}
function status(text, state = '') {
  const label = text.replace(/^✓\s*/, '');
  $('status').hidden = state !== 'error'; $('status').dataset.state = state; $('status').title = label;
  $('statusText').textContent = label;
  $('statusMark').hidden = !state; $('statusMark').textContent = state === 'error' ? '!' : '…';
}
function report(error) { console.error(error); message(error.message || String(error)); if (current) editorSaveStatus('error'); status('Не удалось сохранить', 'error'); }
function run(fn) { return (...args) => { chain = chain.then(() => fn(...args)).catch(report); return chain; }; }
const locked = fn => navigator.locks.request('quiet-notes-files', fn);
function option(value, text) { const el = document.createElement('option'); el.value = value; el.textContent = text; return el; }
function renderCustomSelect(id) {
  const select = $(id), button = $(`${id}Button`), menu = $(`${id}Menu`);
  const selected = select.selectedOptions[0];
  button.textContent = selected?.textContent || '';
  button.disabled = select.disabled;
  menu.replaceChildren(...[...select.options].map(item => {
    const choice = document.createElement('button'); choice.type = 'button'; choice.setAttribute('role', 'option');
    choice.textContent = item.textContent; choice.classList.toggle('selected', item.value === select.value);
    choice.onclick = () => { select.value = item.value; menu.hidden = true; button.setAttribute('aria-expanded', 'false'); select.dispatchEvent(new Event('change')); };
    return choice;
  }));
}
function toggleCustomSelect(id) {
  const menu = $(`${id}Menu`), button = $(`${id}Button`), opening = menu.hidden;
  for (const other of ['folderFilter', 'noteFolder']) if (other !== id) { $(`${other}Menu`).hidden = true; $(`${other}Button`).setAttribute('aria-expanded', 'false'); }
  menu.hidden = !opening; button.setAttribute('aria-expanded', String(opening));
}
function capture(bodyChanged = false) {
  if (!current || filter === 'trash') return;
  current.title = $('title').value;
  if (bodyChanged) current.body = rich.getMarkdown();
  dirty = true;
  editorSaveStatus('saving');
  status('Сохранение…', 'pending');
  clearTimeout(timer); timer = setTimeout(run(save), 800);
  counts();
}
async function save() {
  clearTimeout(timer);
  if (!dirty || !current) return;
  const target = {...current}, text = encode(target);
  const folder = target.path.includes('/') ? target.path.slice(0,target.path.lastIndexOf('/')) : '';
  const saved = await locked(() => vault.saveNamed(target, folder));
  current.path = saved.path;
  localStorage.setItem(`quiet-selected:${vaultId}`, saved.path);
  current.raw = text;
  const found = notes.find(n => n.path === target.path);
  if (found) Object.assign(found, saved);
  if (encode(current) === text) {
    dirty = false; editorSaveStatus('saved'); syncStatus();
  } else { status('Сохранение…', 'pending'); clearTimeout(timer); timer = setTimeout(run(save), 0); }
  renderList();
  if (dirty) await save();
}
function counts() {}
function snippet(markdown) {
  return markdown.replace(/<img\b[^>]*>/gi,'').replace(/<[^>]+>/g,' ').replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/^\s*(?:#{1,6}\s|>\s?|[-*+]\s(?:\[[ xX]\]\s)?|\d+\.\s)/gm,'')
    .replace(/[*_`~]/g,'').replace(/\s+/g,' ').trim().slice(0,90);
}
function syncStatus() {
  status('Сохранено в Chrome');
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
function availableTags() {
  return [...new Set(notes.filter(n => !n.path.startsWith('.trash/')).flatMap(n => n.tags))]
    .filter(value => !current?.tags.includes(value)).sort((a,b) => a.localeCompare(b, 'ru'));
}
function renderTagSuggestions(show = true) {
  const menu = $('tagSuggestions'), query = $('tags').value.trim().toLocaleLowerCase('ru');
  const values = availableTags().filter(value => value.toLocaleLowerCase('ru').includes(query));
  menu.replaceChildren(...values.map(value => {
    const button = document.createElement('button'); button.type = 'button'; button.role = 'option'; button.textContent = value;
    button.onclick = () => { current.tags.push(value); $('tags').value = ''; renderNoteTags(); capture(); renderTagSuggestions(false); };
    return button;
  }));
  menu.hidden = !show || !values.length; $('tags').setAttribute('aria-expanded', String(!menu.hidden));
}
function commitTags() {
  if (!current || filter === 'trash') return;
  const values = parseTags($('tags').value);
  if (!values.length) return;
  current.tags = [...new Set([...current.tags,...values])]; $('tags').value = ''; renderNoteTags(); capture();
}
function renderList() {
  const inTrash = filter === 'trash';
  const inTree = filter === 'tree';
  $('emptyTrash').hidden = !inTrash;
  $('emptyTrash').disabled = !notes.some(note => note.path.startsWith('.trash/'));
  $('workspace').classList.toggle('tree-mode', inTree);
  $('workspace').classList.remove('trash-mode');
  $('trashView').hidden = true;
  for (const value of ['tree','all','trash']) { $(value).classList.toggle('active', filter === value); $(value).setAttribute('aria-selected', String(filter === value)); }
  const list = $('list'); list.classList.remove('tree-list'); list.replaceChildren();
  if (inTree) { renderTree(list); return; }
  const folderFilter = $('folderFilter').value;
  const visible = notes.filter(n => (n.path.startsWith('.trash/') === inTrash) &&
    (inTrash || !folderFilter || n.path.substring(0,n.path.lastIndexOf('/')) === folderFilter) &&
    (inTrash || !tag || n.tags.includes(tag)) && matches(n, $('search').value)).sort((a,b) => b.modified - a.modified);
  for (const note of visible) {
    const button = document.createElement('button'); button.className = 'card' + (current?.path === note.path ? ' selected' : '');
    const title = document.createElement('strong'); title.textContent = note.title || 'Без названия';
    const preview = document.createElement('span'); preview.className = 'card-preview'; preview.textContent = snippet(note.body) || 'Пустая заметка';
    const tags = document.createElement('span'); tags.className = 'card-tags'; tags.textContent = note.tags.map(t => '#'+t).join(' ');
    button.append(title, preview); if (note.tags.length) button.append(tags);
    button.onclick = run(async () => { await save(); select(note); }); list.append(button);
  }
  if (!visible.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = inTrash ? 'Корзина пуста' : (notes.some(n => !n.path.startsWith('.trash/')) ? 'Здесь пока нет подходящих заметок' : 'Нет заметок'); list.append(p); }
}
function saveExpandedFolders() { localStorage.setItem(`quiet-tree:${vaultId}`, JSON.stringify([...expandedFolders])); }
function renderTree(list) {
  const query = $('search').value.trim();
  const active = notes.filter(note => !note.path.startsWith('.trash/'));
  const isMatch = note => !query || matches(note, query);
  const folderSet = new Set(folders.filter(Boolean));
  for (const note of active) {
    const parts = note.path.split('/'); parts.pop();
    for (let i = 1; i <= parts.length; i++) folderSet.add(parts.slice(0,i).join('/'));
  }
  const hasMatch = path => active.some(note => (path ? note.path.startsWith(path + '/') : !note.path.includes('/')) && isMatch(note));
  const makeBranch = (path, depth) => {
    const branch = document.createElement('div'); branch.className = 'tree-branch';
    const parent = folder => folder.includes('/') ? folder.slice(0,folder.lastIndexOf('/')) : '';
    const directFolders = [...folderSet].filter(folder => parent(folder) === path)
      .filter(folder => !query || hasMatch(folder)).sort((a,b) => a.localeCompare(b,'ru'));
    const directNotes = active.filter(note => (note.path.includes('/') ? note.path.slice(0,note.path.lastIndexOf('/')) : '') === path && isMatch(note))
      .sort((a,b) => (a.title || '').localeCompare(b.title || '', 'ru'));
    for (const folder of directFolders) {
      const open = query || expandedFolders.has(folder);
      const row = document.createElement('button'); row.className = 'tree-folder'; row.style.paddingLeft = `${6 + depth * 10}px`;
      row.setAttribute('aria-expanded', String(open));
      const arrow = document.createElement('span'); arrow.className = 'tree-arrow'; arrow.textContent = open ? '▾' : '▸';
      const label = document.createElement('span'); label.textContent = folder.split('/').pop(); row.append(arrow, label);
      row.onclick = () => { if (expandedFolders.has(folder)) expandedFolders.delete(folder); else expandedFolders.add(folder); saveExpandedFolders(); renderList(); };
      branch.append(row); if (open) branch.append(makeBranch(folder, depth + 1));
    }
    if (!path && directFolders.length && directNotes.length) {
      const divider = document.createElement('div'); divider.className = 'tree-root-divider'; divider.textContent = 'Заметки без папки'; branch.append(divider);
    }
    for (const note of directNotes) {
      const row = document.createElement('button'); row.className = 'tree-note' + (current?.path === note.path ? ' selected' : '');
      row.style.paddingLeft = `${20 + depth * 10}px`;
      const bullet = document.createElement('span'); bullet.className = 'tree-bullet'; bullet.textContent = '•';
      const label = document.createElement('span'); label.textContent = note.title || 'Без названия'; row.append(bullet, label);
      row.title = snippet(note.body) || 'Пустая заметка';
      row.onclick = run(async () => { await save(); select(note); }); branch.append(row);
    }
    return branch;
  };
  list.classList.add('tree-list'); list.append(makeBranch('', 0));
  if (!list.textContent.trim()) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = query ? 'Ничего не найдено' : 'Нет заметок и папок'; list.append(empty); }
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
    const origin = document.createElement('small'); origin.textContent = note.originalPath || 'Без папки';
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
  $('noteFolder').replaceChildren(...folders.map(f => option(f, f || 'Без папки')));
  if (current) $('noteFolder').value = current.path.includes('/') ? current.path.slice(0,current.path.lastIndexOf('/')) : '';
  renderCustomSelect('folderFilter'); renderCustomSelect('noteFolder');
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
  $('tagMenuButton').disabled = trashed;
  renderCustomSelect('noteFolder');
  rich.setEditable(!trashed);
  document.querySelectorAll('.toolbar button').forEach(b => b.disabled = trashed);
  $('noteMenuButton').hidden = trashed; $('noteMenu').hidden = true; $('restore').hidden = !trashed;
  editorSaveStatus(trashed ? 'trash' : 'saved', note.modified);
  syncStatus(); if (trashed) status('В корзине · можно восстановить'); counts(); renderList();
}
async function scan() {
  const result = await locked(() => vault.scan()); notes = result.notes; folders = result.folders;
  renderFilters(); renderList();
  if (current) {
    const found = notes.find(n => n.path === current.path);
    if (found) select(found); else { current = null; $('editor').hidden = true; }
  }
  syncStatus();
}
async function activate(id) {
  selectedTrash.clear(); $('trashSearch').value = '';
  vault = new CachedVault(null, id, setting, {localOnly:true}); vaultId = id; current = null; dirty = false;
  $('editor').hidden = true; $('welcome').hidden = true; $('workspace').hidden = false;
  message('');
  // Persist the local-only state once to discard the obsolete sync queue.
  await locked(async () => vault.persist(vault.key, await vault.state()));
  const cached = await vault.cached(); notes = cached.notes; folders = cached.folders; renderFilters(); renderList();
  const lastPath = localStorage.getItem(`quiet-selected:${id}`);
  const initial = notes.find(n => n.path === lastPath && !n.path.startsWith('.trash/')) || notes.find(n => !n.path.startsWith('.trash/'));
  if (initial) select(initial);
  await scan();
  if (!current && notes.length) { const note = notes.find(n => !n.path.startsWith('.trash/')); if (note) select(note); }
}
let archiving = false;
async function archiveEverything() {
  if (archiving || !vault) return;
  archiving = true;
  const buttons = [$('archiveAll'), $('archiveSettings')];
  buttons.forEach(button => { button.disabled = true; button.textContent = 'Архивация…'; });
  try {
    // Invoke the picker before any await to preserve the user's click gesture.
    const root = await window.showDirectoryPicker({id:'notes-manual-archive', mode:'readwrite'});
    await chain;
    await save();
    const snapshot = await locked(() => vault.cached());
    const result = await archiveAll(root, snapshot);
    message('Архив готов: ' + root.name + '/' + result.name + '. Сохранено заметок: ' + result.count + '.');
  } catch (error) {
    if (error.name !== 'AbortError') message(error.message || String(error));
  } finally {
    archiving = false;
    buttons.forEach(button => { button.disabled = false; button.textContent = 'Архивировать всё'; });
  }
}
$('archiveAll').onclick = archiveEverything;
$('archiveSettings').onclick = archiveEverything;
$('settings').onclick = () => $('preferences').showModal();
const themeToggle = document.createElement('button');
themeToggle.id = 'themeToggle'; themeToggle.type = 'button';
$('settings').after(themeToggle);
function renderTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  themeToggle.textContent = dark ? '☀' : '☾';
  themeToggle.title = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
  themeToggle.setAttribute('aria-label', themeToggle.title);
  themeToggle.setAttribute('aria-pressed', String(dark));
}
let storedTheme;
try { storedTheme = localStorage.getItem('quiet-theme'); } catch {}
renderTheme(storedTheme === 'dark' || storedTheme === 'light' ? storedTheme :
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
themeToggle.onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  renderTheme(theme);
  try { localStorage.setItem('quiet-theme', theme); } catch {}
};
window.addEventListener('storage', event => {
  if (event.key === 'quiet-theme' && ['light','dark'].includes(event.newValue)) renderTheme(event.newValue);
});
function renderMenuSide(side) {
  document.body.dataset.menuSide = side;
  $('menuLeft').classList.toggle('active', side === 'left');
  $('menuRight').classList.toggle('active', side === 'right');
}
async function setMenuSide(side) { renderMenuSide(side); await setting('menu-side', side); }
$('placement').onclick = () => chrome.tabs.create({url:'chrome://settings/appearance'});
$('openTab').onclick = () => chrome.tabs.create({url:chrome.runtime.getURL('index.html')});
$('menuLeft').onclick = () => setMenuSide('left').catch(report);
$('menuRight').onclick = () => setMenuSide('right').catch(report);
$('search').oninput = renderList;
$('folderFilter').onchange = () => { $('deleteFolder').disabled = !$('folderFilter').value; renderCustomSelect('folderFilter'); renderList(); };
$('folderFilterButton').onclick = () => toggleCustomSelect('folderFilter');
$('noteFolderButton').onclick = () => toggleCustomSelect('noteFolder');
$('refresh').onclick = run(async () => {
  await save();
  await refreshLocalList();
});
for (const value of ['tree','all','trash']) $(value).onclick = run(async () => {
  await save(); filter = value; tag = ''; selectedTrash.clear(); message(''); $('folderFilter').value = ''; renderFilters(); renderList();
  if (value === 'all') {
    const last = localStorage.getItem(`quiet-selected:${vaultId}`);
    const note = notes.find(n => n.path === last && !n.path.startsWith('.trash/')) || notes.find(n => !n.path.startsWith('.trash/'));
    if (note) select(note); else { current = null; $('editor').hidden = true; }
  } else if (value === 'trash') {
    const note = notes.filter(n => n.path.startsWith('.trash/')).sort((a,b) => b.modified-a.modified)[0];
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
$('emptyTrash').onclick = () => {
  purgeSnapshot = notes.filter(note => note.path.startsWith('.trash/')).map(note => ({...note}));
  if (!purgeSnapshot.length) return;
  $('purgeDescription').textContent = `Будут безвозвратно удалены все заметки из корзины: ${purgeSnapshot.length}, включая скрытые поиском.`;
  $('purgeNames').replaceChildren(...purgeSnapshot.map(note => {
    const item = document.createElement('li'); item.textContent = note.title || 'Без названия'; return item;
  }));
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
  const note = {title:'Без названия', tags:[], body:''};
  const saved = await locked(() => vault.saveNamed(note, folder));
  await scan(); select(notes.find(n => n.path === saved.path)); $('title').focus(); $('title').select();
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
$('noteMenuButton').onclick = event => {
  event.stopPropagation(); const open = $('noteMenu').hidden;
  $('noteMenu').hidden = !open; $('noteMenuButton').setAttribute('aria-expanded', String(open));
};
$('tagMenuButton').onclick = event => { event.stopPropagation(); renderTagSuggestions($('tagSuggestions').hidden); };
$('tags').addEventListener('focus', () => renderTagSuggestions());
$('tags').addEventListener('keydown', event => {
  if (!event.isComposing && ['Enter',' ',','].includes(event.key)) { event.preventDefault(); commitTags(); }
});
$('tags').addEventListener('input', event => {
  if (!event.isComposing && /[\s,]/u.test($('tags').value)) commitTags();
  renderTagSuggestions();
});
$('tags').addEventListener('blur', () => { setTimeout(() => renderTagSuggestions(false), 120); commitTags(); run(async () => { await save(); renderFilters(); })(); });
$('insertImage').onclick = () => {
  if (current && filter !== 'trash') $('imageInput').click();
};
function insertImageFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/i.test(file.type)) { message('Поддерживаются PNG, JPEG, GIF и WebP.'); return; }
  if (file.size > 8 * 1024 * 1024) { message('Изображение должно быть не больше 8 МБ.'); return; }
  const reader = new FileReader();
  reader.onerror = () => message('Не удалось прочитать изображение.');
  reader.onload = () => {
    if (typeof reader.result !== 'string' || !rich.insertImage(reader.result)) { message('Не удалось вставить изображение.'); return; }
    capture(true);
  };
  reader.readAsDataURL(file);
}
$('imageInput').onchange = () => {
  const [file] = $('imageInput').files;
  $('imageInput').value = '';
  insertImageFile(file);
};
document.addEventListener('paste', event => {
  if (!current || filter === 'trash' || !event.target.closest('#body')) return;
  const image = [...(event.clipboardData?.files || [])].find(file => /^image\//i.test(file.type));
  if (!image) return;
  event.preventDefault();
  insertImageFile(image);
});
$('noteFolder').onchange = run(async () => {
  const folder = $('noteFolder').value; await save();
  const destination = (folder ? folder+'/' : '') + current.path.split('/').pop();
  if (destination === current.path) return;
  await locked(() => vault.move(current, destination)); current = null; await scan(); select(notes.find(n => n.path === destination));
});
$('delete').onclick = run(async () => {
  $('noteMenu').hidden = true; $('noteMenuButton').setAttribute('aria-expanded', 'false');
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
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); run(save)(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $(filter === 'trash' ? 'trashSearch' : 'search').focus(); }
  if (event.key === 'Escape') { $('noteMenu').hidden = true; $('noteMenuButton').setAttribute('aria-expanded', 'false'); renderTagSuggestions(false); }
});
document.addEventListener('click', event => {
  if (!event.target.closest('.note-menu-wrap')) { $('noteMenu').hidden = true; $('noteMenuButton').setAttribute('aria-expanded', 'false'); }
  if (!event.target.closest('.tag-picker')) renderTagSuggestions(false);
  if (!event.target.closest('.custom-select')) for (const id of ['folderFilter', 'noteFolder']) { $(`${id}Menu`).hidden = true; $(`${id}Button`).setAttribute('aria-expanded', 'false'); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && dirty) run(save)(); });
// Refresh changes from other extension windows without erasing a draft.
async function refreshLocalList() {
  const result = await locked(() => vault.scan(dirty && current ? [current.path] : []));
  notes = result.notes; folders = result.folders;
  if (current && !dirty && !notes.some(note => note.path === current.path)) {
    current = null; $('editor').hidden = true;
  }
  renderFilters(); renderList(); syncStatus();
}
setInterval(() => {
  if (vault && !document.hidden) run(refreshLocalList)();
}, 30 * 1000);
async function init() {
  renderMenuSide(await setting('menu-side') || 'left');
  const stored = await setting('vault');
  const id = await setting('collection-id') || stored?.id || 'local';
  await setting('collection-id', id);
  // Detach the old disk handle; browser notes and folders remain in this collection.
  await setting('vault', null);
  try { expandedFolders = new Set(JSON.parse(localStorage.getItem(`quiet-tree:${id}`) || '[]')); } catch { expandedFolders = new Set(); }
  await activate(id);
}
init().catch(report);
