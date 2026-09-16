const EXTERNAL_UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isExternalUuidToken(value: string): boolean {
  return EXTERNAL_UUID_TOKEN.test(value);
}
