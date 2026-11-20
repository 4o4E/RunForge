import { Console } from 'node:console';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BrixError, clientFromEnv, localFile, saveScreenshot } from './client.mjs';

const commands = {
  session: {
    open: '[URL]', list: '', close: '<id>', trace: '<id>',
  },
  page: {
    goto: '<url> [--wait-until STATE] [--snapshot]', snapshot: '[--scope CSS] [--interactive-only] [--max-depth N]',
    click: '<target> [--expect-download] [--save-as NAME] [--snapshot]', fill: '<target> <text> [--snapshot]',
    type: '<target> <text> [--snapshot]', press: '<key> [--snapshot]', select: '<target> <value> [--snapshot]',
    hover: '<target> [--snapshot]', scroll: '<up|down> [--amount N] [--snapshot]',
    wait: '<url|selector|load> <condition> [--state STATE]', read: '<url|title|content|text|count|attr> [selector] [name]',
    eval: '<source-file>', upload: '<target> <file>...', screenshot: '<output> [--full-page]',
  },
  files: { list: '<run-id>', get: '<run-id> <name> <output>' },
  local: { run: '<module.mjs> [--session ID] [--args-file JSON] [--url URL]' },
  remote: {
    list: '', show: '<name>', run: '<name> [--session ID] [--args-file JSON | --image FILE] [--url URL]',
    put: '<name> <script.js|script.ts>   # 人确认具体内容后才上传或覆盖',
    delete: '<name>   # 人确认后才删除',
  },
  experience: { search: '<query.json>', show: '<id>', publish: '<experience.json>', report: '<id> <feedback.json>' },
};
const mutating = new Set(['navigate', 'click', 'fill', 'type', 'press', 'select', 'hover', 'scroll', 'upload', 'eval']);
const knownCallers = new Map([
  ['google-lens', ['RunForge 图片来源', 'neko-bot 图片来源']],
  ['gemini-draw', ['neko-bot 生图与 GIF 重绘']],
  ['chatgpt-draw', ['neko-bot 生图']],
]);
const enc = encodeURIComponent;
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const positionCounts = {
  session: { open: [0, 1], list: [0], close: [1], trace: [1] },
  page: {
    goto: [1], snapshot: [0], click: [1], fill: [2], type: [2], press: [1], select: [2], hover: [1],
    scroll: [1], wait: [2], read: [1, 3], eval: [1], upload: [2, Infinity], screenshot: [1],
  },
  files: { list: [1], get: [3] }, local: { run: [1] }, remote: { list: [0], show: [1], run: [1], put: [2], delete: [1] },
  experience: { search: [1], show: [1], publish: [1], report: [2] },
};
const pageOptions = {
  goto: { timeout: string, 'wait-until': string, snapshot: boolean },
  snapshot: { scope: string, 'interactive-only': boolean, 'max-depth': string },
  click: { timeout: string, 'expect-download': boolean, 'save-as': string, snapshot: boolean },
  fill: { snapshot: boolean }, type: { snapshot: boolean, delay: string }, press: { snapshot: boolean },
  select: { snapshot: boolean }, hover: { timeout: string, snapshot: boolean },
  scroll: { amount: string, snapshot: boolean }, wait: { timeout: string, state: string }, read: {},
  eval: {}, upload: { snapshot: boolean }, screenshot: { 'full-page': boolean },
};

function help(group, verb) {
  if (!Object.hasOwn(commands, group)) return `用法：brix <${Object.keys(commands).join('|')}> <命令>\n查看 brix <命令组> --help`;
  return Object.entries(commands[group]).filter(([key]) => !verb || verb === key)
    .map(([key, args]) => `brix ${group} ${key} ${group === 'page' ? '--session ID ' : ''}${args}${pageOptions[key]?.timeout && group === 'page' ? ' [--timeout MS]' : ''}`.trimEnd()).join('\n');
}

function invalid(hint) { throw new BrixError('invalid_arguments', { hint }); }
function number(value, minimum = 0) {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < minimum) invalid('请输入有效整数。');
  return result;
}
function oneOf(value, allowed) {
  if (!allowed.includes(value)) invalid(`允许：${allowed.join(', ')}`);
  return value;
}
async function sourceFile(path) {
  return readFile(path, 'utf8').catch(() => { throw new BrixError('file_read_failed', { path }); });
}
async function jsonFile(path) {
  const source = await sourceFile(path);
  try { return JSON.parse(source); } catch { throw new BrixError('invalid_json_file', { path }); }
}

