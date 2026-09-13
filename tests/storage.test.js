import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Vault, encode, decode, safeName, parts, matches} from '../storage.js';
import {CachedVault} from '../cached-vault.js';
import {parseTags} from '../tags.js';

class Directory {
  kind = 'directory'; entriesMap = new Map(); permission = 'granted'; readPermission = null; missing = false;
  async queryPermission({mode} = {}) { return mode === 'read' && this.readPermission !== null ? this.readPermission : this.permission; }
  async getDirectoryHandle(name, {create} = {}) {
    if (!this.entriesMap.has(name) && create) this.entriesMap.set(name, new Directory());
    const result = this.entriesMap.get(name); if (!result) throw new DOMException('Missing','NotFoundError'); return result;
  }
  async getFileHandle(name, {create} = {}) {
    if (!this.entriesMap.has(name) && create) this.entriesMap.set(name, new File());
    const result = this.entriesMap.get(name); if (!result) throw new DOMException('Missing','NotFoundError'); return result;
  }
  async removeEntry(name) {
    const entry = this.entriesMap.get(name); if (!entry) throw new DOMException('Missing','NotFoundError');
    if (entry.kind === 'directory' && entry.entriesMap.size) throw new DOMException('Not empty','InvalidModificationError');
    this.entriesMap.delete(name);
  }
  async *entries() { if (this.missing) throw new DOMException('Missing','NotFoundError'); yield* this.entriesMap.entries(); }
}
class File {
  kind = 'file'; content = ''; fail = false;
  async getFile() { const text = this.content; return {text: async () => text, lastModified:1}; }
  async createWritable() { let pending; return {write: async text => { if (this.fail) throw Error('Disk full'); pending = text; }, close: async () => {this.content = pending;}, abort:async () => {}}; }
}
function persistence() {
  const data = new Map();
  return async (key,value) => {
    if (value !== undefined) data.set(key,structuredClone(value));
    return structuredClone(data.get(key));
  };
}

