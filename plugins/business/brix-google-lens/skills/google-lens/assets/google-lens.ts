// brix 内置脚本：Google Lens 识图 + 抓取候选页
//
// 执行入口：POST /sessions/:sid/scripts/google-lens
//   body: { args: { image: "data:image/png;base64,..." } }  或  { args: { imagePath: "C:/path/to.png" } }
//
// server-side DOM 脚本：只能 import type，其它 runtime 依赖走 `run` 参数。
//
// 产物：
//   <run.dir>/page.png                结果页整页截图
//   <run.dir>/page.html               结果页 HTML
//   <run.dir>/result.json             结构化候选
//   <run.dir>/stage-*.{png,html}      阶段诊断快照
//   <run.dir>/upload.png              上传用的临时图片（保留以便复现）

import { readFile, stat } from 'node:fs/promises';
import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: 'Google Lens 识图，抓取候选页面（去重后返回）',
  argsExample: { image: 'data:image/png;base64,iVBORw0KG...' },
};

interface LensArgs {
  /** base64 字符串、data URL 或绝对文件路径任选其一 */
  image?: string;
  imagePath?: string;
}

interface LensItem {
  title: string;
  url: string;
  sourceDomain: string;
  thumbnailUrl: string;
  faviconUrl?: string;
  imageUrl?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
}

/** Google AI 概览（AI Overview）引用的来源 */
interface AiSource {
  title: string;
  url: string;
  sourceDomain: string;
  faviconUrl?: string;
}

interface AiOverview {
  /** AI 概览正文（已折叠空白）；未生成时为空串 */
  text: string;
  /** AI 分析引用的来源链接（去重，已剔除 google 自身域名） */
  sources: AiSource[];
  /** true=成功生成；false=Google 未能生成 / 超时未出现 */
  generated: boolean;
}

export interface LensOutput {
  pages: LensItem[];
  visualMatches: LensItem[];
  aiOverview: AiOverview;
  finalUrl: string;
  durationMs: number;
}

