export type PluginRuntimeErrorCode =
  | 'INVALID_MANIFEST'
  | 'DUPLICATE_DEPLOYMENT'
  | 'DEPLOYMENT_NOT_FOUND'
  | 'DUPLICATE_PLUGIN'
  | 'MISSING_DEPENDENCY'
  | 'DEPENDENCY_VERSION_MISMATCH'
  | 'DEPENDENCY_CYCLE'
  | 'CONTRIBUTION_CONFLICT'
  | 'UNDECLARED_CONTRIBUTION'
  | 'CONFIG_INVALID'
  | 'LOCK_HASH_MISMATCH'
  | 'DUPLICATE_RUN'
  | 'RUNTIME_DISPOSED';

export class PluginRuntimeError extends Error {
  readonly name = 'PluginRuntimeError';

  constructor(
    readonly code: PluginRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
