import { describe, expect, it } from 'vitest';
import { createSessionToken, hashPassword, verifyPassword } from './security.js';

describe('security helpers', () => {
  it('hashes and verifies passwords without storing plaintext', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true);
    expect(await verifyPassword('wrong password', encoded)).toBe(false);
  });
  it('creates opaque session tokens and deterministic hashes', () => {
    const first = createSessionToken(); const second = createSessionToken();
    expect(first.token).not.toBe(first.tokenHash); expect(first.token).not.toBe(second.token); expect(first.tokenHash).toHaveLength(64);
  });
});
