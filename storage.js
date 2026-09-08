const PREFIX = '<!-- quiet-notes: ';
export function encode(note) {
  const meta = {title: note.title, tags: note.tags, originalPath: note.originalPath || null};
  return `${PREFIX}${encodeURIComponent(JSON.stringify(meta))} -->\n${note.body}`;
}
export function decode(text, path) {
  let meta = {}, body = text;
  if (text.startsWith(PREFIX)) {
    const end = text.indexOf(' -->\n');
    if (end !== -1) {
      try {
        const parsed = JSON.parse(decodeURIComponent(text.slice(PREFIX.length, end)));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { meta = parsed; body = text.slice(end + 5); }
      } catch {}
    }
  }
  return {path, title: typeof meta.title === 'string' ? meta.title : path.split('/').pop().replace(/\.md$/i, ''),
    tags: Array.isArray(meta.tags) ? meta.tags.filter(t => typeof t === 'string') : [],
    originalPath: typeof meta.originalPath === 'string' ? meta.originalPath : null, body, raw: text};
}
export function safeName(value) {
  let name = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 70);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = 'Заметка';
  return name;
}
export function parts(path) {
  const result = path.split('/');
  if (result.some(p => !p || p === '.' || p === '..' || /[\\\x00]/.test(p))) throw new Error('Недопустимый путь');
  return result;
}
export class Vault {
  constructor(root) { this.root = root; }
  async directory(path, create = false) {
    let dir = this.root;
    if (path) for (const segment of parts(path)) dir = await dir.getDirectoryHandle(segment, {create});
    return dir;
  }
  async handle(path, create = false) {
    const segments = parts(path), name = segments.pop();
    return (await this.directory(segments.join('/'), create)).getFileHandle(name, {create});
  }
  async read(path) { return (await (await this.handle(path)).getFile()).text(); }
  async scan() {
    const notes = [], folders = [''];
    const walk = async (dir, prefix = '') => {
      for await (const [name, entry] of dir.entries()) {
        const path = prefix + name;
        if (entry.kind === 'directory') {
          if (name.startsWith('.') && path !== '.trash') continue;
          if (!path.startsWith('.trash')) folders.push(path);
          await walk(entry, path + '/');
        } else if (/\.md$/i.test(name)) {
          const file = await entry.getFile();
          notes.push({...decode(await file.text(), path), modified: file.lastModified});
        }
      }
    };
    await walk(this.root);
    return {notes, folders: folders.sort((a,b) => a.localeCompare(b, 'ru'))};
  }
  async write(path, text, expected) {
    // Existing files are never silently overwritten after an external edit.
    if (expected !== undefined) {
      if (await this.read(path) !== expected) throw new Error('Файл изменён другим приложением. Черновик сохранён в браузере. Обновите список и сохраните черновик отдельной заметкой.');
    } else {
      try { await this.handle(path); } catch (e) { if (e.name !== 'NotFoundError') throw e; return this.writeNew(path, text); }
      throw new Error('Файл с таким именем уже существует');
    }
    await this.writeNew(path, text);
  }
  async writeNew(path, text) {
    const stream = await (await this.handle(path, true)).createWritable();
    try { await stream.write(text); await stream.close(); } catch (error) { try { await stream.abort(); } catch {} throw error; }
  }
  async move(note, destination, changes = {}) {
    if (await this.read(note.path) !== note.raw) throw new Error('Файл изменился. Сначала обновите список.');
    const text = encode({...note, ...changes});
    await this.write(destination, text);
    if (await this.read(destination) !== text) throw new Error('Не удалось проверить копию. Исходный файл сохранён.');
    // Recheck before removing: edits during copying must not be lost.
    if (await this.read(note.path) !== note.raw) throw new Error('Исходный файл изменился при переносе. Обе копии сохранены.');
    const segments = parts(note.path), name = segments.pop();
    await (await this.directory(segments.join('/'))).removeEntry(name);
  }
}
export function matches(note, query) {
  const haystack = `${note.title}\n${note.body}\n${note.tags.join(' ')}\n${note.path}`.toLocaleLowerCase('ru');
  return query.toLocaleLowerCase('ru').trim().split(/\s+/).every(word => haystack.includes(word));
}
export async function setting(key, value) {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('quiet-notes', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('settings');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('settings', value === undefined ? 'readonly' : 'readwrite');
      const req = value === undefined ? tx.objectStore('settings').get(key) : tx.objectStore('settings').put(value, key);
      tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
