export function createRandomHex(byteLength: number): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
