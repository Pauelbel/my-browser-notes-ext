import {encode, safeName, matches, setting} from './storage.js';
import {CachedVault} from './cached-vault.js';
import {archiveAll} from './manual-archive.js';
import {createEditor} from './vendor/editor.js';
import {parseTags} from './tags.js';
const $ = id => document.getElementById(id);
let vault, vaultId, notes = [], folders = [], current, filter = 'tree', tag = '', dirty = false, timer, chain = Promise.resolve();
let expandedFolders = new Set();
let savedVault = null;
const clientId = crypto.randomUUID();
const selectedTrash = new Set();
let purgeSnapshot = [];
let folderTrashSnapshot = null;
let renameFolderPath = null;
let noteTrashSnapshot = null;
let dragSource = null;
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
  if (!vault) return;
  const connected = vault.archiveState === 'connected' && !vault.pending;
  const missing = vault.archiveState === 'missing';
  const failed = missing || vault.archiveState === 'error';
  $('syncNotice').hidden = false;
  $('syncNotice').classList.toggle('connected', connected);
  $('syncNotice').classList.toggle('failed', failed);
  $('syncText').textContent = vault.error?.message || vault.syncNotice || (connected ? 'Все изменения записаны в папку' : 'Нажмите, чтобы подключить папку');
  $('syncAccess').textContent = connected ? '● Папка подключена' : missing ? '● Папка не найдена' : failed ? '● Ошибка синхронизации' : '● Подключить папку';
  $('syncAccess').title = $('syncText').textContent;
  if (vault.pending) status('✓ В Chrome · ожидает записи в папку', 'pending');
  else if (!vault.root) status('✓ Сохранено в Chrome', '');
  else if (!vault.connected) status('✓ В Chrome · папка отключена', 'pending');
  else status('✓ Сохранено', '');
  $('trashSync').hidden = !vault.pending && !vault.error && !vault.syncNotice;
  $('trashSync').textContent = vault.error?.message || vault.syncNotice || 'Изменения сохранены в Chrome и будут добавлены в папку при подключении.';
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
  const inTags = filter === 'tags';
  $('emptyTrash').hidden = !inTrash;
  $('emptyTrash').disabled = !notes.some(note => note.path.startsWith('.trash/'));
  $('workspace').classList.toggle('tree-mode', inTree);
  $('workspace').classList.toggle('tags-mode', inTags);
  $('workspace').classList.toggle('trash-mode', inTrash);
  $('trashView').hidden = !inTrash;
  $('tagView').hidden = !inTags;
  $('treeActions').hidden = !inTree;
  for (const [value, id] of [['tree','tree'],['tags','tagsView'],['trash','trash']]) { $(id).classList.toggle('active', filter === value); $(id).setAttribute('aria-selected', String(filter === value)); }
  const list = $('list'); list.classList.remove('tree-list'); list.replaceChildren();
  if (inTree) { renderTree(list); return; }
  if (inTags) { renderTagView(); return; }
  if (inTrash) { renderTrash(); return; }
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
      const item = document.createElement('div'); item.className = 'tree-item';
      const row = document.createElement('button'); row.className = 'tree-folder'; row.style.paddingLeft = `${6 + depth * 10}px`;
      row.setAttribute('aria-expanded', String(open));
      const arrow = document.createElement('span'); arrow.className = 'tree-arrow'; arrow.textContent = open ? '▾' : '▸';
      const label = document.createElement('span'); label.textContent = folder.split('/').pop(); row.append(arrow, label);
      row.classList.toggle('selected', $('folderFilter').value === folder);
      row.onclick = () => { $('folderFilter').value = folder; if (expandedFolders.has(folder)) expandedFolders.delete(folder); else expandedFolders.add(folder); saveExpandedFolders(); renderList(); };
      makeDraggable(row, {type:'folder', path:folder}); makeDropTarget(item, folder);
      const menu = makeTreeMenu([{label:'Переименовать', action:() => openRenameFolder(folder)}, {label:'Удалить', danger:true, action:() => requestFolderTrash(folder)}]);
      item.append(row, menu); branch.append(item); if (open) branch.append(makeBranch(folder, depth + 1));
    }
    if (!path && directFolders.length && directNotes.length) {
      const divider = document.createElement('div'); divider.className = 'tree-root-divider'; divider.textContent = 'Заметки без папки'; branch.append(divider);
    }
    for (const note of directNotes) {
      const item = document.createElement('div'); item.className = 'tree-item';
      const row = document.createElement('button'); row.className = 'tree-note' + (current?.path === note.path ? ' selected' : '');
      row.style.paddingLeft = `${20 + depth * 10}px`;
      const bullet = document.createElement('span'); bullet.className = 'tree-bullet'; bullet.textContent = '•';
      const label = document.createElement('span'); label.textContent = note.title || 'Без названия'; row.append(bullet, label);
      row.title = snippet(note.body) || 'Пустая заметка';
      row.onclick = run(async () => { await save(); select(note); });
      makeDraggable(row, {type:'note', path:note.path});
      const menu = makeTreeMenu([{label:'Удалить', danger:true, action:() => requestNoteTrash(note)}]);
      item.append(row, menu); branch.append(item);
    }
    return branch;
  };
  const tree = makeBranch('', 0), hasEntries = tree.querySelector('.tree-item,.tree-root-divider');
  const rootDrop = document.createElement('div'); rootDrop.className = 'tree-root-drop'; rootDrop.textContent = 'Переместить в корень';
  makeDropTarget(rootDrop, '');
  list.classList.add('tree-list'); list.append(tree, rootDrop);
  if (!hasEntries) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = query ? 'Ничего не найдено' : 'Нет заметок и папок'; list.append(empty); }
}
function makeTreeMenu(items) {
  const wrap = document.createElement('div'); wrap.className = 'tree-menu-wrap';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'tree-more'; trigger.textContent = '⋮'; trigger.title = 'Действия'; trigger.setAttribute('aria-label','Действия'); trigger.setAttribute('aria-haspopup','menu'); trigger.setAttribute('aria-expanded','false');
  const menu = document.createElement('div'); menu.className = 'tree-menu'; menu.setAttribute('role','menu'); menu.hidden = true;
  for (const item of items) { const button = document.createElement('button'); button.type = 'button'; button.textContent = item.label; button.setAttribute('role','menuitem'); if (item.danger) button.className = 'danger'; button.onclick = () => { menu.hidden = true; trigger.setAttribute('aria-expanded','false'); item.action(); }; menu.append(button); }
  trigger.onclick = event => { event.stopPropagation(); closeTreeMenus(menu); const open = menu.hidden; menu.hidden = !open; trigger.setAttribute('aria-expanded', String(open)); };
  wrap.append(trigger,menu); return wrap;
}
function closeTreeMenus(except) { document.querySelectorAll('.tree-menu').forEach(menu => { if (menu !== except) menu.hidden = true; }); document.querySelectorAll('.tree-more').forEach(button => { if (!except || !button.parentElement?.contains(except)) button.setAttribute('aria-expanded','false'); }); }
function canDrop(source, parent) {
  if (!source || (source.type !== 'folder' && source.type !== 'note')) return false;
  const sourceParent = source.path.includes('/') ? source.path.slice(0,source.path.lastIndexOf('/')) : '';
  if (source.type === 'folder' && (parent === source.path || parent.startsWith(source.path + '/'))) return false;
  return sourceParent !== parent;
}
function makeDraggable(element, source) {
  element.draggable = true;
  element.addEventListener('dragstart', event => {
    dragSource = source; element.classList.add('dragging'); element.setAttribute('aria-grabbed','true');
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', JSON.stringify(source));
  });
  element.addEventListener('dragend', () => {
    dragSource = null; document.querySelectorAll('.drop-target,.drop-invalid,.dragging').forEach(item => item.classList.remove('drop-target','drop-invalid','dragging'));
    document.querySelectorAll('[aria-grabbed=true]').forEach(item => item.setAttribute('aria-grabbed','false'));
  });
}
function makeDropTarget(element, parent) {
  element.addEventListener('dragover', event => {
    const valid = canDrop(dragSource, parent); element.classList.toggle('drop-invalid', !valid); element.classList.toggle('drop-target', valid);
    if (valid) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
  });
  element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('drop-target','drop-invalid'); });
  element.addEventListener('drop', event => {
    event.preventDefault(); element.classList.remove('drop-target','drop-invalid');
    const source = dragSource; if (!canDrop(source,parent)) return;
    run(() => moveDroppedItem(source, parent))();
  });
}
function remapExpandedFolders(from, to) {
  expandedFolders = new Set([...expandedFolders].map(path => path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path));
  saveExpandedFolders();
}
async function moveDroppedItem(source, parent) {
  await save();
  const name = source.path.slice(source.path.lastIndexOf('/') + 1);
  const destination = parent ? `${parent}/${name}` : name;
  if (source.type === 'note') {
    const note = notes.find(value => value.path === source.path);
    if (!note) throw Error('Заметка больше не существует.');
    await locked(() => vault.move(note, destination));
    if (current?.path === source.path) current.path = destination;
  } else {
    await locked(() => vault.moveFolder(source.path, parent));
    remapExpandedFolders(source.path, destination);
    if (current?.path.startsWith(source.path + '/')) current.path = destination + current.path.slice(source.path.length);
    if ($('folderFilter').value === source.path || $('folderFilter').value.startsWith(source.path + '/')) $('folderFilter').value = destination + $('folderFilter').value.slice(source.path.length);
  }
  if (parent) expandedFolders.add(parent); saveExpandedFolders();
  await scan();
  message(source.type === 'note' ? 'Заметка перемещена.' : 'Папка перемещена.');
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
    const row = document.createElement('label'); row.className = 'card trash-card';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedTrash.has(note.path);
    checkbox.setAttribute('aria-label', `Выбрать заметку «${note.title || 'Без названия'}»`);
    row.classList.toggle('selected',checkbox.checked);
    checkbox.onchange = () => {
      if (checkbox.checked) selectedTrash.add(note.path); else selectedTrash.delete(note.path);
      row.classList.toggle('selected',checkbox.checked); trashSelectionStatus();
    };
    const content = document.createElement('span'); content.className = 'trash-card-content';
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
  $('noteFolder').replaceChildren(...folders.map(f => option(f, f || 'Без папки')));
  if (current) $('noteFolder').value = current.path.includes('/') ? current.path.slice(0,current.path.lastIndexOf('/')) : '';
  renderCustomSelect('folderFilter'); renderCustomSelect('noteFolder');
  $('tagCloud').replaceChildren();
  const tags = [...new Set(notes.filter(n => !n.path.startsWith('.trash/')).flatMap(n => n.tags))].sort();
  for (const value of tags) {
    const button = document.createElement('button'); button.textContent = '#' + value; button.classList.toggle('active', tag === value);
    button.onclick = () => { tag = tag === value ? '' : value; renderFilters(); renderList(); }; $('tagCloud').append(button);
  }
}
function renderTagView() {
  const list = $('tagNotes'); list.replaceChildren();
  const visible = notes.filter(note => !note.path.startsWith('.trash/') && (!tag || note.tags.includes(tag)) && matches(note, $('search').value))
    .sort((a,b) => b.modified - a.modified);
  if (!visible.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = tag ? `У тега #${tag} пока нет заметок.` : 'Добавьте теги к заметкам — они появятся здесь.';
    list.append(empty); return;
  }
  for (const note of visible) {
    const button = document.createElement('button'); button.className = 'card'; button.classList.toggle('selected', current?.path === note.path);
    const title = document.createElement('strong'); title.textContent = note.title || 'Без названия';
    const preview = document.createElement('small'); preview.textContent = snippet(note.body) || 'Пустая заметка';
    const noteTags = document.createElement('span'); noteTags.className = 'card-tags'; noteTags.textContent = note.tags.map(value => '#' + value).join(' ');
    button.append(title, preview); if (note.tags.length) button.append(noteTags);
    button.onclick = () => { filter = 'tree'; tag = ''; renderFilters(); renderList(); select(note); }; list.append(button);
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
async function activate(id, root = null) {
  selectedTrash.clear(); $('trashSearch').value = '';
  vault = new CachedVault(root, id, setting, {localOnly: !root}); vaultId = id; current = null; dirty = false;
  $('editor').hidden = true; $('welcome').hidden = true; $('workspace').hidden = false;
  $('folderInfo').textContent = root?.name || 'Папка с заметками не выбрана.';
  message('');
  await vault.bootstrapFromArchive();
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
// Call the picker directly in a click handler to preserve browser user activation.
function confirmArchiveMerge(count) {
  const dialog = $('mergeArchiveDialog');
  $('mergeArchiveCount').textContent = `Найдено Markdown-заметок: ${count}.`;
  return new Promise(resolve => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), {once:true});
    $('confirmMergeArchive').onclick = () => dialog.close('merge');
    $('cancelArchiveMerge').onclick = () => {
      if (confirm('Заменить заметки в браузере содержимым выбранной папки?\n\nВсе текущие заметки и корзина браузера будут заменены. Заметки, которые есть только в браузере, будут удалены без возможности отмены. Файлы в папке останутся без изменений.')) dialog.close('replace');
    };
    $('otherArchive').onclick = () => { dialog.close('other'); choose(); };
    dialog.showModal();
  });
}
async function choose() {
  if (dirty) { message('Сначала дождитесь сохранения текущей заметки.'); return; }
  try {
    const root = await window.showDirectoryPicker({id:'quiet-notes', mode:'readwrite'});
    const state = await root.queryPermission({mode:'readwrite'});
    if (state !== 'granted' && await root.requestPermission({mode:'readwrite'}) !== 'granted') {
      throw new Error('Доступ к записи в папку не предоставлен.');
    }
    const id = vaultId || savedVault?.id || 'local';
    const sameFolder = savedVault?.root ? await savedVault.root.isSameEntry(root).catch(() => false) : false;
    if (!sameFolder) {
      const replacement = new CachedVault(root, id, setting);
      const imported = await replacement.disk.scan();
      const choice = imported.notes.length ? await confirmArchiveMerge(imported.notes.length) : 'merge';
      if (!['merge','replace'].includes(choice)) return;
      await locked(async () => {
        if (choice === 'replace') await replacement.replaceFromArchive();
        else await replacement.mergeArchive(imported);
        // Subsequent background work must use the newly selected archive.
        vault = replacement;
      });
      if (choice === 'replace') {
        current = null; dirty = false; clearTimeout(timer);
        localStorage.removeItem(`quiet-selected:${id}`);
        expandedFolders.clear();
        localStorage.removeItem(`quiet-tree:${id}`);
        $('search').value = '';
      }
    }
    savedVault = {root, id};
    await setting('vault', {root, id});
    filter = 'tree'; tag = ''; $('folderFilter').value = '';
    await activate(id, root); $('preferences').close();
  } catch (error) { if (error.name !== 'AbortError') report(error); }
}
$('changeFolder').onclick = choose;
$('syncAccess').onclick = async () => {
  try {
    if (!savedVault?.root || vault?.archiveState === 'missing') { await choose(); return; }
    if (savedVault?.root && (!vault?.connected || vault.error)) {
      const root = savedVault.root;
      // Invoke before ANY await so the browser sees the actual button gesture.
      const permission = root.requestPermission({mode:'readwrite'});
      const granted = await permission === 'granted';
      if (!granted) throw new Error('Доступ к папке не предоставлен. Выберите папку заново.');
    }
    await run(async () => { await save(); await refreshLocalList(); })();
    if (vault.error) message(vault.archiveState === 'missing'
      ? 'Папка не найдена. Нажмите на индикатор, чтобы выбрать другую. Заметки сохранены в Chrome.'
      : vault.error.message);
  } catch (error) {
    message(error.message || String(error));
  }
};
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
$('folderFilter').onchange = () => { renderCustomSelect('folderFilter'); renderList(); };
$('folderFilterButton').onclick = () => toggleCustomSelect('folderFilter');
$('noteFolderButton').onclick = () => toggleCustomSelect('noteFolder');
$('refresh').onclick = run(async () => {
  await save();
  await refreshLocalList();
});
for (const [value, id] of [['tree','tree'],['tags','tagsView'],['trash','trash']]) $(id).onclick = run(async () => {
  await save(); filter = value; tag = ''; selectedTrash.clear(); message(''); $('folderFilter').value = ''; renderFilters(); renderList();
  if (value === 'tags' || value === 'trash') { current = null; $('editor').hidden = true; }
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
  await save(); filter = 'tree'; tag = ''; $('search').value = '';
  const folder = $('folderFilter').value;
  const note = {title:'Без названия', tags:[], body:''};
  const saved = await locked(() => vault.saveNamed(note, folder));
  await scan(); select(notes.find(n => n.path === saved.path)); $('title').focus(); $('title').select();
});
function openNewFolderDialog() {
  $('newFolderName').value = '';
  $('newFolderDialog').showModal();
  $('newFolderName').focus();
}
$('createFolderTree').onclick = openNewFolderDialog;
$('cancelNewFolder').onclick = () => $('newFolderDialog').close();
$('newFolderForm').onsubmit = event => {
  event.preventDefault();
  const name = $('newFolderName').value.trim();
  if (!name) return;
  $('newFolderDialog').close();
  run(async () => {
    await save();
    await locked(() => vault.directory(safeName(name), true));
    await scan();
  })();
};
function requestFolderTrash(path) { run(async () => {
  $('folderFilter').value = path;
  await save(); await scan();
  if (!folders.includes(path)) throw Error('Папка больше не существует.');
  folderTrashSnapshot = {path, notes:notes.filter(n => n.path.startsWith(path + '/')).map(n => ({path:n.path,raw:n.raw})),
    folders:folders.filter(f => f === path || f.startsWith(path + '/'))};
  $('folderTrashDescription').textContent = `Папка «${path}». Заметок: ${folderTrashSnapshot.notes.length}. Вложенных папок: ${folderTrashSnapshot.folders.length-1}.`;
  $('folderTrashDialog').showModal();
})(); }
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
function openRenameFolder(path) {
  renameFolderPath = path;
  $('renameFolderName').value = path.split('/').pop();
  $('renameFolderDialog').showModal();
  $('renameFolderName').focus(); $('renameFolderName').select();
}
$('cancelRenameFolder').onclick = () => { renameFolderPath = null; $('renameFolderDialog').close(); };
$('renameFolderForm').onsubmit = event => {
  event.preventDefault();
  const path = renameFolderPath, name = $('renameFolderName').value.trim();
  if (!path || !name) return;
  renameFolderPath = null; $('renameFolderDialog').close();
  run(async () => {
    await save();
    const destination = await locked(() => vault.renameFolder(path, name));
    $('folderFilter').value = destination;
    if (current?.path.startsWith(path + '/')) current.path = destination + current.path.slice(path.length);
    await scan(); message(`Папка переименована: «${destination}».`);
  })();
};
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
function requestNoteTrash(note) {
  if (!note || note.path.startsWith('.trash/')) return;
  noteTrashSnapshot = {path:note.path, title:note.title};
  $('noteTrashDescription').textContent = `Заметка «${note.title || 'Без названия'}» будет перемещена в корзину.`;
  $('noteTrashDialog').showModal();
}
$('delete').onclick = () => { $('noteMenu').hidden = true; $('noteMenuButton').setAttribute('aria-expanded', 'false'); requestNoteTrash(current); };
$('cancelNoteTrash').onclick = () => { noteTrashSnapshot = null; $('noteTrashDialog').close(); };
$('confirmNoteTrash').onclick = run(async () => {
  const snapshot = noteTrashSnapshot; noteTrashSnapshot = null; $('noteTrashDialog').close();
  if (!snapshot) return;
  await save();
  const note = notes.find(value => value.path === snapshot.path);
  if (!note) throw Error('Заметка больше не существует.');
  const destination = `.trash/${crypto.randomUUID()}.md`;
  await locked(() => vault.move(note, destination, {originalPath:note.path}));
  if (current?.path === note.path) { current = null; $('editor').hidden = true; }
  await scan(); message('Заметка в корзине. Её можно восстановить.');
});
$('restore').onclick = run(async () => {
  const destination = current.originalPath || `Восстановленная-${crypto.randomUUID()}.md`;
  if (destination.startsWith('.trash/')) throw new Error('Некорректная папка восстановления');
  await locked(() => vault.move(current, destination, {originalPath:null})); current = null; filter = 'tree';
  await scan(); select(notes.find(n => n.path === destination)); message('Заметка восстановлена.');
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); run(save)(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $(filter === 'trash' ? 'trashSearch' : 'search').focus(); }
  if (event.key === 'Escape') { $('noteMenu').hidden = true; $('noteMenuButton').setAttribute('aria-expanded', 'false'); renderTagSuggestions(false); }
});
document.addEventListener('click', event => {
  if (!event.target.closest('.note-menu-wrap')) { $('noteMenu').hidden = true; $('noteMenuButton').setAttribute('aria-expanded', 'false'); }
  if (!event.target.closest('.tree-menu-wrap')) closeTreeMenus();
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
  savedVault = stored || null;
  const id = await setting('collection-id') || stored?.id || 'local';
  await setting('collection-id', id);
  try { expandedFolders = new Set(JSON.parse(localStorage.getItem(`quiet-tree:${id}`) || '[]')); } catch { expandedFolders = new Set(); }
  await activate(id, stored?.root || null);
}
init().catch(report);
