import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAction, readableError, validateEaCredentials } from './index.js';

test('management actions validate input and build BF1 calls', () => {
  const ids = { serverId: 'server', persistedGameId: 'persisted' };
  assert.deepEqual(buildAction('ban', { personaId: '123456' }, ids), [
    'RSP.addServerBan',
    { game: 'tunguska', serverId: 'server', personaId: '123456' }
  ]);
  assert.deepEqual(buildAction('map', { levelIndex: 2 }, ids), [
    'RSP.chooseLevel',
    { game: 'tunguska', persistedGameId: 'persisted', levelIndex: 2 }
  ]);
  assert.equal(buildAction('move', { personaId: '123456', teamId: 2 }, ids)[0], 'RSP.movePlayer');
  assert.equal(buildAction('admin-add', { personaId: '123456' }, ids)[0], 'RSP.addServerAdmin');
  assert.throws(() => buildAction('kick', { personaId: 'x' }, ids), /persona ID/);
  assert.throws(() => buildAction('move', { personaId: '123456', teamId: 3 }, ids), /Takım/);
});

test('server restart failure is explained clearly', () => {
  assert.match(readableError('ServerNotRestartableException'), /Aktif tur başladıktan sonra/);
});

test('EA credentials reject cookie injection characters', () => {
  assert.deepEqual(validateEaCredentials({ sid: ' valid-token ', remid: '' }), { sid: 'valid-token', remid: '' });
  assert.throws(() => validateEaCredentials({ sid: 'token; admin=true' }), /SID/);
});
