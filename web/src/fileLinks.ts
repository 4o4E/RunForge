const FILE_LINK_PREFIX = 'runforge-file://';
const LEGACY_FILE_LINK_PREFIX = 'my-agent-file://';

function stripFileLineSuffix(value: string): string {
  return value.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/(?::\d+){1,2}$/, '');
}

function decodeHrefPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 对话文件链接只接收当前工作区的相对路径及用户文件目录的绝对路径。 */
export function workspacePathFromHref(href: string, workspaceRoot: string | null): string | null {
  const prefix = href.startsWith(FILE_LINK_PREFIX)
    ? FILE_LINK_PREFIX
    : href.startsWith(LEGACY_FILE_LINK_PREFIX)
      ? LEGACY_FILE_LINK_PREFIX
      : null;
  if (prefix) return decodeHrefPath(href.slice(prefix.length));
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file://')) return null;

  let rawPath = href;
  if (href.startsWith('file://')) {
    try {
      rawPath = new URL(href).pathname;
    } catch {
      return null;
    }
  }
  const withoutQuery = rawPath.split(/[?#]/, 1)[0] ?? '';
  let candidate = stripFileLineSuffix(decodeHrefPath(withoutQuery)).trim();
  if (!candidate) return null;

  const root = workspaceRoot?.replace(/\/+$/, '') ?? '';
  if (root && (candidate === root || candidate.startsWith(`${root}/`))) {
    candidate = candidate.slice(root.length).replace(/^\/+/, '') || '.';
  } else if (/^\/u\/[^/]+(?:\/|$)/.test(candidate)) {
    return candidate;
  } else if (candidate.startsWith('/')) {
    return null;
  }

  candidate = candidate.replace(/^\.\/+/, '') || '.';
  if (candidate.split('/').includes('..')) return null;
  return candidate;
}

/** 文件所属目录决定右侧面板，标签内部统一保存该目录的相对路径。 */
export function fileTabForPath(path: string, workspaceRoot: string | null, userFilesRoot: string | null): `file:${string}` | `user-file:${string}` {
  const userRoot = userFilesRoot?.replace(/\/+$/, '');
  if (userRoot && (path === userRoot || path.startsWith(`${userRoot}/`))) {
    return `user-file:${path.slice(userRoot.length).replace(/^\/+/, '') || '.'}`;
  }
  const root = workspaceRoot?.replace(/\/+$/, '');
  if (path.startsWith('/') && !(root && (path === root || path.startsWith(`${root}/`)))) {
    throw new Error('文件链接不属于当前工作区或用户文件目录');
  }
  const relativePath = root && (path === root || path.startsWith(`${root}/`))
    ? path.slice(root.length).replace(/^\/+/, '') || '.'
    : path;
  return `file:${relativePath}`;
}
