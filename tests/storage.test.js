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
  assert.equal(decode(await disk.read('conflict (локальная версия).md'),'x.md').body,'local');
  assert.ok(state.folders.includes('folder'));
  await vault.mergeArchive(await disk.scan());
  assert.equal((await vault.cached()).notes.length,5);
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
