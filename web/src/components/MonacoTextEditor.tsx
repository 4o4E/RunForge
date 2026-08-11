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
  onChange: (value: string) => void;
  onSave?: () => void;
}

type WordWrapMode = 'off' | 'on';

export function MonacoTextEditor({ path, language, theme, value, onChange, onSave }: Props) {
  const saveRef = useRef(onSave);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [wordWrap, setWordWrap] = useState<WordWrapMode>('off');

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

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
      onChange={(nextValue) => onChange(nextValue ?? '')}
      onMount={(editor) => {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
        editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, toggleWordWrap);
      }}
      options={{
        automaticLayout: true,
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
