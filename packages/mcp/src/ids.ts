import { randomBytes } from 'crypto';

// Crockford's base-32 alphabet (no I, L, O, U).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRunId(): string {
  let timestamp = '';
  let t = Date.now();
  for (let i = 0; i < 10; i++) {
    timestamp = ALPHABET[t % 32] + timestamp;
    t = Math.floor(t / 32);
  }
  const random = randomBytes(10)
    .toString('base64url')
    .slice(0, 16)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '0');
  return timestamp + random;
}

export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}
