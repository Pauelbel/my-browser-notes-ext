import {Vault, encode, decode, parts, setting} from './storage.js';

// Notes live in IndexedDB. A selected folder is an optional, asynchronous
// Markdown archive: a missing or disconnected folder never blocks the editor.
export class CachedVault {
  constructor(root, id = 'local', persist = setting) {
    this.root = root || null;
    this.disk = this.root ? new Vault(this.root) : null;
    this.key = `collection:${id}`;
    this.persist = persist;
    this.pending = 0; this.error = null; this.connected = false; this.warning = null;
    this.archiveState = root ? 'permission' : 'unconfigured';
  }
  async state() { return await this.persist(this.key) || {notes:[], folders:[''], outbox:[]}; }
  async cached() { const state = await this.state(); this.pending = state.outbox.length; return state; }
  async bootstrapFromArchive() {
    const state = await this.state();
    if (state.initialized || state.notes.length || state.folders.length > 1 || !await this.permission()) return false;
    try {
      const imported = await this.disk.scan();
      await this.persist(this.key, {...imported, outbox:[], initialized:true});
      return true;
    } catch (error) { this.error = error; return false; }
  }
  async permission() {
    if (!this.root) return false;
    try { return await this.root.queryPermission({mode:'readwrite'}) === 'granted'; }
    catch (error) { this.error = error; return false; }
  }
  async flush() {
    this.error = null; this.warning = null;
    const state = await this.state(); this.pending = state.outbox.length;
    this.connected = await this.permission();
    if (!this.connected) {
      this.archiveState = this.root ? 'permission' : 'unconfigured';
      return;
    }
    // Check the root itself before interpreting a missing note as a new file.
    try {
      for await (const entry of this.root.entries()) { break; }
    } catch (error) {
      this.connected = false; this.error = error;
      this.archiveState = error.name === 'NotFoundError' ? 'missing' : 'error';
      return;
    }
    this.archiveState = 'syncing';
    try {
      while (state.outbox.length) {
        const op = state.outbox[0];
        if (op.type === 'mkdir') await this.disk.directory(op.path, true);
        else if (op.type === 'rmdir') {
          try {
            const segments = parts(op.path), name = segments.pop();
            await (await this.disk.directory(segments.join('/'))).removeEntry(name);
          } catch (error) {
            if (error.name === 'InvalidModificationError') this.warning = 'Заметки сохранены в архиве, но папки с другими файлами оставлены на диске.';
            else if (error.name !== 'NotFoundError') throw error;
          }
        } else {
          let actual;
          try { actual = await this.disk.read(op.path); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
          if (op.type === 'write') {
            if (actual !== op.text) {
              if (actual !== op.expected) throw Error(`Файл «${op.path}» изменён вне заметок. Архив не перезаписан.`);
              await this.disk.write(op.path, op.text, actual);
            }
          } else if (actual !== undefined) {
            if (actual !== op.expected) throw Error(`Файл «${op.path}» изменён вне заметок. Удаление из архива остановлено.`);
            const segments = parts(op.path), name = segments.pop();
            await (await this.disk.directory(segments.join('/'))).removeEntry(name);
          }
        }
        state.outbox.shift(); await this.persist(this.key, state); this.pending = state.outbox.length;
      }
      this.archiveState = 'connected';
    } catch (error) { this.error = error; this.archiveState = 'error'; }
  }
  async scan() {
    await this.flush();
    return this.cached();
  }
  async seedArchive() {
    // A replacement folder needs all notes, including those already archived
    // elsewhere. Do not replay deletions belonging to the previous folder.
    const state = await this.state();
    state.outbox = state.folders.filter(Boolean).map(path => ({type:'mkdir',path}))
      .concat(state.notes.map(note => ({type:'write',path:note.path,text:note.raw})));
    await this.persist(this.key, state);
  }
  async mergeArchive(imported) {
    const state = await this.state();
    const occupied = new Set([...state.notes, ...imported.notes].map(note => note.path.toLocaleLowerCase('ru')));
    const merged = [...imported.notes];
    const identity = note => JSON.stringify([note.title, note.body, [...note.tags].sort(), note.originalPath || null]);
    let conflicts = 0;
    for (const local of state.notes) {
      const archived = imported.notes.find(note => note.path.toLocaleLowerCase('ru') === local.path.toLocaleLowerCase('ru'));
      if (!archived) { merged.push(local); continue; }
      if (identity(local) === identity(archived)) continue;
      // Preserve existing archive bytes; put the local version in a new file.
      const stem = local.path.replace(/\.md$/i, '');
      let index = 1, path;
      do { path = `${stem} (локальная версия${index === 1 ? '' : ' ' + index}).md`; index++; }
      while (occupied.has(path.toLocaleLowerCase('ru')));
      occupied.add(path.toLocaleLowerCase('ru'));
      const raw = encode({...local, title: `${local.title} (локальная версия)`});
      merged.push({...decode(raw, path), modified:local.modified}); conflicts++;
    }
    state.notes = merged;
    state.folders = [...new Set([...state.folders, ...imported.folders])];
    state.initialized = true;
    state.outbox = state.folders.filter(Boolean).map(path => ({type:'mkdir', path}))
      .concat(merged.filter(note => !imported.notes.some(item => item.path === note.path))
        .map(note => ({type:'write', path:note.path, text:note.raw})));
    await this.persist(this.key, state);
    return {conflicts};
  }
  async write(path, text, expected) {
    parts(path);
    const state = await this.state(), old = state.notes.find(note => note.path === path);
    if (old && old.raw !== expected) throw Error('Заметка изменилась в другом окне. Обновите список; черновик сохранён в браузере.');
    state.initialized = true;
    state.notes = state.notes.filter(note => note.path !== path).concat({...decode(text,path), modified:Date.now()});
    state.outbox.push({type:'write', path, text, expected:old?.raw});
    await this.persist(this.key, state); await this.flush();
  }
  async directory(path, create) {
    if (!create) return this.disk?.directory(path);
    parts(path); const state = await this.state();
    if (!state.folders.includes(path)) { state.folders.push(path); state.outbox.push({type:'mkdir',path}); await this.persist(this.key,state); }
    await this.flush();
  }
  async move(note, destination, changes = {}) {
    parts(destination); const state = await this.state();
    if (state.notes.some(value => value.path === destination)) throw Error('Заметка с таким именем уже существует.');
    if (state.notes.find(value => value.path === note.path)?.raw !== note.raw) throw Error('Заметка изменилась в другом окне. Обновите список.');
    const text = encode({...note,...changes});
    state.notes = state.notes.filter(value => value.path !== note.path).concat({...decode(text,destination),modified:Date.now()});
    state.outbox.push({type:'write',path:destination,text,expected:undefined}, {type:'delete',path:note.path,expected:note.raw});
    await this.persist(this.key,state); await this.flush();
  }
  async trashFolder(path, expected) {
    parts(path);
    const state = await this.state(), inside = value => value === path || value.startsWith(path + '/');
    const affectedNotes = state.notes.filter(note => note.path.startsWith(path + '/'));
    const affectedFolders = state.folders.filter(inside);
    if (!expected || affectedNotes.length !== expected.notes.length || affectedFolders.length !== expected.folders.length) throw Error('Содержимое папки изменилось. Откройте подтверждение заново.');
    const trashed = [];
    for (const note of affectedNotes) {
      const destination = `.trash/${crypto.randomUUID()}.md`, text = encode({...note,originalPath:note.path});
      trashed.push({...decode(text,destination),modified:Date.now()});
      state.outbox.push({type:'write',path:destination,text,expected:undefined},{type:'delete',path:note.path,expected:note.raw});
    }
    state.notes = state.notes.filter(note => !note.path.startsWith(path + '/')).concat(trashed);
    state.folders = state.folders.filter(folder => !inside(folder));
    state.outbox.push(...affectedFolders.sort((a,b) => b.split('/').length-a.split('/').length).map(path => ({type:'rmdir',path})));
    await this.persist(this.key,state); await this.flush();
    return {count:affectedNotes.length, warning:this.warning};
  }
  async restoreTrash(selected) {
    const state = await this.state();
    for (const note of selected) {
      let destination = note.originalPath || `Восстановленная-${crypto.randomUUID()}.md`;
      if (state.notes.some(value => value.path === destination)) destination = destination.replace(/\.md$/i,'') + `-восстановлено-${crypto.randomUUID()}.md`;
      const text = encode({...note,originalPath:null});
      state.notes = state.notes.filter(value => value.path !== note.path).concat({...decode(text,destination),modified:Date.now()});
      state.outbox.push({type:'write',path:destination,text,expected:undefined},{type:'delete',path:note.path,expected:note.raw});
    }
    await this.persist(this.key,state); await this.flush();
  }
  async purgeTrash(selected) {
    const state = await this.state(), paths = new Set(selected.map(note => note.path));
    state.notes = state.notes.filter(note => !paths.has(note.path));
    state.outbox.push(...selected.map(note => ({type:'delete',path:note.path,expected:note.raw})));
    await this.persist(this.key,state); await this.flush();
  }
}
