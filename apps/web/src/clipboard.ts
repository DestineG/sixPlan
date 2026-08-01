export async function copyText(value: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the selection-based path used by HTTP LAN access.
    }
  }

  const input = document.createElement('textarea');
  input.value = value;
  input.readOnly = true;
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.opacity = '0';
  document.body.append(input);
  input.focus();
  input.select();
  input.setSelectionRange(0, value.length);
  let copied = false;
  try { copied = document.execCommand?.('copy') ?? false; }
  finally { input.remove(); }
  if (!copied) throw new Error('COPY_NOT_AVAILABLE');
}
