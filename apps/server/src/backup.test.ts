import { describe, expect, it } from 'vitest';
import { decodeBackup, encodeBackup, type BackupPayload } from './backup.js';

const payload: BackupPayload = { format: 'sixplan-backup', version: 1, scope: 'user', createdAt: new Date().toISOString(),
  data: { areas: [], plans: [], nodes: [], steps: [], edges: [] } };

describe('backup container', () => {
  it('round-trips an unencrypted backup', async () => expect(await decodeBackup(await encodeBackup(payload))).toEqual(payload));
  it('encrypts with a password and rejects the wrong password', async () => {
    const encoded = await encodeBackup(payload, 'a secure password');
    expect(encoded.toString('utf8')).not.toContain('createdAt');
    await expect(decodeBackup(encoded, 'wrong password')).rejects.toMatchObject({ code: 'BACKUP_PASSWORD_INVALID' });
    expect(await decodeBackup(encoded, 'a secure password')).toEqual(payload);
  });
});
