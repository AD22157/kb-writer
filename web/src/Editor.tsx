import { forwardRef, useImperativeHandle, useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

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
