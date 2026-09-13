import {setting} from './storage.js';
import {OpenAICompatibleProvider} from './llm-provider.js';

const INBOX = '00_Inbox', SOURCES = '90_Источники', INDEX = '_System/index.md';
const safePath = path => typeof path === 'string' && path && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part));
const inboxPath = path => path === INBOX || path.startsWith(`${INBOX}/`);
const log = (level, text) => ({time:new Date().toISOString(), level, text});

async function setStatus(state, message, entry) {
  const previous = await setting('llm-status') || {entries:[]};
  const entries = entry ? [...previous.entries, entry].slice(-10) : previous.entries || [];
  await setting('llm-status', {state, message, entries, updated:Date.now()});
}
async function directory(root, path, create = false) {
  let current = root;
  for (const part of path.split('/').filter(Boolean)) current = await current.getDirectoryHandle(part, {create});
  return current;
}
async function fileHandle(root, path, create = false) {
  const parts = path.split('/'), name = parts.pop();
  return (await directory(root, parts.join('/'), create)).getFileHandle(name, {create});
}
async function getFile(root, path) { try { return await (await fileHandle(root,path)).getFile(); } catch (error) { if (error.name === 'NotFoundError') return null; throw error; } }
async function readText(root, path) { const file = await getFile(root,path); return file ? file.text() : null; }
async function writeText(root, path, text) { const stream = await (await fileHandle(root,path,true)).createWritable(); try { await stream.write(text); await stream.close(); } catch (error) { try { await stream.abort(); } catch {} throw error; } }
async function writeBlob(root, path, blob) { const stream = await (await fileHandle(root,path,true)).createWritable(); try { await stream.write(blob); await stream.close(); } catch (error) { try { await stream.abort(); } catch {} throw error; } }
async function remove(root, path) { const parts = path.split('/'), name = parts.pop(); await (await directory(root,parts.join('/'))).removeEntry(name, {recursive:true}); }
async function hash(file) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(v => v.toString(16).padStart(2,'0')).join(''); }
const fingerprint = async files => JSON.stringify((await Promise.all(files.map(async item => [item.path,await hash(item.file)]))).sort((a,b) => a[0].localeCompare(b[0])));
// File System Access File objects can become unreadable after a disk write.
// Read bytes before asking the model, and verify against detached snapshots.
export async function snapshotInbox(files) {
  return Promise.all(files.map(async item => ({...item, file:new Blob([await item.file.arrayBuffer()])})));
}
export async function sourceRecords(inbox) {
  const records = [];
  for (const item of inbox) {
    if (item.path === `${INBOX}/inbox.md` && !(await item.file.text()).trim()) continue;
    const digest = await hash(item.file);
    const name = item.path.replace(/[\\/]/g,'__').replace(/[^\wа-яё.\-]+/giu,'-');
    const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0,dot) : name, extension = dot > 0 ? name.slice(dot) : '';
    records.push({item, path:`${SOURCES}/${stem}-${digest.slice(0,12)}${extension}`, digest});
  }
  return records;
}
async function persistSources(root, records) {
  for (const record of records) await writeBlob(root,record.path,record.item.file);
}
export function requireNonemptyPlan(operations) {
  if (!operations.length) throw Error('LLM вернула пустой план для непустого Inbox. Исходники не изменены.');
}
export function emptyPlanFeedback(inbox) {
  return `План отклонён: operations пуст, хотя расширение обнаружило входящие файлы:\n${inbox.map(item => `${item.path}: ${item.size} байт`).join('\n')}\nСодержимое файлов передано в разделе СОДЕРЖИМОЕ INBOX. Папка архива является корнем путей. Читать файлы из собственной файловой системы не нужно. Верни полный план обработки переданных материалов. Никакие операции предыдущего ответа не выполнялись. Если материалы уже разобраны, всё равно сохрани исходники в 90_Источники и запланируй очистку обработанного Inbox по правилам базы.`;
}
async function walk(root, path = '') {
  const result = [];
  let dir;
  try { dir = await directory(root,path); } catch (error) { if (error.name === 'NotFoundError') return result; throw error; }
  for await (const [name, handle] of dir.entries()) {
    const child = path ? `${path}/${name}` : name;
    if (handle.kind === 'directory') result.push(...await walk(root,child));
    else { const file = await handle.getFile(); result.push({path:child, file, size:file.size, modified:file.lastModified}); }
  }
  return result;
}
async function tree(root) {
  return (await walk(root)).filter(item => !item.path.startsWith('.trash/') && !item.path.startsWith('.quiet-notes-'))
    .map(item => `${item.path} (${item.size} байт)`).join('\n');
}
async function rules(root) {
  const names = ['AGENTS.md','agents.md','conventions.md','CONVENTIONS.md'];
  const values = await Promise.all(names.map(async name => [name, await readText(root,name)]));
  return values.filter(([,text]) => text !== null).map(([name,text]) => `# ${name}\n${text}`).join('\n\n');
}
function jsonObjects(text) {
  const result = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{',start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { result.push(text.slice(start,index + 1)); break; }
    }
  }
  return result;
}
function parsePlan(response) {
  const visible = response.replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
  const fenced = [...visible.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]);
  const candidates = [visible, ...fenced, ...jsonObjects(visible), ...fenced.flatMap(jsonObjects)];
  for (const source of candidates) {
    try {
      const value = JSON.parse(source.trim());
      if (Array.isArray(value.operations)) return {operations:value.operations, summary:typeof value.summary === 'string' ? value.summary : 'Обработка Inbox выполнена.'};
    } catch {}
  }
  throw Error('LLM вернула ответ без корректного JSON-плана операций.');
}
function validatePlan(operations) {
  if (operations.length > 100) throw Error('LLM предложила слишком много операций за один проход.');
  for (const operation of operations) {
    if (!operation || !['write','move','delete'].includes(operation.type)) throw Error('LLM предложила неподдерживаемую операцию.');
    if (operation.type === 'write' && (!safePath(operation.path) || typeof operation.content !== 'string')) throw Error('Некорректная операция записи от LLM.');
    if (operation.type === 'move' && (!safePath(operation.from) || !safePath(operation.to))) throw Error('Некорректная операция переноса от LLM.');
    if (operation.type === 'delete' && !safePath(operation.path)) throw Error('Некорректная операция удаления от LLM.');
    if (operation.path === 'AGENTS.md' || operation.path === 'agents.md' || operation.from === 'AGENTS.md' || operation.from === 'agents.md') throw Error('Правила базы нельзя изменять автоматически.');
    if ([INBOX, SOURCES, '_System'].includes(operation.path) || [INBOX, SOURCES, '_System'].includes(operation.from)) throw Error('LLM не может удалять или переносить служебные папки целиком.');
  }
}
async function backup(root, paths) {
  const result = new Map();
  for (const path of paths) {
    if (result.has(path)) continue;
    const file = await getFile(root,path);
    result.set(path, file ? await file.arrayBuffer() : null);
  }
  return result;
}
async function restore(root, copies) {
  for (const [path, bytes] of copies) {
    const current = await getFile(root,path);
    if (bytes === null) { if (current) await remove(root,path); continue; }
    const stream = await (await fileHandle(root,path,true)).createWritable();
    try { await stream.write(bytes); await stream.close(); } catch (error) { try { await stream.abort(); } catch {} throw error; }
  }
}
async function apply(root, operations) {
  for (const operation of operations) {
    if (operation.type === 'write') await writeText(root,operation.path,operation.content);
    if (operation.type === 'move') {
      const file = await getFile(root,operation.from); if (!file) throw Error(`Не найден исходник для переноса: ${operation.from}`);
      const stream = await (await fileHandle(root,operation.to,true)).createWritable();
      try { await stream.write(await file.arrayBuffer()); await stream.close(); } catch (error) { try { await stream.abort(); } catch {} throw error; }
      await remove(root,operation.from);
    }
    if (operation.type === 'delete') { if (await getFile(root,operation.path)) await remove(root,operation.path); }
  }
}
async function verify(root, inbox, operations) {
  const issues = [], remaining = await walk(root,INBOX);
  const inboxFile = remaining.find(item => item.path === `${INBOX}/inbox.md`);
  if (!inboxFile || remaining.some(item => item.path !== `${INBOX}/inbox.md`) || (await inboxFile.file.text()).trim()) issues.push('00_Inbox должен содержать только пустой inbox.md.');
  const sourceDir = await directory(root,SOURCES).catch(() => null);
  if (!sourceDir) issues.push('Не найдена папка 90_Источники.');
  else {
    const sourceFiles = [];
    for await (const [name, handle] of sourceDir.entries()) {
      if (handle.kind === 'directory') issues.push('В 90_Источники не должно быть подпапок.');
      else sourceFiles.push(await handle.getFile());
    }
    const hashes = new Set(await Promise.all(sourceFiles.map(hash)));
    for (const item of inbox) if (item.path !== `${INBOX}/inbox.md` || (await item.file.text()).trim()) if (!hashes.has(await hash(item.file))) issues.push(`Исходник «${item.path}» не сохранён в 90_Источники.`);
  }
  const index = await readText(root,INDEX);
  if (index === null) issues.push('Не найден _System/index.md.');
  const markdown = [...new Set(operations.filter(op => op.type === 'write' && /\.md$/i.test(op.path) && op.path !== INDEX && !op.path.startsWith(SOURCES + '/') && !op.path.startsWith(INBOX + '/')).map(op => op.path))];
  for (const path of markdown) {
    const text = await readText(root,path);
    if (!text?.startsWith('---\n') || !/^#\s+\S/m.test(text)) issues.push(`У заметки «${path}» нет YAML frontmatter или H1.`);
  }
  return [...new Set(issues)];
}
function deferred(operation) { return (operation.type === 'delete' && inboxPath(operation.path)) || (operation.type === 'move' && inboxPath(operation.from)); }
async function context(root, inbox) {
  const inboxText = await Promise.all(inbox.map(async item => {
    const text = item.size <= 300_000 ? await item.file.text().catch(() => null) : null;
    return `## ${item.path}\n${text === null ? `[двоичный или слишком большой файл: ${item.size} байт]` : text}`;
  }));
  return {rules:await rules(root), index:await readText(root,INDEX) || '(index.md отсутствует)', structure:await tree(root), inbox:inboxText.join('\n\n')};
}
function prompt(input, verification = '') {
  return `Разбери весь Inbox в соответствии с правилами базы знаний. Выполни реальные изменения файлов через JSON-план. Не выходи за пределы корня базы. Сначала ищи существующие заметки, не создавай смысловые дубли, минимально меняй существующие файлы. Расширение само сохранит исходные материалы в 90_Источники без подпапок — не добавляй для этого операций. Очищай 00_Inbox только после создания результата. Обнови _System/index.md. Каждая созданная заметка должна иметь YAML frontmatter и H1; _System/index.md — служебный индекс и не является заметкой.\n\nВерни только JSON-объект без пояснений, Markdown и рассуждений: {"summary":"короткий итог","operations":[{"type":"write","path":"путь","content":"полный текст"},{"type":"move","from":"путь","to":"путь"},{"type":"delete","path":"путь"}]}.\n\nПРАВИЛА БАЗЫ\n${input.rules}\n\n_SYSTEM/index.md\n${input.index}\n\nСТРУКТУРА БАЗЫ\n${input.structure}\n\nСОДЕРЖИМОЕ INBOX\n${input.inbox}${verification ? `\n\nПРОВЕРКА НЕ ПРОЙДЕНА. Исправь только эти нарушения:\n${verification}` : ''}\n\nФОРМАТ ОТВЕТА: только один JSON-объект с ключом operations.`;
}
async function runInboxPipelineImpl({force = false} = {}) {
  const config = await setting('llm-config') || {};
  if (!config.enabled || !config.baseUrl || !config.model) return setStatus('waiting','LLM не настроена.');
  if (!force && !config.autoProcess) return setStatus('waiting','Автообработка Inbox отключена.');
  const vault = await setting('vault');
  if (!vault?.root || await vault.root.queryPermission({mode:'readwrite'}) !== 'granted') return setStatus('error','Нет доступа к папке архива.',log('error','Не удалось прочитать папку базы.'));
  const initialInbox = await snapshotInbox(await walk(vault.root,INBOX));
  if (!initialInbox.length || !await Promise.all(initialInbox.map(async item => item.path !== `${INBOX}/inbox.md` || (await item.file.text()).trim())).then(values => values.some(Boolean))) return setStatus('waiting','Inbox пуст.');
  const inboxFingerprint = await fingerprint(initialInbox), previousFingerprint = await setting('llm-inbox-fingerprint');
  const previousStatus = await setting('llm-status');
  // Do not keep waking a local model for the same failed Inbox. A changed file
  // or saved LLM settings clears this guard and starts a new attempt.
  if (previousFingerprint === inboxFingerprint && ['processing','checking','error'].includes(previousStatus?.state)) return;
  await setting('llm-inbox-fingerprint',inboxFingerprint);
  const provider = new OpenAICompatibleProvider(config);
  let verification = '';
  let emptyResponse = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await setStatus(attempt === 1 ? 'processing' : 'checking', attempt === 1 ? 'Обработка Inbox…' : `Исправление после проверки (${attempt}/3)…`,log('info',`Запуск LLM: попытка ${attempt}.`));
    const currentInbox = await walk(vault.root,INBOX);
    const messages = [{role:'system',content:config.systemPrompt || 'Ты аккуратный агент локальной базы знаний.'},{role:'user',content:prompt(await context(vault.root,currentInbox),verification)}];
    if (emptyResponse !== null) messages.push({role:'assistant',content:emptyResponse},{role:'user',content:verification});
    const response = await provider.chat(messages);
    let plan;
    try { plan = parsePlan(response); }
    catch (error) { throw Error(`${error.message} ${provider.lastDiagnostics} Длина ответа: ${response.length} символов. Файлы не изменены.`); }
    validatePlan(plan.operations);
    if (!plan.operations.length) {
      verification = emptyPlanFeedback(currentInbox);
      emptyResponse = JSON.stringify({summary:plan.summary,operations:[]});
      await setStatus('checking',`Пустой план: попытка ${attempt}/3. Исходники не изменены.`,log('warning',`Пустой план отклонён (${attempt}/3). В Inbox файлов: ${currentInbox.length}.`));
      continue;
    }
    emptyResponse = null;
    requireNonemptyPlan(plan.operations);
    if (await fingerprint(await walk(vault.root,INBOX)) !== inboxFingerprint) throw Error('Inbox изменился во время ответа LLM. Устаревший план не применён; новые данные будут обработаны отдельно.');
    await setStatus('processing','Применение плана LLM…',log('info',`План: ${plan.operations.map(op => op.type === 'write' ? `записать ${op.path}` : op.type === 'move' ? `перенести ${op.from}` : `удалить ${op.path}`).join('; ') || 'изменений нет'}.`));
    const sources = await sourceRecords(initialInbox);
    const paths = [...plan.operations.flatMap(op => op.type === 'move' ? [op.from,op.to] : [op.path]), ...sources.map(source => source.path), `${INBOX}/inbox.md`];
    const copies = await backup(vault.root,paths);
    try {
      await apply(vault.root,plan.operations.filter(op => !deferred(op)));
      await persistSources(vault.root,sources);
      await setStatus('checking','Проверка результата…',log('info',plan.summary));
      await apply(vault.root,plan.operations.filter(deferred));
      await writeText(vault.root,`${INBOX}/inbox.md`,'');
      const issues = await verify(vault.root,initialInbox,plan.operations);
      if (!issues.length) { await setStatus('done','Inbox обработан и проверен.',log('done',plan.summary)); return; }
      verification = issues.join('\n');
      await restore(vault.root,copies);
      await setStatus('processing','Исправление замечаний…',log('warning',verification));
    } catch (error) { await restore(vault.root,copies); throw error; }
  }
  await setStatus('error','Проверка не прошла после 3 попыток.',log('error',verification));
}
export async function runInboxPipeline(options) {
  try { return await runInboxPipelineImpl(options); }
  catch (error) {
    await setStatus('error',error.message || String(error),log('error',error.message || String(error)));
    throw error;
  }
}