function isLikelyImageBytes(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true; // BMP
  if (buf[0] === 0x49 && buf[1] === 0x49) return true; // TIFF LE
  if (buf[0] === 0x4d && buf[1] === 0x4d) return true; // TIFF BE
  if (buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return true;
  return false;
}

async function loadImageBytes(input: string): Promise<Buffer> {
  const stripDataUrl = (s: string) => s.replace(/^data:image\/[\w+]+;base64,/, '').trim();
  try {
    const s = await stat(input);
    if (s.isFile()) {
      const raw = await readFile(input);
      if (isLikelyImageBytes(raw)) return raw;
      const text = raw.toString('utf-8').trim();
      return Buffer.from(stripDataUrl(text), 'base64');
    }
  } catch { /* not a file path */ }
  return Buffer.from(stripDataUrl(input), 'base64');
}

async function coerceArgs(args: unknown): Promise<Buffer> {
  let a: LensArgs;
  if (typeof args === 'string') a = { image: args };
  else if (Array.isArray(args) && typeof args[0] === 'string') a = { image: args[0] };
  else if (args && typeof args === 'object') a = args as LensArgs;
  else throw new Error('google-lens: args.image (base64/dataURL) or args.imagePath required');

  if (a.imagePath) {
    const buf = await readFile(a.imagePath);
    if (buf.length === 0) throw new Error('google-lens: imagePath file is empty');
    return buf;
  }
  if (typeof a.image === 'string' && a.image.length > 0) {
    const buf = await loadImageBytes(a.image);
    if (buf.length === 0) throw new Error('google-lens: decoded image is empty');
    return buf;
  }
  throw new Error('google-lens: args.image or args.imagePath required');
}

// 阶段诊断快照 —— 只在 debug run 落盘（stage-*.png/html 体积大，平时堆满磁盘）。
async function snap(page: Page, run: Run, tag: string) {
  if (!run.debug) return;
  try {
    const png = await page.screenshot({ fullPage: true });
    await run.writeArtifact(`stage-${tag}.png`, png);
  } catch { /* ignore */ }
  try {
    const html = await page.content();
    await run.writeArtifact(`stage-${tag}.html`, html);
  } catch { /* ignore */ }
  run.log.info(`stage=${tag} url=${page.url()}`);
}

// AI 概览是异步生成的：结果页先出占位符（“无法针对此搜索生成 AI 概览”默认 display:none），
// 几秒~几十秒后才填入正文与来源链接。这里把它滚进视口触发生成，再轮询直到正文/来源出现
// 或 Google 明确显示生成失败；最多等 timeoutMs，等不到就放行（best-effort，不阻断主链路）。
async function waitForAiOverview(page: Page, run: Run, timeoutMs = 45_000) {
  try {
    await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('[role="heading"]'));
      const h = headings.find((e) => /AI\s*概览|AI\s*Overview/i.test(e.textContent || ''));
      h?.scrollIntoView({ block: 'center' });
    });
  } catch { /* ignore */ }

  try {
    await page.waitForFunction(
      () => {
        const headings = Array.from(document.querySelectorAll('[role="heading"]'));
        const h = headings.find((e) => /AI\s*概览|AI\s*Overview/i.test(e.textContent || ''));
        if (!h) return false; // 模块尚未出现
        let root: Element = h;
        for (let i = 0; i < 8 && root.parentElement; i++) {
          root = root.parentElement;
          if (root.querySelector('a[href]') && (root.textContent || '').length > 200) break;
        }
        // Google 明确表示无法生成（占位符变为可见）→ 视为已结束
        const failVisible = Array.from(root.querySelectorAll('span')).some((s) => {
          const t = s.textContent || '';
          const visible = !!(s as HTMLElement).offsetParent;
          return visible && /无法.*AI 概[览要]|请稍后重试|can.?t generate|couldn.?t generate|No AI Overview/i.test(t);
        });
        if (failVisible) return true;
        const links = Array.from(root.querySelectorAll('a[href]')).filter((a) => {
          try {
            const u = new URL((a as HTMLAnchorElement).href);
            return u.protocol.startsWith('http') && !/(^|\.)google\.com$/.test(u.hostname);
          } catch { return false; }
        });
        const text = (root.textContent || '').replace(/\s+/g, ' ').trim();
        return links.length >= 1 || text.length > 160;
      },
      { timeout: timeoutMs, polling: 800 },
    );
    run.log.info('AI 概览已就绪（或确认无法生成）');
  } catch {
    run.log.warn(`AI 概览等待超时（${timeoutMs}ms），按未生成处理`);
  }
  await snap(page, run, '05-ai-overview');
}

