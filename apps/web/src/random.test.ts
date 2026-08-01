import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRandomHex } from './random';

describe('createRandomHex', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('works when randomUUID is unavailable in an insecure HTTP context', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.forEach((_, index) => { bytes[index] = index; });
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });

    expect(createRandomHex(16)).toBe('000102030405060708090a0b0c0d0e0f');
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});
