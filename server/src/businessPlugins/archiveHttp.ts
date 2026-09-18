import { raw, type Request } from 'express';
import type { BusinessPluginArchiveFormat } from './archive.js';
import { BusinessPluginError } from './errors.js';

export const businessPluginArchiveBody = raw({
  type: ['application/zip', 'application/gzip', 'application/x-gzip', 'application/octet-stream'],
  limit: '50mb',
});

export function parseBusinessPluginArchiveRequest(req: Request): {
  archive: Buffer;
  format: BusinessPluginArchiveFormat;
} {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_ARCHIVE_INVALID', '业务插件压缩包内容为空');
  }
  const formatHeader = req.get('X-RunForge-Archive-Format');
  const format = req.is('application/zip') || formatHeader === 'zip'
    ? 'zip'
    : req.is('application/gzip') || req.is('application/x-gzip') || formatHeader === 'tgz'
      ? 'tgz'
      : null;
  if (!format) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_ARCHIVE_INVALID', '只支持 ZIP 和 TGZ 业务插件压缩包');
  }
  return { archive: req.body, format };
}
