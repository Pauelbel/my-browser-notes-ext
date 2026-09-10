import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {Markdown} from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import {TableKit} from '@tiptap/extension-table';
import {CellSelection, TableMap, selectedRect} from '@tiptap/pm/tables';

export function createEditor(element, onChange) {
  const tableTools = document.createElement('div');
  tableTools.className = 'table-tools';
  tableTools.innerHTML = `<button type="button" class="table-toggle" title="Вставить таблицу" aria-label="Вставить таблицу" aria-expanded="false">▦</button><div class="table-picker" hidden><div class="table-size" aria-live="polite">Выберите размер таблицы</div><div class="table-grid"></div></div>`;
  document.querySelector('#insertImage').after(tableTools);
  const tableToggle = tableTools.querySelector('button');
  const picker = tableTools.querySelector('.table-picker');
  const tableActions = document.createElement('div');
  tableActions.className = 'table-context'; tableActions.hidden = true;
  tableActions.setAttribute('role','toolbar'); tableActions.setAttribute('aria-label','Управление таблицей');
  const tableHint = document.createElement('div');
  tableHint.className = 'table-context-hint';
  tableHint.textContent = 'Строки и столбцы';
  tableActions.append(tableHint);
  document.body.append(tableActions);
  const escapeAttribute = value => String(value || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  const ResizableImage = Image.extend({
    renderMarkdown(node) {
      const {src = '', alt = '', title = '', width, height} = node.attrs || {};
      // Markdown image syntax has no standard size attribute. Use HTML only
      // after a resize so dimensions survive a note reload and archive export.
      if (width || height) {
        const dimensions = `${width ? ` width="${Math.round(width)}"` : ''}${height ? ` height="${Math.round(height)}"` : ''}`;
        return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}"${dimensions}>`;
      }
      return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
    },
  }).configure({
    allowBase64:true,
    resize:{enabled:true, directions:['bottom-right'], minWidth:80, minHeight:60, alwaysPreserveAspectRatio:true},
  });
  const editor = new Editor({
    element,
    extensions:[StarterKit.configure({link:{openOnClick:false},underline:false}), Markdown,
      TaskList, TaskItem.configure({nested:true}), ResizableImage, TableKit.configure({table:{renderWrapper:true}})],
    content:'', contentType:'markdown',
    editorProps:{attributes:{'aria-label':'Текст заметки',role:'textbox','aria-multiline':'true','data-placeholder':'Напишите что-нибудь…'}},
    onUpdate:() => onChange(),
    onSelectionUpdate:() => { updateButtons(); requestAnimationFrame(showTableMenu); },
    onTransaction:() => updateButtons(),
  });
  function updateButtons() {
    if (!editor.isEditable || !editor.isActive('table')) tableActions.hidden = true;
    for (const button of document.querySelectorAll('[data-command]')) {
      const name = button.dataset.command;
      const active = name === 'heading' ? editor.isActive('heading',{level:2}) : editor.isActive(name);
      button.classList.toggle('active',active); button.setAttribute('aria-pressed',String(active));
    }
  }
  function showTableMenu() {
    if (!editor.isEditable || !editor.isFocused || !editor.isActive('table')) { tableActions.hidden = true; return; }
    const position = editor.state.selection.$from;
    let cell;
    for (let depth = position.depth; depth > 0; depth--) {
      if (['tableCell','tableHeader'].includes(position.node(depth).type.name)) {
        cell = editor.view.nodeDOM(position.before(depth)); break;
      }
    }
    cell ||= element.querySelector('.selectedCell');
    if (!cell?.getBoundingClientRect) return;
    const rect = cell.getBoundingClientRect();
    tableActions.hidden = false;
    const width = tableActions.offsetWidth, height = tableActions.offsetHeight;
    tableActions.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    tableActions.style.top = `${Math.max(8, Math.min(rect.bottom + 6 + height < window.innerHeight ? rect.bottom + 6 : rect.top - height - 6, window.innerHeight - height - 8))}px`;
  }
  element.addEventListener('pointerup', () => requestAnimationFrame(showTableMenu));
  element.addEventListener('keydown', event => {
    if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); showTableMenu(); tableActions.querySelector('button')?.focus(); }
    else tableActions.hidden = true;
  });
  document.addEventListener('pointerdown', event => {
    if (!tableActions.contains(event.target)) tableActions.hidden = true;
  });
  document.addEventListener('scroll', event => { if (!tableActions.contains(event.target)) tableActions.hidden = true; }, true);
  window.addEventListener('resize', () => { tableActions.hidden = true; });
  const commands = {
    bold:() => editor.chain().focus().toggleBold().run(),
    italic:() => editor.chain().focus().toggleItalic().run(),
    heading:() => editor.chain().focus().toggleHeading({level:2}).run(),
    bulletList:() => editor.chain().focus().toggleBulletList().run(),
    taskList:() => editor.chain().focus().toggleTaskList().run(),
    blockquote:() => editor.chain().focus().toggleBlockquote().run(),
    clear:() => editor.chain().focus().unsetAllMarks().clearNodes().run(),
    undo:() => editor.chain().focus().undo().run(),
    redo:() => editor.chain().focus().redo().run(),
  };
  for (const button of document.querySelectorAll('[data-command]')) {
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => commands[button.dataset.command]?.();
  }
  function closePicker() { picker.hidden = true; tableToggle.setAttribute('aria-expanded','false'); }
  tableToggle.onmousedown = event => event.preventDefault();
  tableToggle.onclick = () => {
    picker.hidden = !picker.hidden;
    tableToggle.setAttribute('aria-expanded', String(!picker.hidden));
  };
  for (let row = 1; row <= 6; row++) for (let col = 1; col <= 6; col++) {
    const cell = document.createElement('button'); cell.type = 'button';
    cell.dataset.row = row; cell.dataset.col = col;
    cell.setAttribute('aria-label', `${col} столбцов × ${row} строк`);
    const highlight = () => {
      tableTools.querySelector('.table-size').textContent = `${col} × ${row}`;
      for (const button of tableTools.querySelectorAll('.table-grid button'))
        button.classList.toggle('highlight', Number(button.dataset.row) <= row && Number(button.dataset.col) <= col);
    };
    cell.onmouseenter = highlight; cell.onfocus = highlight;
    cell.onmousedown = event => event.preventDefault();
    cell.onclick = () => {
      if (editor.isEditable) editor.chain().focus().insertTable({rows:row,cols:col,withHeaderRow:true}).run();
      closePicker();
    };
    tableTools.querySelector('.table-grid').append(cell);
  }
  for (const [label, command] of [
    ['Строка выше','addRowBefore'], ['Строка ниже','addRowAfter'],
    ['Столбец слева','addColumnBefore'], ['Столбец справа','addColumnAfter'],
    ['Удалить строку','deleteRow'], ['Удалить столбец','deleteColumn'], ['Удалить таблицу','deleteTable'],
  ]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    if (command.startsWith('delete')) button.className = 'table-delete-action';
    button.title = command === 'deleteRow' ? 'Удалить строку выбранной ячейки (отмена: Ctrl+Z)' :
      command === 'deleteColumn' ? 'Удалить столбец выбранной ячейки (отмена: Ctrl+Z)' : label;
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => {
      if (!editor.isEditable) return;
      const addingColumn = command === 'addColumnBefore' || command === 'addColumnAfter';
      const addingRow = command === 'addRowBefore' || command === 'addRowAfter';
      const before = addingColumn || addingRow ? selectedRect(editor.state) : null;
      const applied = editor.chain().focus()[command]().run();
      if (applied && before) {
        const table = editor.state.doc.nodeAt(before.tableStart - 1);
        if (table?.type.name === 'table') {
          const map = TableMap.get(table);
          const column = command === 'addColumnBefore' ? before.left : before.right;
          const row = command === 'addRowBefore' ? before.top : before.bottom;
          const anchor = addingColumn ? map.map[column] : map.map[row * map.width];
          const head = addingColumn ? map.map[(map.height - 1) * map.width + column] : map.map[(row + 1) * map.width - 1];
          editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc,
            before.tableStart + anchor, before.tableStart + head)));
        }
      }
      tableActions.hidden = true;
    };
    tableActions.append(button);
  }
  document.addEventListener('click', event => { if (!tableTools.contains(event.target)) closePicker(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closePicker(); tableActions.hidden = true; } });
  return {
    getMarkdown:() => editor.getMarkdown(),
    getText:() => editor.getText(),
    insertImage:src => editor.chain().focus().setImage({src}).run(),
    setContent:markdown => {
      closePicker(); tableActions.hidden = true;
      editor.commands.setContent(markdown,{contentType:'markdown',emitUpdate:false});
      // Switching notes must not carry the previous note's undo stack.
      const state = editor.state.constructor.create({doc:editor.state.doc,plugins:editor.state.plugins});
      editor.view.updateState(state);
    },
    setEditable:editable => editor.setEditable(editable,false),
  };
}
