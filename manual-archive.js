import {encode, parts, Vault} from './storage.js';

// Every export owns a new directory. Existing archives are never overwritten.
export async function archiveAll(root, snapshot, now = new Date()) {
  const notes = snapshot.notes.map(note => ({path:note.path, text:note.raw ?? encode(note)}));
  const folders = new Set(snapshot.folders.filter(Boolean));
  for (const note of notes) {
    const segments = parts(note.path);
    segments.pop();
    if (segments.length) folders.add(segments.join('/'));
  }
  for (const folder of folders) parts(folder);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const name = `Заметки-${stamp}-${crypto.randomUUID().slice(0,8)}`;
  const destination = await root.getDirectoryHandle(name, {create:true});
  const disk = new Vault(destination);
  try {
    for (const folder of folders) await disk.directory(folder, true);
    for (const note of notes) {
      const file = await disk.handle(note.path, true);
      const stream = await file.createWritable();
      try { await stream.write(note.text); await stream.close(); }
      catch (error) { try { await stream.abort(); } catch {} throw error; }
      if (await (await file.getFile()).text() !== note.text) throw Error(`Не удалось проверить файл «${note.path}».`);
    }
    return {name, count:notes.length};
  } catch (error) {
    throw new Error(`Архив не завершён. В папке «${name}» может быть неполная копия. Заметки в расширении сохранены. ${error.message || error}`, {cause:error});
  }
}