async function pageCommand(client, verb, [arg, value, name], flags, paths) {
  const id = flags.session;
  const timeout = number(flags.timeout, 1);
  const returnSnapshot = flags.snapshot;
  const act = (op, params) => client.action(id, op, params);
  switch (verb) {
    case 'goto': return act('navigate', { url: arg, timeout, returnSnapshot, waitUntil: flags['wait-until'] && oneOf(flags['wait-until'], ['load', 'domcontentloaded', 'networkidle']) });
    case 'snapshot': return act('snapshot', { scope: flags.scope, interactiveOnly: flags['interactive-only'], maxDepth: number(flags['max-depth']) });
    case 'click':
      if (flags['save-as'] && !flags['expect-download']) invalid('--save-as 需要 --expect-download。');
      return act('click', { target: arg, timeout, expectDownload: flags['expect-download'], saveAs: flags['save-as'], returnSnapshot });
    case 'fill': case 'type': case 'select': return act(verb, { target: arg, value, delay: number(flags.delay), returnSnapshot });
    case 'press': return act(verb, { key: arg, returnSnapshot });
    case 'hover': return act(verb, { target: arg, timeout, returnSnapshot });
    case 'scroll': return act(verb, { direction: oneOf(arg, ['up', 'down']), amount: number(flags.amount, 1), returnSnapshot });
    case 'wait': {
      if (flags.state && arg !== 'selector') invalid('--state 只用于 selector。');
      if (arg === 'url') return act('waitForUrl', { pattern: value, timeout });
      if (arg === 'selector') return act('waitForSelector', { selector: value, timeout, state: flags.state && oneOf(flags.state, ['attached', 'detached', 'visible', 'hidden']) });
      if (arg === 'load') return act('waitForLoad', { state: oneOf(value, ['load', 'domcontentloaded', 'networkidle']), timeout });
      return invalid('wait 需要 url、selector 或 load。');
    }
    case 'read': {
      const op = oneOf(arg, ['url', 'title', 'content', 'text', 'count', 'attr']);
      const count = op === 'attr' ? 3 : ['text', 'count'].includes(op) ? 2 : 1;
      if (paths.length !== count) invalid(help('page', 'read'));
      return act(op, { selector: value, name });
    }
    case 'eval': return act('eval', { source: await sourceFile(arg) });
    case 'upload': return act('upload', { target: arg, files: await Promise.all(paths.slice(1).map(localFile)), returnSnapshot });
    case 'screenshot': return saveScreenshot(arg, await act('screenshot', { fullPage: flags['full-page'] ?? false }));
  }
}

async function localRun(client, path, flags) {
  const args = flags['args-file'] ? await jsonFile(flags['args-file']) : {};
  const originalConsole = globalThis.console;
  globalThis.console = new Console(process.stderr, process.stderr);
  try {
    const { runInSession } = await import(pathToFileURL(resolve(path)).href).catch(() => { throw new BrixError('local_script_load_failed', { path }); });
    if (typeof runInSession !== 'function') throw new BrixError('missing_run_in_session', { path });
    return await client.inSession(flags.session, async (id) => {
      let lastRunId;
      let downloads;
      let dispatch = 'not_sent';
      let stage = 'script';
      const act = async (op, params) => {
        stage = op;
        const changesPage = mutating.has(op);
        const previous = dispatch;
        if (changesPage) dispatch = 'unknown';
        try {
          const response = await client.action(id, op, params);
          lastRunId = response.runId;
          if (response.downloads?.length) downloads = response.downloads;
          if (changesPage) dispatch = 'sent_unconfirmed';
          return response;
        } catch (error) {
          if (changesPage && [400, 403, 404].includes(error.details.status)) dispatch = previous;
          throw error;
        }
      };
      const api = {
        args, sessionId: id,
        goto: (url, options) => act('navigate', { ...options, url }),
        snapshot: async (options) => (await act('snapshot', options)).snapshot,
        click: (target, options) => act('click', { ...options, target }),
        fill: (target, value) => act('fill', { target, value }),
        type: (target, value, options) => act('type', { ...options, target, value }),
        press: (key) => act('press', { key }),
        select: (target, value) => act('select', { target, value }),
        hover: (target, options) => act('hover', { ...options, target }),
        scroll: (direction, amount) => act('scroll', { direction, amount }),
        waitForSelector: (selector, options) => act('waitForSelector', { ...options, selector }),
        waitForUrl: (pattern, options) => act('waitForUrl', { ...options, pattern }),
        waitForLoad: (state, options) => act('waitForLoad', { ...options, state }),
        read: async (op, selector, name) => (await act(oneOf(op, ['url', 'title', 'content', 'text', 'count', 'attr']), { selector, name })).result,
        evalInPage: async (source) => (await act('eval', { source })).result,
        upload: async (target, ...paths) => act('upload', { target, files: await Promise.all(paths.map(localFile)) }),
        screenshot: async (file, options) => saveScreenshot(file, await act('screenshot', options)),
        download: (runId, name, file) => client.download(runId, name, file),
      };
      try {
        const output = await runInSession(api);
        return { location: 'local', sessionId: id, runId: lastRunId, output: output ?? null };
      } catch (cause) {
        const error = cause instanceof BrixError ? cause : new BrixError('local_script_error');
        error.details.stage ??= stage;
        error.details.runId ??= lastRunId;
        error.details.downloads ??= downloads;
        error.details.dispatch = dispatch;
        throw error;
      }
    }, flags.url);
  } finally { globalThis.console = originalConsole; }
}

