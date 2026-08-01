import { afterEach, describe, expect, it, vi } from 'vitest';

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses the Clipboard API in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { copyText } = await import('./clipboard');
    await copyText('提示词');
    expect(writeText).toHaveBeenCalledWith('提示词');
  });

  it('falls back to a selected textarea on an insecure HTTP origin', async () => {
    const input = { value: '', readOnly: false, style: {}, focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() };
    const documentStub = { createElement: vi.fn(() => input), body: { append: vi.fn() }, execCommand: vi.fn(() => true) };
    vi.stubGlobal('window', { isSecureContext: false });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', documentStub);
    const { copyText } = await import('./clipboard');
    await copyText('局域网提示词');
    expect(documentStub.execCommand).toHaveBeenCalledWith('copy');
    expect(input.value).toBe('局域网提示词');
    expect(input.remove).toHaveBeenCalled();
  });
});
