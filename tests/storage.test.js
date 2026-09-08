import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Vault, encode, decode, safeName, parts, matches} from '../storage.js';
import {CachedVault} from '../cached-vault.js';
import {parseTags} from '../tags.js';
class Directory {
  kind = 'directory'; entriesMap = new Map();
  permission = 'granted';
  async queryPermission() { return this.permission; }
  async getDirectoryHandle(name, {create} = {}) {
    if (!this.entriesMap.has(name) && create) this.entriesMap.set(name, new Directory());
    const result = this.entriesMap.get(name);
    if (!result) throw new DOMException('Missing','NotFoundError');
    return result;
  }
  async getFileHandle(name, {create} = {}) {
    if (!this.entriesMap.has(name) && create) this.entriesMap.set(name, new File());
    const result = this.entriesMap.get(name);
    if (!result) throw new DOMException('Missing','NotFoundError');
    return result;
  }
  async removeEntry(name) {
    const entry = this.entriesMap.get(name);
    if (!entry) throw new DOMException('Missing','NotFoundError');
    if (entry.kind === 'directory' && entry.entriesMap.size) throw new DOMException('Not empty','InvalidModificationError');
    this.entriesMap.delete(name);
  }
  async *entries() { yield* this.entriesMap.entries(); }
}
class File {
  kind = 'file'; content = ''; fail = false;
  async getFile() { const text = this.content; return {text: async () => text, lastModified:1}; }
  async createWritable() { let pending; return {write: async text => { if (this.fail) throw Error('Disk full'); pending = text; }, close: async () => {this.content = pending;}, abort:async () => {}}; }
}
test('Markdown round trip preserves Unicode, empty fields and metadata delimiters', () => {
  const note = {title:'', tags:['тег -->','<script>'], body:'\n# Привет\n- [ ] Дело\n', originalPath:'Работа/идея.md'};
  const decoded = decode(encode(note), 'test.md');
  for (const key of Object.keys(note)) assert.deepEqual(decoded[key],note[key]);
  assert.equal(decode('# Plain\n','plain.md').body, '# Plain\n');
  assert.equal(decode('<!-- quiet-notes: null -->\ntext','plain.md').body, '<!-- quiet-notes: null -->\ntext');
});
test('path traversal is rejected and Windows file names are safe', () => {
  for (const path of ['../x','a/../b','/root','a\\b','a//b']) assert.throws(() => parts(path));
  assert.equal(safeName('CON'), 'Заметка'); assert.equal(safeName('a:b?'), 'a-b-');
});
test('search finds mixed case words in body, tags and title', () => {
  const note = {title:'Планы', body:'Купить молоко', tags:['Дом'], path:'Быт/планы.md'};
  assert.ok(matches(note,'ДОМ молоко')); assert.ok(matches(note,'быт планы')); assert.ok(!matches(note,'работа'));
});
test('empty content replaces old content; conflicts and duplicate names do not overwrite', async () => {
  const v = new Vault(new Directory()); await v.write('a.md','old');
  await v.write('a.md','', 'old'); assert.equal(await v.read('a.md'),'');
  await assert.rejects(v.write('a.md','bad','old')); await assert.rejects(v.write('a.md','duplicate'));
  assert.equal(await v.read('a.md'),'');
});
test('trash round trip preserves content, tags and original subfolder', async () => {
  const v = new Vault(new Directory()), note = {title:'Идея', body:'# Текст', tags:['тест'], path:'Работа/a.md'};
  await v.write(note.path,encode(note)); note.raw = await v.read(note.path);
  await v.move(note,'.trash/a.md',{originalPath:note.path});
  await assert.rejects(v.read(note.path));
  const trashed = decode(await v.read('.trash/a.md'),'.trash/a.md');
  await v.move(trashed,trashed.originalPath,{originalPath:null});
  const scan = await v.scan(); assert.equal(scan.notes.length,1); assert.equal(scan.notes[0].body,note.body); assert.deepEqual(scan.notes[0].tags,note.tags);
});
test('failed destination write preserves source and collision does not overwrite', async () => {
  const root = new Directory(), v = new Vault(root), note = {title:'A',body:'Important',tags:[],path:'a.md'};
  await v.write('a.md',encode(note)); note.raw = await v.read('a.md');
  await v.write('b.md','Existing'); await assert.rejects(v.move(note,'b.md'));
  assert.equal(await v.read('a.md'),note.raw); assert.equal(await v.read('b.md'),'Existing');
  const original = root.getFileHandle.bind(root);
  root.getFileHandle = async (...args) => { const file = await original(...args); if (args[0] === 'fail.md') file.fail = true; return file; };
  await assert.rejects(v.move(note,'fail.md')); assert.equal(await v.read('a.md'),note.raw);
});
function persistence() {
  const data = new Map();
  return async (key,value) => {
    if (value !== undefined) data.set(key,structuredClone(value));
    return structuredClone(data.get(key));
  };
}
test('tags accept spaces, commas, newlines and optional # without duplicates', () => {
  assert.deepEqual(parseTags(' работа  #идеи,личное\nработа '),['работа','идеи','личное']);
});
test('cached notes reopen without permission and offline edits survive restart and sync', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root);
  await disk.write('a.md',encode({title:'A',body:'old',tags:[]}));
  let cached = new CachedVault(root,'same',persist); await cached.scan();
  root.permission = 'prompt'; cached = new CachedVault(root,'same',persist);
  const note = (await cached.scan()).notes[0]; assert.equal(note.body,'old');
  const updated = encode({...note,body:'offline'}); await cached.write('a.md',updated,note.raw);
  assert.equal(cached.pending,1); assert.equal(decode(await disk.read('a.md'),'a.md').body,'old');
  cached = new CachedVault(root,'same',persist); assert.equal((await cached.scan()).notes[0].body,'offline');
  root.permission = 'granted'; await cached.scan(); assert.equal(cached.pending,0); assert.equal(await disk.read('a.md'),updated);
});
test('outbox preserves both external edits and pending local changes on conflict', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'x',persist);
  await disk.write('a.md','original'); const note = (await cached.scan()).notes[0];
  root.permission = 'prompt'; await cached.write('a.md','local',note.raw);
  await disk.write('a.md','external','original'); root.permission = 'granted';
  const result = await cached.scan(); assert.equal(cached.pending,1); assert.ok(cached.error);
  assert.equal(result.notes[0].body,'local'); assert.equal(await disk.read('a.md'),'external');
});
test('offline trash and restoration replay in order without losing the file', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'x',persist);
  await disk.write('folder/a.md',encode({title:'A',body:'body',tags:['a']}));
  let note = (await cached.scan()).notes[0]; root.permission = 'prompt';
  await cached.move(note,'.trash/a.md',{originalPath:note.path});
  note = (await cached.scan()).notes[0]; await cached.move(note,note.originalPath,{originalPath:null});
  root.permission = 'granted'; await cached.scan(); assert.equal(cached.pending,0);
  assert.equal((await disk.scan()).notes.length,1); assert.equal(decode(await disk.read('folder/a.md'),'folder/a.md').body,'body');
});
test('disk write replay after a crash is idempotent', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'x',persist);
  await disk.write('a.md','new');
  await persist('collection:x',{notes:[decode('new','a.md')],folders:[''],outbox:[{type:'write',path:'a.md',text:'new',expected:'old'}]});
  await cached.scan(); assert.equal(cached.pending,0); assert.equal(await disk.read('a.md'),'new');
});
test('bulk purge removes only selected trash notes from cache and disk', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'purge',persist);
  await disk.write('.trash/a.md','A'); await disk.write('.trash/b.md','B'); await disk.write('keep.md','Keep');
  const {notes} = await cached.scan(); await cached.purgeTrash([notes.find(n => n.path === '.trash/a.md')]);
  assert.equal(cached.pending,0); await assert.rejects(disk.read('.trash/a.md'));
  assert.equal(await disk.read('.trash/b.md'),'B'); assert.equal(await disk.read('keep.md'),'Keep');
  assert.equal((await cached.cached()).notes.length,2);
});
test('purge validates the entire selection before removing anything', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'guard',persist);
  await disk.write('.trash/a.md','A'); await disk.write('active.md','Active');
  const {notes} = await cached.scan(); await assert.rejects(cached.purgeTrash(notes));
  assert.equal((await cached.cached()).notes.length,2); assert.equal(await disk.read('.trash/a.md'),'A');
  await assert.rejects(cached.purgeTrash([{...notes.find(n => n.path === '.trash/a.md'),raw:'stale'}]));
});
test('offline purge survives reopen and applies only when folder reconnects', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root);
  let cached = new CachedVault(root,'offline-purge',persist);
  await disk.write('.trash/a.md','A'); const {notes} = await cached.scan(); root.permission = 'prompt';
  await cached.purgeTrash(notes); assert.equal((await cached.cached()).notes.length,0); assert.equal(await disk.read('.trash/a.md'),'A');
  cached = new CachedVault(root,'offline-purge',persist); assert.equal((await cached.scan()).notes.length,0);
  root.permission = 'granted'; await cached.scan(); await assert.rejects(disk.read('.trash/a.md')); assert.equal(cached.pending,0);
});
test('external edit blocks queued permanent deletion', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'conflict-purge',persist);
  await disk.write('.trash/a.md','A'); const {notes} = await cached.scan();
  root.permission = 'prompt'; await cached.purgeTrash(notes); await disk.write('.trash/a.md','Changed','A');
  root.permission = 'granted'; await cached.scan(); assert.ok(cached.error); assert.equal(await disk.read('.trash/a.md'),'Changed');
});
test('bulk restore resolves name collisions without overwriting and restores folders', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'restore',persist);
  await disk.write('folder/a.md','Existing');
  await disk.write('.trash/a.md',encode({title:'A',body:'A body',tags:['tag'],originalPath:'folder/a.md'}));
  await disk.write('.trash/b.md',encode({title:'B',body:'B body',tags:[],originalPath:'missing/sub/b.md'}));
  const {notes} = await cached.scan(); await cached.restoreTrash(notes.filter(n => n.path.startsWith('.trash/')));
  const result = await disk.scan(); assert.equal(cached.pending,0); assert.equal(result.notes.length,3);
  assert.equal(await disk.read('folder/a.md'),'Existing'); assert.ok(result.notes.find(n => n.title === 'A').path.includes('-восстановлено-'));
  assert.equal(result.notes.find(n => n.title === 'B').path,'missing/sub/b.md');
  assert.ok((await cached.cached()).folders.includes('missing/sub'));
});
function folderSnapshot(state,path) {
  return {notes:state.notes.filter(n => n.path.startsWith(path+'/')),folders:state.folders.filter(f => f === path || f.startsWith(path+'/'))};
}
test('folder removal trashes nested notes, removes directories and restores note paths', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'folder',persist);
  await disk.write('Работа/a.md',encode({title:'A',body:'one',tags:['a']}));
  await disk.write('Работа/Проект/b.md',encode({title:'B',body:'two',tags:['b']}));
  await disk.directory('Работа/Пустая',true); await disk.write('Работа2/keep.md','Keep');
  const state = await cached.scan(); const result = await cached.trashFolder('Работа',folderSnapshot(state,'Работа'));
  assert.equal(result.count,2); assert.equal(cached.pending,0); await assert.rejects(disk.directory('Работа'));
  assert.equal(await disk.read('Работа2/keep.md'),'Keep');
  const trashed = (await cached.scan()).notes.filter(n => n.path.startsWith('.trash/'));
  assert.equal(trashed.length,2); assert.deepEqual(new Set(trashed.map(n => n.originalPath)),new Set(['Работа/a.md','Работа/Проект/b.md']));
  await cached.restoreTrash(trashed);
  assert.equal(decode(await disk.read('Работа/Проект/b.md'),'b.md').body,'two');
});
test('offline folder deletion survives restart and restores before reconnect', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root);
  let cached = new CachedVault(root,'offline-folder',persist);
  await disk.write('F/sub/a.md','A'); const state = await cached.scan(); root.permission = 'prompt';
  await cached.trashFolder('F',folderSnapshot(state,'F'));
  cached = new CachedVault(root,'offline-folder',persist); const offline = await cached.scan();
  assert.ok(!offline.folders.includes('F')); assert.equal(await disk.read('F/sub/a.md'),'A');
  await cached.restoreTrash(offline.notes); root.permission = 'granted'; await cached.scan();
  assert.equal(cached.pending,0); assert.equal(decode(await disk.read('F/sub/a.md'),'a.md').body,'A');
});
test('folder removal preserves non-note files and newly added external notes', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'extra',persist);
  await disk.write('F/a.md','A'); await disk.write('F/image.png','Image bytes');
  const state = await cached.scan(); await disk.write('F/new.md','New external note');
  const result = await cached.trashFolder('F',folderSnapshot(state,'F'));
  assert.ok(result.warning); assert.equal(cached.pending,0);
  assert.equal(await disk.read('F/image.png'),'Image bytes'); assert.equal(await disk.read('F/new.md'),'New external note');
});
test('folder deletion rejects stale confirmation, root and trash without side effects', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'invalid-folder',persist);
  await disk.write('F/a.md','A'); const state = await cached.scan();
  await cached.write('F/b.md','B');
  await assert.rejects(cached.trashFolder('F',folderSnapshot(state,'F')));
  await assert.rejects(cached.trashFolder('',state)); await assert.rejects(cached.trashFolder('.trash',state));
  assert.equal(await disk.read('F/a.md'),'A'); assert.equal(await disk.read('F/b.md'),'B');
});
test('empty folders can be removed and missing cleanup directories can replay', async () => {
  const root = new Directory(), persist = persistence(), disk = new Vault(root), cached = new CachedVault(root,'empty-folder',persist);
  await disk.directory('Empty/Nested',true); const state = await cached.scan();
  await cached.trashFolder('Empty',folderSnapshot(state,'Empty')); await assert.rejects(disk.directory('Empty'));
  const saved = await cached.cached(); saved.outbox.push({type:'rmdir',path:'Empty/Nested'},{type:'rmdir',path:'Empty'});
  await persist('collection:empty-folder',saved); await cached.flush(); assert.equal(cached.pending,0); assert.equal(cached.error,null);
});
