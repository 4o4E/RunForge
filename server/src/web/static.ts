import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import express, { type Express } from 'express';

function requireWebDist(configuredRoot: string): { root: string; index: string } {
  const root = resolve(configuredRoot);
  const index = join(root, 'index.html');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`RUNFORGE_WEB_DIST 目录不存在：${root}`);
  }
  if (!existsSync(index) || !statSync(index).isFile()) {
    throw new Error(`RUNFORGE_WEB_DIST 缺少 index.html：${index}`);
  }
  return { root, index };
}

/**
 * 容器生产环境由同一个 Node.js 进程提供前端文件、API 和 WebSocket。开发环境不设置
 * RUNFORGE_WEB_DIST，继续使用 Vite 开发服务器。
 */
export function mountWebApp(app: Express, configuredRoot?: string): string | null {
  const value = configuredRoot?.trim();
  if (!value) return null;
  const { root, index } = requireWebDist(value);

  app.use(express.static(root, { index: false }));
  app.use((req, res, next) => {
    const reserved = req.path === '/health'
      || req.path === '/ws'
      || req.path === '/api'
      || req.path.startsWith('/api/');
    if (req.method !== 'GET' || reserved || extname(req.path) || !req.accepts('html')) {
      next();
      return;
    }
    res.sendFile(index);
  });
  return root;
}
