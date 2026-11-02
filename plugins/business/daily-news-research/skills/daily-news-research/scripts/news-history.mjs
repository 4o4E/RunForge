import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * 创建新闻历史只读客户端。
 * @param {{baseUrl: string, token: string}} options
 */
export function createNewsHistoryClient({ baseUrl, token }) {
  if (typeof baseUrl !== 'string' || typeof token !== 'string' || !token) {
    throw new TypeError('新闻历史接口地址或工作令牌未配置');
  }

  let apiUrl;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError();
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError();
    }
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
    apiUrl = parsed;
  } catch {
    throw new TypeError('新闻历史接口地址无效');
  }

  async function post(path, body) {
    let response;
    try {
      response = await fetch(new URL(path, apiUrl), {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('新闻历史接口请求失败');
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`新闻历史接口拒绝重定向（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      throw new Error(`新闻历史接口返回错误（HTTP ${response.status}）`);
    }

    try {
      return await response.json();
    } catch {
      throw new Error('新闻历史接口返回无效JSON');
    }
  }

  return {
    check(body) {
      return post('check', body);
    },
    details(body) {
      return post('details', body);
    },
  };
}

async function runCli(args) {
  const [command, jsonFile, ...extra] = args;
  if (!['check', 'details'].includes(command) || !jsonFile || extra.length) {
    throw new Error('用法：node news-history.mjs check|details <jsonFile>');
  }

  const baseUrl = process.env.NEKO_NEWS_API_BASE;
  const token = process.env.NEKO_NEWS_WORK_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('未配置NEKO_NEWS_API_BASE或NEKO_NEWS_WORK_TOKEN');
  }

  let body;
  try {
    body = JSON.parse(await readFile(jsonFile, 'utf8'));
  } catch {
    throw new Error('无法读取或解析请求JSON文件');
  }

  const client = createNewsHistoryClient({ baseUrl, token });
  const result = await client[command](body);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// 插件通过符号链接提供脚本，CLI入口按实际文件路径判断。
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : '新闻历史接口请求失败'}\n`);
    process.exitCode = 1;
  });
}
