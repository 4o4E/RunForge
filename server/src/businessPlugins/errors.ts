export type BusinessPluginErrorCode =
  | 'BUSINESS_PLUGIN_MANIFEST_INVALID'
  | 'BUSINESS_PLUGIN_PATH_INVALID'
  | 'BUSINESS_PLUGIN_DUPLICATE_ID'
  | 'BUSINESS_PLUGIN_ARCHIVE_INVALID'
  | 'BUSINESS_PLUGIN_ARCHIVE_TOO_LARGE'
  | 'BUSINESS_PLUGIN_NOT_READY'
  | 'BUSINESS_PLUGIN_SECRET_MISSING'
  | 'BUSINESS_PLUGIN_CONFIG_INVALID'
  | 'BUSINESS_PLUGIN_SECRET_UNAVAILABLE';

export class BusinessPluginError extends Error {
  constructor(
    readonly code: BusinessPluginErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BusinessPluginError';
  }
}
