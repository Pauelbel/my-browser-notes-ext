import {Vault, encode, decode, parts, setting} from './storage.js';

// The durable outbox is committed before touching disk. Each step is replay-safe
// if the panel closes between a disk write and the IndexedDB acknowledgement.
export class CachedVault {
  constructor(root, id, persist = setting) {
    this.root = root; this.disk = new Vault(root); this.key = `collection:${id}`;
    this.persist = persist; this.pending = 0; this.error = null; this.connected = false; this.warning = null;
  }
  async state() { return await this.persist(this.key) || {notes:[], folders:[''], outbox:[]}; }
  async cached() { const state = await this.state(); this.pending = state.outbox.length; return state; }
  async permission() { return await this.root.queryPermission({mode:'readwrite'}) === 'granted'; }
  async flush() {
    this.error = null; this.warning = null;
    const state = await this.state(); this.pending = state.outbox.length;
    this.connected = await this.permission();
    if (!this.connected) return;
    try {
      while (state.outbox.length) {
        const op = state.outbox[0];
        if (op.type === 'mkdir') await this.disk.directory(op.path, true);
        else if (op.type === 'rmdir') {
          // Never recursively delete a directory: files created externally or
          // non-note files must survive. Missing directories are replay-safe.
          try {
            const segments = parts(op.path), name = segments.pop();
            await (await this.disk.directory(segments.join('/'))).removeEntry(name);
          } catch (error) {
            if (error.name === 'InvalidModificationError') this.warning = 'Заметки перемещены в корзину. Папки с другими файлами сохранены на диске.';
            else if (error.name !== 'NotFoundError') throw error;
          }
        }
        else {
          let actual;
          try { actual = await this.disk.read(op.path); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
          if (op.type === 'write') {
            if (actual !== op.text) {
              if (actual !== op.expected) throw Error(`Файл «${op.path}» изменён вне приложения. Локальная версия сохранена; синхронизация остановлена, чтобы не затереть изменения.`);
              await this.disk.write(op.path, op.text, actual);
            }
          } else if (actual !== undefined) {
            if (actual !== op.expected) throw Error(`Файл «${op.path}» изменился. Удаление с диска остановлено, чтобы сохранить внешние изменения.`);
            if (op.copyPath && await this.disk.read(op.copyPath) !== op.copyText) throw Error('Копия изменилась до завершения переноса. Исходный файл сохранён.');
            const segments = parts(op.path), name = segments.pop();
            await (await this.disk.directory(segments.join('/'))).removeEntry(name);
          }
        }
        state.outbox.shift(); await this.persist(this.key, state); this.pending = state.outbox.length;
      }
    } catch (error) { this.error = error; }
  }
  async scan() {
    await this.flush();
    if (this.connected && !this.pending) {
      try {
        const result = await this.disk.scan();
        await this.persist(this.key, {...result, outbox:[]}); return result;
      } catch (error) { this.error = error; }
    }
    return this.cached();
  }
  async write(path, text, expected) {
    parts(path);
    const state = await this.state(), old = state.notes.find(n => n.path === path);
    if (old?.raw !== expected) throw Error('Заметка изменилась в другом окне. Обновите список; ваш черновик сохранён.');
    const note = {...decode(text,path), modified:Date.now()};
    state.notes = state.notes.filter(n => n.path !== path).concat(note);
    state.outbox.push({type:'write',path,text,expected});
    await this.persist(this.key,state); await this.flush();
  }
  async directory(path, create) {
    if (!create) return this.disk.directory(path);
    parts(path); const state = await this.state();
    if (!state.folders.includes(path)) {
      state.folders.push(path); state.outbox.push({type:'mkdir',path}); await this.persist(this.key,state);
    }
    await this.flush();
  }
  async move(note, destination, changes = {}) {
    parts(destination); const state = await this.state();
    if (state.notes.some(n => n.path === destination)) throw Error('Файл с таким именем уже существует.');
    if (state.notes.find(n => n.path === note.path)?.raw !== note.raw) throw Error('Заметка изменилась в другом окне. Обновите список.');
    const text = encode({...note,...changes});
    state.notes = state.notes.filter(n => n.path !== note.path).concat({...decode(text,destination),modified:Date.now()});
    state.outbox.push({type:'write',path:destination,text}, {type:'delete',path:note.path,expected:note.raw,copyPath:destination,copyText:text});
    await this.persist(this.key,state); await this.flush();
  }
  async trashFolder(path, expected) {
    parts(path);
    if (path.split('/')[0].toLowerCase() === '.trash') throw Error('Нельзя удалить служебную корзину.');
    const state = await this.state(), inside = value => value === path || value.startsWith(path + '/');
    if (!state.folders.includes(path)) throw Error('Папка больше не существует. Обновите список.');
    const affectedNotes = state.notes.filter(n => n.path.startsWith(path + '/'));
    const affectedFolders = state.folders.filter(inside);
    if (!expected || affectedNotes.length !== expected.notes.length || affectedFolders.length !== expected.folders.length ||
      affectedNotes.some(n => !expected.notes.some(old => old.path === n.path && old.raw === n.raw)) ||
      affectedFolders.some(folder => !expected.folders.includes(folder))) {
      throw Error('Содержимое папки изменилось. Откройте подтверждение заново.');
    }
    const trashed = [];
    for (const note of affectedNotes) {
      const destination = `.trash/${crypto.randomUUID()}.md`;
      const text = encode({...note, originalPath:note.path});
      trashed.push({...decode(text,destination),modified:Date.now()});
      state.outbox.push({type:'write',path:destination,text}, {type:'delete',path:note.path,expected:note.raw,copyPath:destination,copyText:text});
    }
    state.notes = state.notes.filter(n => !n.path.startsWith(path + '/')).concat(trashed);
    state.folders = state.folders.filter(folder => !inside(folder));
    // Children before parents, after all note copies have been verified.
    state.outbox.push(...affectedFolders.sort((a,b) => b.split('/').length-a.split('/').length).map(folder => ({type:'rmdir',path:folder})));
    await this.persist(this.key,state); await this.flush();
    return {count:affectedNotes.length, warning:this.warning};
  }
  validateTrash(state, selected) {
    const paths = new Set();
    for (const note of selected) {
      parts(note.path);
      if (!note.path.startsWith('.trash/')) throw Error('Эта операция доступна только для заметок в корзине.');
      if (paths.has(note.path)) throw Error('Заметка выбрана дважды.');
      paths.add(note.path);
      if (!state.notes.some(n => n.path === note.path && n.raw === note.raw)) throw Error('Корзина изменилась в другом окне. Обновите список и повторите выбор.');
    }
  }
  async purgeTrash(selected) {
    const state = await this.state(); this.validateTrash(state, selected);
    const paths = new Set(selected.map(n => n.path));
    state.notes = state.notes.filter(n => !paths.has(n.path));
    state.outbox.push(...selected.map(n => ({type:'delete',path:n.path,expected:n.raw})));
    await this.persist(this.key,state); await this.flush();
  }
  async restoreTrash(selected) {
    const state = await this.state(); this.validateTrash(state, selected);
    const occupied = new Set(state.notes.map(n => n.path));
    for (const note of selected) {
      let destination = note.originalPath || `Восстановленная-${crypto.randomUUID()}.md`;
      parts(destination);
      if (destination.startsWith('.trash/')) throw Error('Некорректный путь восстановления.');
      if (occupied.has(destination)) destination = destination.replace(/\.md$/i,'') + `-восстановлено-${crypto.randomUUID()}.md`;
      occupied.add(destination);
      const text = encode({...note,originalPath:null});
      state.notes = state.notes.filter(n => n.path !== note.path).concat({...decode(text,destination),modified:Date.now()});
      const segments = parts(destination); segments.pop();
      for (let count = 1; count <= segments.length; count++) {
        const folder = segments.slice(0,count).join('/');
        if (!state.folders.includes(folder)) state.folders.push(folder);
      }
      state.outbox.push({type:'write',path:destination,text}, {type:'delete',path:note.path,expected:note.raw,copyPath:destination,copyText:text});
    }
    await this.persist(this.key,state); await this.flush();
  }
}
