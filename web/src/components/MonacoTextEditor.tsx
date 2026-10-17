import { useEffect, useRef, useState } from 'react';
import MonacoEditor, { loader } from '@monaco-editor/react';
import 'monaco-editor/nls/lang/zh-cn.js';
import * as monaco from 'monaco-editor';

loader.config({ monaco });

interface Props {
  path: string;
  language: string;
  theme: string;
  value: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  onReachEnd?: () => void;
}

type WordWrapMode = 'off' | 'on';

export function MonacoTextEditor({ path, language, theme, value, readOnly = false, onChange, onSave, onReachEnd }: Props) {
  const saveRef = useRef(onSave);
  const reachEndRef = useRef(onReachEnd);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [wordWrap, setWordWrap] = useState<WordWrapMode>('off');

  useEffect(() => {
    saveRef.current = onSave;
    reachEndRef.current = onReachEnd;
  }, [onSave, onReachEnd]);

  function toggleWordWrap() {
    setWordWrap((current) => {
      const next = current === 'off' ? 'on' : 'off';
      editorRef.current?.updateOptions({ wordWrap: next });
      return next;
    });
  }

  return (
    <MonacoEditor
      height="100%"
      language={language}
      path={path}
      theme={theme}
      value={value}
      onChange={(nextValue) => { if (!readOnly) onChange?.(nextValue ?? ''); }}
      onMount={(editor) => {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
        editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, toggleWordWrap);
        editor.onDidScrollChange(() => {
          if (editor.getScrollTop() + editor.getLayoutInfo().height >= editor.getScrollHeight() - 120) reachEndRef.current?.();
        });
      }}
      options={{
        automaticLayout: true,
        readOnly,
        domReadOnly: readOnly,
        fontSize: 13,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        wordWrap,
      }}
    />
  );
}