test('Markdown round trip preserves Unicode and metadata', () => {
  const note = {title:'', tags:['тег -->','<script>'], body:'\n# Привет\n- [ ] Дело\n', originalPath:'Работа/идея.md'};
  const decoded = decode(encode(note), 'test.md');
  for (const key of Object.keys(note)) assert.deepEqual(decoded[key],note[key]);
});
test('YAML frontmatter and prior metadata formats still load', () => {
  const note = {title:'Тестовая заметка 100% %20',tags:['тестовый_тег'],originalPath:null,body:'\nТекст\n'};
  const text = encode(note);
  assert.ok(text.startsWith('---\ntitle: "Тестовая заметка 100% %20"'));
  assert.ok(text.includes('тестовый_тег'));
  const legacy = `<!-- quiet-notes: ${encodeURIComponent(JSON.stringify({...note,body:undefined}))} -->\n${note.body}`;
  const flat = `## tags: ${JSON.stringify(note.tags)}\ntitle: ${JSON.stringify(note.title)}\n\n${note.body}`;
  const plainYaml = `---\ntitle: Тестовая заметка 100% %20\ntags: [тестовый_тег]\ncategory: Личное\nupdated: 2026-09-13\n---\n${note.body}`;
  for (const source of [text,legacy,flat,plainYaml,text.replaceAll('\n','\r\n')]) {
    const result = decode(source,'test.md');
    assert.equal(result.title,note.title); assert.deepEqual(result.tags,note.tags);
    assert.equal(result.body.replaceAll('\r\n','\n'),note.body);
  }
  const malicious = encode({...note,title:'--- <script>'});
  assert.equal(decode(malicious,'x.md').title,'--- <script>');
  const quoted = {...note,title:'Строка\n"с кавычками"',tags:['a\\b','"тег"']};
  assert.equal(decode(encode(quoted),'x.md').title,quoted.title);
  assert.deepEqual(decode(encode(quoted),'x.md').tags,quoted.tags);
  const invalid = '## tags: [oops]\ntitle: "x"\n\nbody';
  assert.equal(decode(invalid,'x.md').body,invalid);
});
test('adjacent external frontmatter blocks are merged and preserved on save', () => {
  const source = '---\ntitle: "Черновик"\ntags: [локальный]\n---\n---\ntype: cheatsheet\ntags: [testing, qa, development]\ncategory: "03_Саморазвитие"\nupdated: 2026-09-13\n---\n# Тест';
  const note = decode(source, 'test.md');
  assert.deepEqual(note.tags, ['testing', 'qa', 'development']);
  assert.equal(note.body, '# Тест');
  assert.equal(note.frontmatter.category, '"03_Саморазвитие"');
  const normalized = encode(note);
  assert.equal((normalized.match(/^---$/gm) || []).length, 2);
  assert.ok(normalized.includes('type: cheatsheet'));
  assert.ok(normalized.includes('tags: ["testing","qa","development"]'));
});
test('path traversal is rejected and Windows file names are safe', () => {
  for (const path of ['../x','a/../b','/root','a\\b','a//b']) assert.throws(() => parts(path));
  assert.equal(safeName('CON'), 'Заметка'); assert.equal(safeName('a:b?'), 'a-b-');
});
test('search finds title, body, tags and path', () => {
  const note = {title:'Планы', body:'Купить молоко', tags:['Дом'], path:'Быт/планы.md'};
  assert.ok(matches(note,'ДОМ молоко')); assert.ok(matches(note,'быт планы')); assert.ok(!matches(note,'работа'));
});
test('tags accept spaces, commas, newlines and optional # without duplicates', () => {
  assert.deepEqual(parseTags(' работа  #идеи,личное\nработа '),['работа','идеи','личное']);
});
test('notes remain available from Chrome storage when the archive disconnects', async () => {
  const root = new Directory(), vault = new CachedVault(root,'test',persistence());
  await vault.write('a.md',encode({title:'A',body:'stored in Chrome',tags:[]}));
  assert.equal((await vault.scan()).notes.length,1);
  root.permission = 'prompt';
  assert.equal((await vault.scan()).notes[0].body, 'stored in Chrome');
  await vault.write('b.md',encode({title:'B',body:'queued',tags:[]}));
  assert.equal((await vault.cached()).outbox.length, 1);
});

test('an archive is verified without replacing the Chrome collection', async () => {
  const root = new Directory(), vault = new CachedVault(root,'read-only',persistence());
  await vault.write('a.md',encode({title:'A',body:'on disk',tags:[]}));
  assert.equal((await vault.scan()).notes[0].title, 'A');
  assert.equal(vault.connected, true);
});