export async function execute(argv, makeClient = clientFromEnv) {
  const [group, verb, ...rest] = argv;
  if (!Object.hasOwn(commands, group) || !Object.hasOwn(commands[group], verb)) invalid(help(group));
  const options = group === 'page' ? { session: string, ...pageOptions[verb] }
    : verb === 'run' ? { session: string, 'args-file': string, url: string, ...(group === 'remote' ? { image: string } : {}) } : {};
  let parsed;
  try { parsed = parseArgs({ args: rest, options, allowPositionals: true }); }
  catch { return invalid(help(group, verb)); }
  const { values: flags, positionals: paths } = parsed;
  const [min, max = min] = positionCounts[group][verb];
  if (paths.length < min || paths.length > max || (group === 'page' && !flags.session)) invalid(help(group, verb));
  if (flags.url !== undefined && flags.session !== undefined) invalid('--url 只用于新建会话；已有会话请显式导航。');
  const [arg, value, name] = paths;
  const client = await makeClient();
  switch (group) {
    case 'session':
      if (verb === 'open') return client.open(arg);
      if (verb === 'list') return client.json('/sessions');
      if (verb === 'trace') return client.json(`/sessions/${enc(arg)}/trace`);
      await client.json(`/sessions/${enc(arg)}`, 'DELETE');
      return { closed: arg };
    case 'page': return pageCommand(client, verb, paths, flags, paths);
    case 'files': return verb === 'get' ? client.download(arg, value, name) : client.files(arg);
    case 'local': return localRun(client, arg, flags);
    case 'remote': {
      const meta = (item) => ({ ...item, location: 'remote', knownCallers: knownCallers.get(item.name) ?? null });
      const endpoint = `/scripts/${enc(arg)}`;
      if (verb === 'list') return (await client.json('/scripts')).map(meta);
      if (verb === 'show') {
        const result = await client.json(endpoint);
        return { ...result, meta: meta(result.meta) };
      }
      if (verb === 'put') {
        const language = value.endsWith('.ts') ? 'ts' : value.endsWith('.js') ? 'js' : invalid('远程脚本需要 .js 或 .ts 文件。');
        return client.put(arg, await sourceFile(value), language);
      }
      if (verb === 'delete') {
        await client.json(endpoint, 'DELETE');
        return { deleted: arg, location: 'remote' };
      }
      if (flags.image !== undefined && (arg !== 'google-lens' || flags['args-file'] !== undefined)) invalid('--image 仅用于 google-lens，不能与 --args-file 同用。');
      let args = flags['args-file'] ? await jsonFile(flags['args-file']) : {};
      if (flags.image !== undefined) {
        const image = await localFile(flags.image);
        if (!image.base64 || !image.mimeType.startsWith('image/')) invalid('--image 需要支持的非空图片。');
        args = { image: `data:${image.mimeType};base64,${image.base64}` };
      }
      return client.inSession(flags.session, (id) => client.run(id, arg, args), flags.url);
    }
    case 'experience':
      if (verb === 'show') return client.json(`/experiences/${enc(arg)}`);
      if (verb === 'report') return client.json(`/experiences/${enc(arg)}/feedback`, 'POST', await jsonFile(value));
      return client.json(verb === 'search' ? '/experiences/search' : '/experiences', 'POST', await jsonFile(arg));
  }
}

export async function main(argv = process.argv.slice(2), makeClient = () => {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return clientFromEnv();
}) {
  const [group, verb] = argv;
  if (!group || argv.includes('--help') || argv.includes('-h') || (!verb && Object.hasOwn(commands, group))) {
    console.log(help(group, verb === '--help' || verb === '-h' ? undefined : verb));
    return;
  }
  try { console.log(JSON.stringify(await execute(argv, makeClient))); }
  catch (cause) {
    const error = cause instanceof BrixError ? cause : new BrixError('cli_error', { cause: cause?.code });
    console.error(JSON.stringify({ error: error.code, ...error.details }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
