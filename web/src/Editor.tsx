import { forwardRef, useImperativeHandle, useEffect } from 'react';
import { useEditor, EditorContent, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// 失焦保留选区高亮。
// 问题：在左边选一段、鼠标点到右侧面板（要点 补充/修正/提问 或输 prompt）时，编辑器失焦，
//       浏览器原生 ::selection 高亮随之消失 —— 用户看不出到底选没选到、选的是哪段。
// 修法：失焦时给"刚才那段选区"补一层 decoration 顶上；重新聚焦就撤掉，交还原生高亮。
//       只加装饰，不碰 state.selection —— 动作触发时仍按原逻辑 getSelection() 取，行为一字未改。
const keepSelKey = new PluginKey('keepSelection');
const KeepSelection = Extension.create({
  name: 'keepSelection',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: keepSelKey,
        state: {
          init: () => true,
          apply(tr, focused) {
            const m = tr.getMeta(keepSelKey);
            return typeof m === 'boolean' ? m : focused;
          },
        },
        props: {
          handleDOMEvents: {
            // 只发 meta、不改 doc/selection → 不触发 onUpdate（不会把文档标脏、不会误触自动保存）
            focus: (view) => {
              if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(keepSelKey, true).setMeta('addToHistory', false));
              return false;
            },
            blur: (view) => {
              if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(keepSelKey, false).setMeta('addToHistory', false));
              return false;
            },
          },
          decorations(state) {
            const focused = keepSelKey.getState(state);
            const { from, to } = state.selection;
            if (focused || from === to) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [Decoration.inline(from, to, { class: 'sel-kept' })]);
          },
        },
      }),
    ];
  },
});

export interface EditorHandle {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  getSelection: () => { text: string; from: number; to: number };
  replaceSelection: (text: string) => void;
  insertAtCursor: (text: string) => void;
  focus: () => void;
}

interface Props {
  onUpdate?: (md: string) => void;
  onSelectionChange?: (text: string) => void;
  onBlur?: () => void;
}

// 编辑器用成熟开源件：Tiptap(MIT) + StarterKit + tiptap-markdown（双向 Markdown，存盘即 .md）。
const Editor = forwardRef<EditorHandle, Props>(({ onUpdate, onSelectionChange, onBlur }, ref) => {
  const editor = useEditor({
    extensions: [
      // StarterKit 自带 History（undo/redo）：编辑器聚焦时 Ctrl+Z 是编辑器内撤销，不会触发浏览器后退。
      StarterKit,
      Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
      KeepSelection,   // 失焦后仍看得见刚才选中的是哪段
    ],
    content: '',
    onUpdate: ({ editor }) => onUpdate?.(editor.storage.markdown.getMarkdown()),
    onBlur: () => onBlur?.(),   // 失焦即存（触发之一）
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      onSelectionChange?.(from === to ? '' : editor.state.doc.textBetween(from, to, '\n'));
    },
  });

  useImperativeHandle(ref, () => ({
    getMarkdown: () => editor?.storage.markdown.getMarkdown() ?? '',
    setMarkdown: (md: string) => editor?.commands.setContent(md || ''),
    getSelection: () => {
      if (!editor) return { text: '', from: 0, to: 0 };
      const { from, to } = editor.state.selection;
      return { text: from === to ? '' : editor.state.doc.textBetween(from, to, '\n'), from, to };
    },
    replaceSelection: (text: string) => {
      if (!editor) return;
      const { from, to } = editor.state.selection;
      editor.chain().focus().insertContentAt({ from, to }, text).run();
    },
    insertAtCursor: (text: string) => {
      if (!editor) return;
      const to = editor.state.selection.to;
      editor.chain().focus().insertContentAt(to, '\n\n' + text).run();
    },
    focus: () => editor?.commands.focus(),
  }), [editor]);

  useEffect(() => () => editor?.destroy(), [editor]);

  return <EditorContent editor={editor} className="editor" />;
});

export default Editor;
