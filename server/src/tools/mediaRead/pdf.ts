import { readFile, stat } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { LlmContentPart } from '../../llm/types.js';
import type { ToolRunContext } from '../types.js';
import { MAX_PDF_BYTES, MAX_PDF_PAGES, MAX_TEXT_CHARS, saveDerivedImage, throwIfAborted } from './shared.js';

/** PDF 阅读默认提取可检索文字并渲染少量页面；纯文字模式不会渲染图片。 */
export async function readPdf(path: string, options: { mode: string; pages?: number[] }, ctx?: ToolRunContext): Promise<{ text: string; contentParts?: LlmContentPart[] }> {
  const info = await stat(path);
  if (info.size > MAX_PDF_BYTES) throw new Error(`PDF 超过 ${MAX_PDF_BYTES} 字节读取上限`);
  const bytes = await readFile(path);
  throwIfAborted(ctx);
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const cancelLoading = () => { void loadingTask.destroy(); };
  ctx?.abortSignal?.addEventListener('abort', cancelLoading, { once: true });
  let document;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    ctx?.abortSignal?.removeEventListener('abort', cancelLoading);
    throw error;
  }
  const pageCount = document.numPages;
  const pagesToRender = options.mode === 'media'
    ? options.pages ?? Array.from({ length: Math.min(pageCount, 3) }, (_, index) => index + 1)
    : [];
  try {
    if (options.pages && options.pages.length > MAX_PDF_PAGES) throw new Error(`一次最多选择 ${MAX_PDF_PAGES} 个 PDF 页面`);
    if (pagesToRender.length > MAX_PDF_PAGES) throw new Error(`一次最多读取 ${MAX_PDF_PAGES} 个 PDF 页面图像`);
    if (options.pages?.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)) {
      throw new Error(`PDF 页码必须在 1 到 ${pageCount} 之间`);
    }
  } catch (error) {
    ctx?.abortSignal?.removeEventListener('abort', cancelLoading);
    await loadingTask.destroy();
    throw error;
  }

  if (options.mode === 'metadata') {
    ctx?.abortSignal?.removeEventListener('abort', cancelLoading);
    await loadingTask.destroy();
    return { text: `PDF 文件：${pageCount} 页，${bytes.byteLength} 字节。需要分析页面时请指定 pages 页码。` };
  }

  const pagesToRead = options.pages ?? Array.from({ length: pageCount }, (_, index) => index + 1);
  let text = '';
  let textTruncated = false;
  const pagesRead: number[] = [];
  const renderedPages: number[] = [];
  const images: LlmContentPart[] = [];
  try {
    for (const pageNumber of pagesToRead) {
      throwIfAborted(ctx);
      if (text.length >= MAX_TEXT_CHARS) {
        textTruncated = true;
        break;
      }
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item) => 'str' in item)
        .map((item) => 'str' in item ? item.str : '')
        .join(' ')
        .trim();
      const header = `\n\n--- 第 ${pageNumber} 页 ---\n`;
      const remaining = Math.max(0, MAX_TEXT_CHARS - text.length - header.length);
      text += `${header}${(pageText || '（本页没有可提取文字）').slice(0, remaining)}`;
      pagesRead.push(pageNumber);
      if (pagesToRender.includes(pageNumber)) {
        const viewport = page.getViewport({ scale: 1.4 });
        if (viewport.width * viewport.height > 24_000_000) throw new Error(`PDF 第 ${pageNumber} 页渲染尺寸过大`);
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        await page.render({ canvas, canvasContext: context as never, viewport }).promise;
        const image = await saveDerivedImage(await canvas.encode('png'), `${path}-page-${pageNumber}`, ctx);
        image.name = `第 ${pageNumber} 页`;
        images.push(image);
        renderedPages.push(pageNumber);
      }
      page.cleanup();
      if (pageText.length > remaining) {
        textTruncated = true;
        break;
      }
    }
  } finally {
    ctx?.abortSignal?.removeEventListener('abort', cancelLoading);
    await loadingTask.destroy();
  }
  const rendered = renderedPages.length ? `已生成第 ${renderedPages.join('、')} 页的页面图像` : '未生成页面图像';
  const pagesStatus = `文字读取页码：${pagesRead.length ? pagesRead.join('、') : '未读取'}${pagesRead.length < pageCount || textTruncated ? '（只读取了部分页面）' : ''}。`;
  const instructions = options.mode === 'media' && !options.pages ? `；可通过 pages 指定最多 ${MAX_PDF_PAGES} 页供视觉分析` : '';
  const truncation = textTruncated ? `\n\n（已达到 ${MAX_TEXT_CHARS} 字符上限；当前页及后续页面文字未完整读取）` : '';
  return {
    text: `PDF 共 ${pageCount} 页，${rendered}。${pagesStatus}${instructions}\n${text || '未提取文字内容。'}${truncation}`,
    ...(images.length ? { contentParts: images } : {}),
  };
}