test('a deleted archive does not remove notes from Chrome storage', async () => {
  const root = new Directory(), vault = new CachedVault(root,'missing',persistence());
  await vault.write('a.md',encode({title:'A',body:'only in Chrome',tags:[]}));
  root.missing = true;
  assert.equal((await vault.scan()).notes[0].body, 'only in Chrome');
  assert.equal(vault.error?.name, 'NotFoundError');
  assert.equal(vault.archiveState, 'missing');
});
test('permission restoration synchronizes queued notes and becomes green', async () => {
  const root = new Directory(), persist = persistence();
  root.permission = 'prompt';
  let vault = new CachedVault(root,'reopen',persist);
  await vault.write('a.md','local text');
  assert.equal(vault.archiveState, 'permission');
  vault = new CachedVault(root,'reopen',persist);
  root.permission = 'granted';
  await vault.scan();
  assert.equal(await new Vault(root).read('a.md'),'local text');
  assert.equal(vault.pending,0);
  assert.equal(vault.archiveState,'connected');
});
test('replacement archive receives all notes even with an empty queue', async () => {
  const first = new Directory(), second = new Directory(), persist = persistence();
  const vault = new CachedVault(first,'replace',persist);
  await vault.write('folder/a.md','A');
  assert.equal(vault.pending,0);
  const replacement = new CachedVault(second,'replace',persist);
  await replacement.seedArchive();
  await replacement.scan();
  assert.equal(await new Vault(second).read('folder/a.md'),'A');
  assert.equal(replacement.archiveState,'connected');
});
test('external conflict is an archive error, not a missing directory', async () => {
  const root = new Directory(), vault = new CachedVault(root,'conflict',persistence());
  await vault.write('a.md','original');
  await new Vault(root).write('a.md','external','original');
  await vault.write('a.md','local','original');
  assert.equal(vault.archiveState,'error');
  assert.equal((await vault.cached()).notes[0].body,'local');
  assert.equal(await new Vault(root).read('a.md'),'external');
});
test('merge preserves archive files, deduplicates equal notes and keeps conflicting versions', async () => {
  const persist = persistence(), local = new CachedVault(null,'merge',persist);
  await local.write('same.md', 'same');
  await local.write('conflict.md', 'local');
  await local.write('only-local.md', 'local only');
  const root = new Directory(), disk = new Vault(root);
  await disk.write('same.md', 'same');
  await disk.write('conflict.md', 'archive');
  await disk.write('folder/import.md', 'import');
  const vault = new CachedVault(root,'merge',persist);
  await vault.mergeArchive(await disk.scan());
  await vault.flush();
  assert.equal(vault.archiveState,'connected');
  const state = await vault.cached();
  assert.equal(state.notes.length,5);
  assert.equal(await disk.read('conflict.md'),'archive');
  assert.equal(await disk.read('same.md'),'same');
  assert.equal(await disk.read('only-local.md'),'local only');
  assert.equal(decode(await disk.read('conflict (браузерная копия).md'),'x.md').body,'local');
  assert.ok(state.folders.includes('folder'));
  await vault.mergeArchive(await disk.scan());
  assert.equal((await vault.cached()).notes.length,5);
});
test('scan imports new archive notes and folders once, preserving local edits', async () => {
  const root = new Directory(), persist = persistence(), vault = new CachedVault(root,'import',persist), disk = new Vault(root);
  await vault.write('a.md','original');
  await disk.write('a.md','external','original');
  await disk.write('nested/manual.md','# Written by hand');
  await disk.directory('empty',true);
  await vault.write('a.md','local draft','original');
  const state = await vault.scan();
  assert.equal(state.notes.find(n => n.path === 'a.md').body,'local draft');
  assert.equal(state.notes.find(n => n.path === 'nested/manual.md').body,'# Written by hand');
  assert.ok(state.folders.includes('empty'));
  assert.equal((await vault.scan()).notes.length,2);
  assert.equal(await disk.read('a.md'),'external');
});
test('scan does not resurrect notes with queued deletions behind an archive conflict', async () => {
  const root = new Directory(), persist = persistence(), vault = new CachedVault(root,'queued-import',persist), disk = new Vault(root);
  await vault.write('a.md','original'); await vault.write('b.md','delete me');
  const b = (await vault.cached()).notes.find(n => n.path === 'b.md');
  await disk.write('a.md','external','original');
  await vault.write('a.md','local','original');
  await vault.move(b,'.trash/b.md',{originalPath:'b.md'});
  assert.equal((await vault.scan()).notes.some(n => n.path === 'b.md'),false);
});
test('title-based filenames rename safely and preserve collisions and offline edits', async () => {
  const root = new Directory(), vault = new CachedVault(root,'named',persistence()), disk = new Vault(root);
  const a = await vault.saveNamed({title:'План',body:'first',tags:[]},'Работа');
  assert.equal(a.path,'Работа/План.md');
  const b = await vault.saveNamed({title:'План',body:'second',tags:[]},'Работа');
  assert.equal(b.path,'Работа/План (2).md');
  assert.equal((await vault.saveNamed({...b,body:'edit'},'Работа')).path,b.path);
  await disk.write('Работа/Итоги.md','external');
  const renamed = await vault.saveNamed({...a,title:'Итоги',body:'updated'},'Работа');
  assert.equal(renamed.path,'Работа/Итоги (2).md');
  assert.equal(await disk.read('Работа/Итоги.md'),'external');
  await assert.rejects(disk.read(a.path));
  root.permission = 'prompt';
  const offline = await vault.saveNamed({...renamed,title:'Архив'},'Работа');
  assert.equal(offline.path,'Работа/Архив.md');
  root.permission = 'granted'; await vault.scan();
  assert.equal(decode(await disk.read(offline.path),offline.path).body,'updated');
  assert.equal(vault.pending,0);
});
test('external deletions remove folders and put previously archived notes in trash', async () => {
  const root = new Directory(), vault = new CachedVault(root,'external-delete',persistence()), disk = new Vault(root);
  await vault.write('folder/a.md','saved'); await vault.scan();
  await (await disk.directory('folder')).removeEntry('a.md'); await root.removeEntry('folder');
  const state = await vault.scan();
  assert.equal(vault.archiveState,'connected');
  assert.equal(state.notes.some(n => n.path === 'folder/a.md'),false);
  assert.equal(state.folders.includes('folder'),false);
  assert.equal(state.notes.find(n => n.originalPath === 'folder/a.md').body,'saved');
  assert.equal((await vault.scan()).notes.length,1);
});
test('deleted archive file with pending local writes is recovered without recreating the old file', async () => {
  const root = new Directory(), vault = new CachedVault(root,'delete-dirty',persistence()), disk = new Vault(root);
  await vault.write('Legends.md','old'); await vault.scan();
  root.permission = 'prompt'; await vault.write('Legends.md','my edits','old');
  await root.removeEntry('Legends.md'); root.permission = 'granted';
  const state = await vault.scan();
  assert.equal(vault.archiveState,'connected'); assert.equal(vault.pending,0);
  assert.equal(state.notes.length,1); assert.equal(state.notes[0].body,'my edits');
  assert.match(state.notes[0].path,/браузерная копия/);
  await assert.rejects(disk.read('Legends.md'));
});
test('a protected unsaved editor note survives an external deletion until saved', async () => {
  const root = new Directory(), vault = new CachedVault(root,'protected',persistence());
  await vault.write('a.md','text'); await vault.scan(); await root.removeEntry('a.md');
  assert.equal((await vault.scan(['a.md'])).notes[0].path,'a.md');
  assert.equal((await vault.scan()).notes[0].originalPath,'a.md');
});
test('replacement keeps only archive data and discards the old outbox and trash', async () => {
  const persist = persistence(), local = new CachedVault(null,'replace-only',persist);
  await local.write('old.md','browser'); await local.write('.trash/old.md','old trash');
  const root = new Directory(), disk = new Vault(root);
  await disk.write('folder/new.md','archive'); await disk.write('.trash/new.md','archive trash');
  const replacement = new CachedVault(root,'replace-only',persist);
  await replacement.replaceFromArchive();
  const state = await replacement.scan();
  assert.deepEqual(state.notes.map(n => n.path).sort(),['.trash/new.md','folder/new.md']);
  assert.deepEqual(state.outbox,[]);
  await assert.rejects(disk.read('old.md'));
  assert.equal(await disk.read('folder/new.md'),'archive');
});
test('replacement read failure preserves the entire browser collection', async () => {
  const persist = persistence(), local = new CachedVault(null,'replace-fail',persist);
  await local.write('draft.md','important');
  const before = await local.cached(), root = new Directory(); root.missing = true;
  await assert.rejects(new CachedVault(root,'replace-fail',persist).replaceFromArchive());
  assert.deepEqual(await local.cached(),before);
});
test('trash restore and permanent deletion operate directly in the selected folder', async () => {
  const root = new Directory(), disk = new Vault(root), vault = new CachedVault(root,'trash',persistence());
  await vault.write('.trash/a.md',encode({title:'A',body:'body',tags:[],originalPath:'folder/a.md'}));
  await vault.restoreTrash((await vault.scan()).notes);
  assert.equal(decode(await disk.read('folder/a.md'),'folder/a.md').body,'body');
  const note = (await vault.scan()).notes[0];
  await vault.move(note, '.trash/a.md', {originalPath:'folder/a.md'});
  await vault.purgeTrash((await vault.scan()).notes);
  await assert.rejects(disk.read('.trash/a.md'));
});
