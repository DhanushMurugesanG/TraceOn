import { describe, it, expect } from 'vitest';
import { redactString, redactObject } from '../src/redact.js';
import type { RedactionRecord } from '../src/redact.js';

describe('redactString', () => {
  it('redacts emails', () => {
    const records: RedactionRecord[] = [];
    const out = redactString('contact alice@example.com or bob+work@sub.co.uk', records, '$.body');
    expect(out).toBe('contact [REDACTED:email] or [REDACTED:email]');
    expect(records.some((r) => r.rule === 'email' && r.count === 2)).toBe(true);
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const records: RedactionRecord[] = [];
    const out = redactString(`token=${jwt}`, records, '$.attrs.token');
    expect(out).toBe('token=[REDACTED:jwt]');
    expect(records.some((r) => r.rule === 'jwt' && r.count === 1)).toBe(true);
  });

  it('redacts credit card numbers', () => {
    const records: RedactionRecord[] = [];
    const out = redactString('card 4111 1111 1111 1111 declined', records, '$.body');
    expect(out).toContain('[REDACTED:credit_card]');
    expect(records.some((r) => r.rule === 'credit_card')).toBe(true);
  });

  it('redacts AWS access keys', () => {
    const records: RedactionRecord[] = [];
    const out = redactString('using AKIAIOSFODNN7EXAMPLE for s3', records, '$.body');
    expect(out).toBe('using [REDACTED:aws_key] for s3');
    expect(records.some((r) => r.rule === 'aws_key' && r.count === 1)).toBe(true);
  });

  it('redacts generic api-key / secret / token assignments', () => {
    const records: RedactionRecord[] = [];
    const out = redactString('api_key=abc123def456ghi789jkl012mnopqrs', records, '$.body');
    expect(out).toContain('[REDACTED:generic_secret]');
    expect(records.some((r) => r.rule === 'generic_secret')).toBe(true);
  });

  it('returns input unchanged when no patterns match', () => {
    const records: RedactionRecord[] = [];
    const out = redactString('just a normal log message', records, '$.body');
    expect(out).toBe('just a normal log message');
    expect(records.length).toBe(0);
  });
});

describe('redactObject', () => {
  it('walks nested objects and arrays', () => {
    const input = {
      user: { email: 'alice@example.com', name: 'Alice' },
      tags: ['hello', 'ping bob@example.com'],
      count: 42,
      active: true,
      meta: null,
    };
    const { redacted, records } = redactObject(input);
    expect(redacted.user.email).toBe('[REDACTED:email]');
    expect(redacted.user.name).toBe('Alice');
    expect(redacted.tags[0]).toBe('hello');
    expect(redacted.tags[1]).toBe('ping [REDACTED:email]');
    expect(redacted.count).toBe(42);
    expect(redacted.active).toBe(true);
    expect(redacted.meta).toBe(null);
    expect(records.find((r) => r.field_path === '$.user.email')).toBeDefined();
    expect(records.find((r) => r.field_path === '$.tags[1]')).toBeDefined();
  });

  it('records the field_path of each match', () => {
    const { records } = redactObject({ outer: { inner: { token: 'eyJa.eyJb.cdef-foo' } } });
    expect(records[0]?.field_path).toBe('$.outer.inner.token');
  });
});
