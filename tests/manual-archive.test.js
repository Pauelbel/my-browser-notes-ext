import {test} from 'node:test';
import assert from 'node:assert/strict';
import {archiveAll} from '../manual-archive.js';
import {CachedVault} from '../cached-vault.js';
import {encode} from '../storage.js';

class Directory {
  entries = new Map();
  fail = false;
  async getDirectoryHandle(name, {create} = {}) {
    if (!this.entries.has(name) && create) this.entries.set(name, Object.assign(new Directory(), {fail:this.fail}));
    if (!this.entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
    return this.entries.get(name);
  }
  async getFileHandle(name, {create} = {}) {
    if (!this.entries.has(name) && create) this.entries.set(name, {
      text:'',
      getFile: async function() { return {text:async () => this.text}; },
      createWritable: async () => {
        let text;
        return {write:async value => { if (this.fail) throw Error('Disk full'); text = value; },
          close:async () => { this.entries.get(name).text = text; }, abort:async () => {}};
      }
    });
    if (!this.entries.has(name)) throw new DOMException('Missing', 'NotFoundError');
    return this.entries.get(name);
  }
}
const snapshot = () => ({folders:['','empty','work/nested','00_Inbox','_System'], notes:[
  {path:'00_Inbox/inbox.md', raw:'---\ntags: [test]\n---\nInbox'},
  {path:'_System/index.md', raw:'# Index\n[[work/nested/note]]'},
  {path:'work/nested/note.md', raw:'# Note\n![Image](data:image/png;base64,AAAA)'},
  {path:'.trash/deleted.md', raw:'---\noriginalPath: "old.md"\n---\nDeleted'}
]});
test('exports all folders, Inbox, system notes and trash with exact Markdown; keeps existing archives', async () => {
  const root = new Directory(), source = snapshot(), before = structuredClone(source);
  root.entries.set('existing.md', {text:'untouched'});
  const first = await archiveAll(root,source), second = await archiveAll(root,source);
  assert.notEqual(first.name,second.name);
  assert.equal(first.count,4);
  const dir = root.entries.get(first.name);
  assert.ok(dir.entries.has('empty'));
  assert.equal(dir.entries.get('00_Inbox').entries.get('inbox.md').text, source.notes[0].raw);
  assert.equal(dir.entries.get('_System').entries.get('index.md').text, source.notes[1].raw);
  assert.equal(dir.entries.get('work').entries.get('nested').entries.get('note.md').text, source.notes[2].raw);
  assert.equal(dir.entries.get('.trash').entries.get('deleted.md').text, source.notes[3].raw);
  assert.equal(root.entries.get('existing.md').text, 'untouched');
  assert.deepEqual(source,before);
});
test('failed archive is reported as incomplete and leaves source untouched', async () => {
  const root = new Directory(); root.fail = true;
  const source = snapshot(), before = structuredClone(source);
  await assert.rejects(archiveAll(root,source), /Архив не завершён.*Disk full/);
  assert.deepEqual(source,before);
});
test('invalid paths are rejected before writing', async () => {
  const root = new Directory();
  await assert.rejects(archiveAll(root,{folders:[],notes:[{path:'../outside.md',raw:'x'}]}), /Недопустимый путь/);
  assert.equal(root.entries.size,0);
});
test('local-only migration preserves collection and never accesses former archive or queues writes', async () => {
  let stored = {...snapshot(),outbox:[{type:'delete',path:'external.md'}]};
  const persist = async (_,value) => { if (value !== undefined) stored = structuredClone(value); return structuredClone(stored); };
  const oldRoot = {queryPermission() { throw Error('Must never access disk'); }};
  const vault = new CachedVault(oldRoot,'previous-id',persist,{localOnly:true});
  assert.equal(vault.key,'collection:previous-id');
  await vault.persist(vault.key,await vault.state());
  assert.deepEqual(stored.notes,snapshot().notes);
  assert.deepEqual(stored.folders,snapshot().folders);
  assert.deepEqual(stored.outbox,[]);
  await vault.write('new.md',encode({title:'New',body:'hello'}));
  await vault.directory('another-empty-folder',true);
  const result = await vault.scan();
  assert.equal(result.notes.length,5);
  assert.ok(result.folders.includes('another-empty-folder'));
  assert.deepEqual(stored.outbox,[]);
  assert.equal(vault.pending,0);
});
