import { createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'wlt';

export function generateWorkloadToken(): string {
  return `${TOKEN_PREFIX}_${randomBytes(32).toString('base64url')}`;
}

export function hashWorkloadToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function randomPassword(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + Math.max(1, Math.floor(seconds)) * 1000);
}

export function iso(date: Date): string {
  return date.toISOString();
}
