// Интерфейс локального Python-агента. Содержимое модели выводится без HTML.
const BASE = 'http://127.0.0.1:8765';

function inline(parent, text) {
  for (const piece of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    const el = document.createElement(piece.startsWith('**') ? 'strong' : piece.startsWith('`') ? 'code' : 'span');
    el.textContent = piece.startsWith('**') ? piece.slice(2,-2) : piece.startsWith('`') ? piece.slice(1,-1) : piece;
    parent.append(el);
  }
}
export function renderAgentMarkdown(parent, text) {
  let code = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (code) code = null;
      else { const pre = document.createElement('pre'); code = document.createElement('code'); pre.append(code); parent.append(pre); }
      continue;
    }
    if (code) { code.textContent += line + '\n'; continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const row = document.createElement(heading ? `h${heading[1].length + 1}` : 'p');
    inline(row, heading ? heading[2] : line || '\u00a0'); parent.append(row);
  }
}

export function mountAgent({getNote, saveAnswer}) {
  const panel = document.createElement('section'); panel.id = 'agentPanel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Персональный агент');
  panel.innerHTML = `
    <div class="agent-heading"><div><h1>Агент</h1><p>Ваши инструменты, навыки и память</p></div><button id="agentNew" type="button">Новый диалог</button></div>
    <details class="agent-connection" open><summary>Подключение к локальному агенту</summary>
      <p>Запустите Python-агент с <code>--server</code> и вставьте ключ из терминала.</p>
      <div class="agent-connect-row"><input id="agentKey" type="password" autocomplete="off" placeholder="Ключ подключения" aria-label="Ключ подключения"><button id="agentConnect" type="button">Подключить</button></div>
      <small>127.0.0.1:8765 · Ключ хранится до закрытия панели.</small>
    </details>
    <p id="agentError" role="alert" hidden></p>
    <div id="agentMessages" role="log" aria-label="Диалог"><p class="agent-empty">Подключите агента и напишите, чем помочь.</p></div>
    <details id="agentTools" hidden><summary>Действия агента</summary><ul></ul></details>
    <div id="agentStats" role="status">Не подключён</div>
    <form id="agentForm"><div class="agent-attachment"><button id="agentAttach" type="button">Передать текущую заметку</button><span id="agentAttached"></span><button id="agentDetach" type="button" hidden aria-label="Убрать заметку">×</button></div>
      <textarea id="agentInput" rows="3" placeholder="Напишите задачу…" aria-label="Сообщение агенту" required></textarea>
      <div class="agent-compose-footer"><small>Enter — отправить · Shift+Enter — новая строка</small><button id="agentSend" type="submit" disabled>Отправить</button></div>
    </form>`;
  document.body.append(panel);
  const $ = id => panel.querySelector(`#${id}`);
  const toggle = document.createElement('button'); toggle.id = 'agentToggle'; toggle.type = 'button'; toggle.textContent = 'Агент';
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', panel.id);
  document.querySelector('.header-actions').prepend(toggle);
  toggle.onclick = () => {
    panel.hidden = !panel.hidden; document.body.classList.toggle('agent-mode', !panel.hidden);
    toggle.textContent = panel.hidden ? 'Агент' : 'К заметкам'; toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) $('agentInput').focus();
  };
  let key = sessionStorage.getItem('agent-key') || '', session = sessionStorage.getItem('agent-session') || '';
  let connected = false, busy = false, attachment = null, poll = null, rendered = '', last = null, receivedAt = 0;
  $('agentKey').value = key;
  const error = text => { $('agentError').textContent = text; $('agentError').hidden = !text; };
  function controls() {
    $('agentSend').disabled = !connected || busy;
    $('agentNew').disabled = !connected || busy;
    $('agentConnect').disabled = busy;
  }
  async function api(path, data) {
    let response;
    try { response = await fetch(BASE + path, {method: data === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${key}`, 'Content-Type':'application/json'}, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10000)}); }
    catch { throw new Error('Нет связи с агентом. Проверьте, что сервер запущен с --server, затем подключитесь снова.'); }
    const body = await response.json();
    if (!response.ok) { const e = new Error(body.error || 'Ошибка сервера'); e.status = response.status; throw e; }
    return body;
  }
  function stats() {
    if (!last) return;
    if (!last.busy && !last.requests && !last.messages.length) { $('agentStats').textContent = 'Подключён · Готов к работе'; return; }
    const seconds = last.elapsed + (last.busy ? (performance.now() - receivedAt) / 1000 : 0);
    const tokens = last.tokens === null ? 'ожидание данных' : `${last.partial ? 'от ' : ''}${last.tokens.toLocaleString('ru')}`;
    $('agentStats').textContent = `${last.busy ? 'Выполняется' : 'Завершено'} · ${seconds.toFixed(1)} с · Токены: ${tokens} · Запросов завершено: ${last.requests}`;
  }
  function render(state) {
    last = state; receivedAt = performance.now(); busy = state.busy; controls(); stats();
    const signature = JSON.stringify(state.messages);
    if (signature !== rendered) {
      const log = $('agentMessages'); const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
      log.replaceChildren();
      for (const m of state.messages) {
        const article = document.createElement('article'); article.className = `agent-message ${m.role}`;
        const label = document.createElement('strong'); label.className = 'agent-role'; label.textContent = m.role === 'user' ? 'Вы' : 'Агент'; article.append(label);
        const content = document.createElement('div'); renderAgentMarkdown(content, m.content); article.append(content);
        if (m.note) { const tag = document.createElement('small'); tag.textContent = `Заметка: ${m.note}`; article.append(tag); }
        if (m.role === 'assistant') {
          const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Сохранить как заметку';
          save.onclick = async () => { save.disabled = true; try { await saveAnswer(m.content); save.textContent = 'Сохранено в заметках'; } catch(e) { error(e.message); save.disabled = false; } };
          article.append(save);
        }
        log.append(article);
      }
      if (!state.messages.length) { const p = document.createElement('p'); p.className = 'agent-empty'; p.textContent = 'Новый диалог. Чем помочь?'; log.append(p); }
      if (nearBottom || !rendered) log.scrollTop = log.scrollHeight;
      rendered = signature;
    }
    $('agentTools').hidden = !state.events.length;
    $('agentTools').querySelector('ul').replaceChildren(...state.events.map(event => { const li = document.createElement('li'); li.textContent = `${event.инструмент}: ${event.статус}${event.ошибка ? ' — ' + event.ошибка : ''}`; return li; }));
    if (state.error) error(state.error);
  }
  async function refresh() {
    clearTimeout(poll);
    try { render(await api(`/sessions/${session}`)); if (busy) poll = setTimeout(refresh, 700); }
    catch(e) { connected = false; busy = false; if (last) last.busy = false; controls(); error(e.message); }
  }
  async function newSession() { const state = await api('/sessions', {}); session = state.id; sessionStorage.setItem('agent-session', session); rendered = ''; await refresh(); }
  $('agentConnect').onclick = async () => {
    error(''); const previous = key; key = $('agentKey').value.trim();
    try {
      await api('/health'); connected = true; sessionStorage.setItem('agent-key', key);
      if (session && previous === key) {
        try { render(await api(`/sessions/${session}`)); if (busy) poll = setTimeout(refresh, 700); }
        catch(e) { if (e.status === 404) await newSession(); else throw e; }
      } else await newSession();
      panel.querySelector('.agent-connection').open = false; controls();
    } catch(e) { connected = false; controls(); error(e.message); }
  };
  $('agentNew').onclick = async () => { try { error(''); await newSession(); } catch(e) { error(e.message); } };
  $('agentAttach').onclick = async () => { try { attachment = await getNote(); $('agentAttached').textContent = attachment.title || 'Без названия'; $('agentDetach').hidden = false; error(''); } catch(e) { error(e.message); } };
  $('agentDetach').onclick = () => { attachment = null; $('agentAttached').textContent = ''; $('agentDetach').hidden = true; };
  $('agentForm').onsubmit = async event => {
    event.preventDefault(); const text = $('agentInput').value.trim(); if (!text || busy || !connected) return;
    busy = true; controls(); error('');
    try {
      await api(`/sessions/${session}/messages`, {message:text, note:attachment});
      $('agentInput').value = ''; $('agentDetach').click(); await refresh();
    } catch(e) { busy = false; controls(); error(e.message); await refresh(); }
  };
  $('agentInput').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('agentForm').requestSubmit(); } };
  const clock = setInterval(stats, 200);
  window.addEventListener('pagehide', () => { clearInterval(clock); clearTimeout(poll); });
  controls();
}