async function uploadAndExtract(page: Page, imagePath: string, run: Run) {
  run.log.info('goto lens.google.com');
  await page.goto('https://lens.google.com/?hl=en', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { /* ignore */ });
  await snap(page, run, '01-loaded');

  const fileInputs = await page.$$eval('input[type="file"]', (els) =>
    (els as HTMLInputElement[]).map((e) => ({
      name: e.getAttribute('name'),
      accept: e.getAttribute('accept'),
      visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
    })),
  );
  run.log.debug(`file inputs found: ${JSON.stringify(fileInputs)}`);

  const fileInput = await page.waitForSelector('input[name="encoded_image"]', { state: 'attached', timeout: 15_000 });
  await fileInput.setInputFiles(imagePath);
  run.log.info('setInputFiles done, waiting for navigation');
  await page.waitForTimeout(3_000);
  await snap(page, run, '02-after-upload');

  try {
    await page.waitForURL(/\/search\?/, { timeout: 60_000 });
  } catch (e) {
    if (page.url().includes('/sorry/')) {
      await snap(page, run, '03-captcha');
      run.log.warn('遇到 Google reCAPTCHA，请在浏览器手动完成验证（等待 5 分钟）');
      await page.waitForURL(/\/search\?/, { timeout: 300_000 });
    } else {
      await snap(page, run, '03-timeout');
      throw e;
    }
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => { /* ignore */ });
  await page.waitForTimeout(2_000);
  await snap(page, run, '04-results');

  await waitForAiOverview(page, run);

  await page.evaluate('window.__name = window.__name || function(fn){return fn;};');

  return await page.evaluate(() => {
    const safeUrl = (s: string | null | undefined) => {
      if (!s) return '';
      try { return new URL(s, location.href).href; } catch { return s; }
    };
    const safeDomain = (s: string) => {
      try { return new URL(s).hostname; } catch { return ''; }
    };

    type Item = {
      title: string;
      url: string;
      sourceDomain: string;
      thumbnailUrl: string;
      faviconUrl?: string;
      imageUrl?: string;
      thumbnailWidth?: number;
      thumbnailHeight?: number;
    };

    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const items: Item[] = [];
    const isFavicon = (img: HTMLImageElement) => {
      const src = img.currentSrc || img.src || '';
      const naturalWidth = img.naturalWidth || img.width || 0;
      const naturalHeight = img.naturalHeight || img.height || 0;
      const displayWidth = img.clientWidth || img.width || 0;
      const displayHeight = img.clientHeight || img.height || 0;
      return src.includes('/favicon-tbn')
        || (naturalWidth <= 40 && naturalHeight <= 40)
        || (displayWidth <= 40 && displayHeight <= 40);
    };
    const isVisiblePreview = (img: HTMLImageElement) => (img.clientWidth || img.width || 0) >= 60 && (img.clientHeight || img.height || 0) >= 60;
    const imageArea = (img: HTMLImageElement) => (img.clientWidth || img.width || 0) * (img.clientHeight || img.height || 0);
    for (const a of anchors) {
      const href = a.href;
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
      const domain = safeDomain(href);
      if (!domain) continue;
      if (/(^|\.)google\.com$/.test(domain)) continue;
      if (/(^|\.)gstatic\.com$/.test(domain)) continue;
      if (/(^|\.)googleusercontent\.com$/.test(domain)) continue;

      const card = a.closest('.vEWxFf') || a.closest('[data-snm]') || a.parentElement;
      const cardImages = Array.from(card?.querySelectorAll('img') ?? []) as HTMLImageElement[];
      const linkImages = Array.from(a.querySelectorAll('img')) as HTMLImageElement[];
      const preview = cardImages
        .filter((img) => !isFavicon(img) && isVisiblePreview(img))
        .sort((a, b) => imageArea(b) - imageArea(a))[0] ?? null;
      const favicon = linkImages.find(isFavicon) ?? cardImages.find(isFavicon) ?? null;
      if (!preview) continue;

      const title = (
        a.querySelector('[role="heading"], h3, .Yt787')?.textContent ||
        card?.querySelector('[aria-label]')?.getAttribute('aria-label') ||
        a.getAttribute('aria-label') ||
        preview.alt ||
        a.textContent ||
        ''
      ).trim();
      const imageUrl = safeUrl(preview.currentSrc || preview.src);
      items.push({
        title,
        url: safeUrl(href),
        sourceDomain: domain,
        thumbnailUrl: imageUrl,
        faviconUrl: favicon ? safeUrl(favicon.currentSrc || favicon.src) : undefined,
        imageUrl,
        thumbnailWidth: preview.naturalWidth || preview.width || undefined,
        thumbnailHeight: preview.naturalHeight || preview.height || undefined,
      });
    }

    const seen = new Set<string>();
    const dedup: Item[] = [];
    for (const it of items) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      dedup.push(it);
    }

    // ---- AI 概览（AI Overview）正文 + 来源 ----
    type Source = { title: string; url: string; sourceDomain: string; faviconUrl?: string };
    const extractAiOverview = (): { text: string; sources: Source[]; generated: boolean } => {
      const headings = Array.from(document.querySelectorAll('[role="heading"]'));
      const heading = headings.find((e) => /AI\s*概览|AI\s*Overview/i.test(e.textContent || ''));
      if (!heading) return { text: '', sources: [], generated: false };

      // 从标题向上找模块根：第一个同时包含外链且文本量较大的祖先
      let root: Element = heading;
      for (let i = 0; i < 8 && root.parentElement; i++) {
        root = root.parentElement;
        if (root.querySelector('a[href]') && (root.textContent || '').length > 200) break;
      }

      const failVisible = Array.from(root.querySelectorAll('span')).some((s) => {
        const visible = !!(s as HTMLElement).offsetParent;
        return visible && /无法.*AI 概[览要]|请稍后重试|can.?t generate|couldn.?t generate|No AI Overview/i.test(s.textContent || '');
      });

      // innerText 只取“渲染出来的”文本：自动跳过 display:none 的占位失败提示，
      // 也排除 <script>/<style>，比 textContent 干净得多。再剥掉标题标签本身。
      let text = ((root as HTMLElement).innerText || root.textContent || '')
        .replace(/AI\s*概览/g, '')
        .replace(/AI\s*Overview/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      // 正文之后会跟来源卡片列表，二者以 “[<站点名>] [+]N 个网站” 分隔：前缀 “+” 时有时无
      //（“+45 个网站” / “1 个网站”），innerText 还可能把数字拆开（“+4 5 个网站”），故 “+” 可选、
      // 数字用 [\d\s]* 容错。识别该标记，截掉其后的来源段，并去掉紧贴其前、由空白引出的来源
      // 站点名（如 “Facebook”），避免留下孤词。
      const tailMatch = text.match(/(?:\+\s*)?\d[\d\s]*\s*(?:个网站|个网页|sites?|websites?)/i);
      if (tailMatch && tailMatch.index !== undefined) {
        const cut = text.slice(0, tailMatch.index).replace(/\s+[^\s。.!?！？]{1,40}\s*$/, '').trim();
        if (cut.length >= 20) text = cut; // 防误切：截出来太短就保留原文
      }
      // 兜底剥掉末尾的 AI 免责声明（无来源分隔标记、未触发上面截断时可能残留）
      text = text
        .replace(/\s*AI 的回答未必正确无误[，,。.\s]*请注意核查。?\s*$/, '')
        .replace(/\s*AI responses may (?:include|contain) mistakes\.?\s*$/i, '')
        .trim();

      const srcSeen = new Set<string>();
      const sources: Source[] = [];
      for (const a of Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
        const url = safeUrl(a.href);
        const domain = safeDomain(url);
        if (!domain) continue;
        if (/(^|\.)google\.com$/.test(domain)) continue;
        if (/(^|\.)gstatic\.com$/.test(domain)) continue;
        if (/(^|\.)googleusercontent\.com$/.test(domain)) continue;
        if (srcSeen.has(url)) continue;
        srcSeen.add(url);
        const fav = a.querySelector('img') as HTMLImageElement | null;
        const title = (
          a.querySelector('[role="heading"], h3')?.textContent ||
          a.getAttribute('aria-label') ||
          a.textContent ||
          ''
        )
          .replace(/在新标签页中打开。?/g, '')
          .replace(/查看相关链接/g, '')
          .replace(/\s*-\s*$/, '')
          .replace(/\s+/g, ' ')
          .trim();
        sources.push({
          title,
          url,
          sourceDomain: domain,
          faviconUrl: fav ? safeUrl(fav.currentSrc || fav.src) : undefined,
        });
      }

      const generated = !failVisible && (sources.length > 0 || text.length > 80);
      // 未生成时连同 sources 一并清空：AI 概览失败时模块根可能向上膨胀到整页，
      // 误收一堆无关外链当“来源”，故只在确认生成时才返回正文与来源。
      if (!generated) return { text: '', sources: [], generated: false };
      return { text, sources, generated };
    };

    return { pages: dedup, visualMatches: dedup, aiOverview: extractAiOverview() };
  });
}

export async function runInSession(page: Page, args: unknown, run: Run): Promise<LensOutput> {
  const bytes = await coerceArgs(args);
  run.log.info(`bytes=${bytes.length}`);

  const uploadPath = await run.writeArtifact('upload.png', bytes);
  const t0 = Date.now();

  const { pages, visualMatches, aiOverview } = await uploadAndExtract(page, uploadPath, run);

  // 结果页 page.png/html 是诊断产物 —— 只 debug run 落盘；result.json 始终保留。
  if (run.debug) {
    const screenshot = await page.screenshot({ fullPage: true });
    await run.writeArtifact('page.png', screenshot);
    await run.writeArtifact('page.html', await page.content());
  }

  const output: LensOutput = {
    pages,
    visualMatches,
    aiOverview,
    finalUrl: page.url(),
    durationMs: Date.now() - t0,
  };
  await run.writeArtifact('result.json', JSON.stringify({ runId: run.runId, ...output }, null, 2));
  run.log.info(
    `done in ${output.durationMs}ms, ${pages.length} item(s), ` +
    `AI 概览=${aiOverview.generated ? `已生成(${aiOverview.sources.length} 来源)` : '未生成'}`,
  );
  return output;
}
