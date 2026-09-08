import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {Markdown} from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import {TableKit} from '@tiptap/extension-table';

export function createEditor(element, onChange) {
  const editor = new Editor({
    element,
    extensions:[StarterKit.configure({link:{openOnClick:false},underline:false}), Markdown,
      TaskList, TaskItem.configure({nested:true}), Image, TableKit],
    content:'', contentType:'markdown',
    editorProps:{attributes:{'aria-label':'Текст заметки',role:'textbox','aria-multiline':'true','data-placeholder':'Напишите что-нибудь…'}},
    onUpdate:() => onChange(),
    onSelectionUpdate:() => updateButtons(),
    onTransaction:() => updateButtons(),
  });
  function updateButtons() {
    for (const button of document.querySelectorAll('[data-command]')) {
      const name = button.dataset.command;
      const active = name === 'heading' ? editor.isActive('heading',{level:2}) : editor.isActive(name);
      button.classList.toggle('active',active); button.setAttribute('aria-pressed',String(active));
    }
  }
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
  return {
    getMarkdown:() => editor.getMarkdown(),
    getText:() => editor.getText(),
    setContent:markdown => {
      editor.commands.setContent(markdown,{contentType:'markdown',emitUpdate:false});
      // Switching notes must not carry the previous note's undo stack.
      const state = editor.state.constructor.create({doc:editor.state.doc,plugins:editor.state.plugins});
      editor.view.updateState(state);
    },
    setEditable:editable => editor.setEditable(editable,false),
  };
}
