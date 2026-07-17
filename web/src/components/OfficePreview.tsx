import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import {
  readAccessToken,
  remoteFilePdfPreviewUrl,
  remoteFileRawUrl,
  signedRemoteFileUrl,
  type FileShareAccess,
} from '@/api';
import { Button } from '@/components/ui/button';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type OfficePreviewKind = 'pdf' | 'office';

interface Props {
  path: string;
  kind: OfficePreviewKind;
  shareAccess?: FileShareAccess;
}

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>;

type LoadState = 'loading' | 'ready' | 'error';

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ods']);

export function officePreviewKindForPath(path: string): OfficePreviewKind | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  return null;
}

function absoluteUrl(url: string): string {
  return new URL(url, window.location.origin).toString();
}

function pdfHeaders(): Record<string, string> | undefined {
  const token = readAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function PdfPageCanvas({ document, pageNumber, scale }: { document: PdfDocument; pageNumber: number; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['render']> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setError(null);
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    document.getPage(pageNumber)
      .then((page) => {
        if (canceled) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;

        const viewport = page.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;

        const task = page.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        renderTaskRef.current = task;
        return task.promise;
      })
      .catch((err) => {
        if (!canceled && (err as Error).name !== 'RenderingCancelledException') setError((err as Error).message);
      });

    return () => {
      canceled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [document, pageNumber, scale]);

  return (
    <div className="flex justify-center py-3">
      <div className="rounded-md border bg-white shadow-sm">
        {error ? (
          <div className="flex min-h-40 min-w-80 items-center justify-center px-4 text-sm text-destructive">{error}</div>
        ) : (
          <canvas ref={canvasRef} className="block" />
        )}
      </div>
    </div>
  );
}

function PdfViewer({ url, title }: { url: string; title: string }) {
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [scale, setScale] = useState(1);
  const pageNumbers = useMemo(() => Array.from({ length: document?.numPages ?? 0 }, (_, index) => index + 1), [document?.numPages]);

  useEffect(() => {
    let canceled = false;
    setState('loading');
    setError(null);
    setDocument(null);

    const task = pdfjsLib.getDocument({
      url: absoluteUrl(url),
      httpHeaders: pdfHeaders(),
    });

    task.promise
      .then((pdf) => {
        if (canceled) {
          void pdf.cleanup();
          return;
        }
        setDocument(pdf);
        setState('ready');
      })
      .catch((err) => {
        if (!canceled) {
          setError((err as Error).message);
          setState('error');
        }
      });

    return () => {
      canceled = true;
      void task.destroy();
    };
  }, [url]);

  if (state === 'loading') {
    return <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground">正在生成 PDF 预览…</div>;
  }

  if (state === 'error' || !document) {
    return <div className="flex h-full items-center justify-center rounded-md border bg-muted/20 px-3 text-center text-sm text-destructive">{error ?? 'PDF 预览失败'}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border bg-muted/20">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-2">
        <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={title}>
          {document.numPages} 页
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => setScale((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))} title="缩小" aria-label="缩小">
          <ZoomOut className="size-4" />
        </Button>
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
        <Button variant="ghost" size="icon-sm" onClick={() => setScale((value) => Math.min(2.5, Number((value + 0.1).toFixed(2))))} title="放大" aria-label="放大">
          <ZoomIn className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setScale(1)} title="重置缩放" aria-label="重置缩放">
          <RotateCcw className="size-4" />
        </Button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
        {pageNumbers.map((pageNumber) => (
          <PdfPageCanvas key={`${pageNumber}-${scale}`} document={document} pageNumber={pageNumber} scale={scale} />
        ))}
      </div>
    </div>
  );
}

export function OfficePreview({ path, kind, shareAccess }: Props) {
  const url = kind === 'pdf'
    ? shareAccess ? signedRemoteFileUrl(path, shareAccess) : remoteFileRawUrl(path)
    : remoteFilePdfPreviewUrl(path, shareAccess);

  return <PdfViewer url={url} title={path} />;
}
