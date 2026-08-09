import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNextState,
  decideNotification,
  getNotifiedSnapshot,
  getUtc8Schedule,
} from '../scripts/notification-policy.mjs';

const oldState = {
  checkedAt: '2026-08-08T12:00:00.000Z',
  entries: [{ date: '2026-07-31', title: 'DeepSeek-V4-Flash 更新' }],
  hash: 'old-hash',
};

test('old GitHub Actions state migrates as an already-notified snapshot', () => {
  assert.deepEqual(getNotifiedSnapshot(oldState), {
    entries: oldState.entries,
    hash: 'old-hash',
    notifiedAt: oldState.checkedAt,
  });
});

test('UTC+8 quiet period is 00:00 inclusive to 08:00 exclusive', () => {
  assert.equal(getUtc8Schedule(new Date('2026-08-08T15:59:59Z')).quiet, false);
  assert.equal(getUtc8Schedule(new Date('2026-08-08T16:00:00Z')).quiet, true);
  assert.equal(getUtc8Schedule(new Date('2026-08-08T23:59:59Z')).quiet, true);
  assert.equal(getUtc8Schedule(new Date('2026-08-09T00:00:00Z')).quiet, false);
});

test('periodic slots are fixed at 08:00, 10:00, ..., 22:00 UTC+8', () => {
  assert.equal(
    getUtc8Schedule(new Date('2026-08-09T00:01:00Z')).periodicSlot.id,
    '2026-08-09T08:00:00+08:00',
  );
  assert.equal(
    getUtc8Schedule(new Date('2026-08-09T07:59:00Z')).periodicSlot.id,
    '2026-08-09T14:00:00+08:00',
  );
  assert.equal(
    getUtc8Schedule(new Date('2026-08-09T15:59:00Z')).periodicSlot.id,
    '2026-08-09T22:00:00+08:00',
  );
});

test('a nighttime change is observed but remains pending until 08:00', () => {
  const night = new Date('2026-08-08T18:05:00Z'); // 02:05 UTC+8
  const decision = decideNotification({ now: night, currentHash: 'new-hash', state: oldState });
  assert.equal(decision.quiet, true);
  assert.equal(decision.changedSinceNotification, true);
  assert.equal(decision.shouldNotify, false);

  const pendingState = buildNextState({
    now: night,
    entries: [{ date: '2026-08-09', title: 'New model' }],
    hash: 'new-hash',
    previousState: oldState,
    decision,
  });
  assert.equal(pendingState.hash, 'new-hash');
  assert.equal(pendingState.notifiedHash, 'old-hash');

  const morning = decideNotification({
    now: new Date('2026-08-09T00:00:00Z'),
    currentHash: 'new-hash',
    state: pendingState,
  });
  assert.equal(morning.shouldNotify, true);
  assert.equal(morning.reason, 'change');
  assert.equal(morning.periodicDue, true);
});

test('successful 08:00 notification suppresses repeats until the 10:00 slot', () => {
  const now = new Date('2026-08-09T00:00:00Z');
  const decision = decideNotification({ now, currentHash: 'old-hash', state: oldState });
  const committed = buildNextState({
    now,
    entries: oldState.entries,
    hash: 'old-hash',
    previousState: oldState,
    decision,
    notificationCommitted: true,
  });

  const sameSlot = decideNotification({
    now: new Date('2026-08-09T01:30:00Z'),
    currentHash: 'old-hash',
    state: committed,
  });
  assert.equal(sameSlot.shouldNotify, false);

  const nextSlot = decideNotification({
    now: new Date('2026-08-09T02:00:00Z'),
    currentHash: 'old-hash',
    state: committed,
  });
  assert.equal(nextSlot.shouldNotify, true);
  assert.equal(nextSlot.reason, 'periodic');
});

test('a daytime content change notifies immediately even after the periodic slot', () => {
  const state = {
    ...oldState,
    schemaVersion: 2,
    notifiedEntries: oldState.entries,
    notifiedHash: 'old-hash',
    notifiedAt: oldState.checkedAt,
    lastPeriodicSlot: '2026-08-09T10:00:00+08:00',
  };
  const decision = decideNotification({
    now: new Date('2026-08-09T02:35:00Z'),
    currentHash: 'new-hash',
    state,
  });
  assert.equal(decision.periodicDue, false);
  assert.equal(decision.changedSinceNotification, true);
  assert.equal(decision.shouldNotify, true);
});
