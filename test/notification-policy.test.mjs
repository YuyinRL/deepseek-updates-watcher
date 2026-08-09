import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitChannelDelivery,
  decideChannelNotification,
  getChannelDelivery,
  getNotifiedSnapshot,
  getUtc8Schedule,
} from '../scripts/notification-policy.mjs';

const emailChannel = { id: 'smtp', kind: 'email' };
const wechatChannel = { id: 'serverchan', kind: 'wechat' };

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

test('an update bypasses the nighttime quiet period for both email and WeChat', () => {
  const now = new Date('2026-08-08T18:05:00Z'); // 02:05 UTC+8
  for (const channel of [emailChannel, wechatChannel]) {
    const decision = decideChannelNotification({
      now,
      currentHash: 'new-hash',
      state: oldState,
      channel,
      activityDates: ['2026-08-09'],
    });
    assert.equal(decision.quiet, true);
    assert.equal(decision.changedSinceNotification, true);
    assert.equal(decision.shouldNotify, true);
  }
});

test('WeChat stays silent without updates before 18:00', () => {
  const decision = decideChannelNotification({
    now: new Date('2026-08-09T02:00:00Z'), // 10:00 UTC+8
    currentHash: 'old-hash',
    state: oldState,
    channel: wechatChannel,
    activityDates: ['2026-08-09'],
  });
  assert.equal(decision.changedSinceNotification, false);
  assert.equal(decision.summaryDue, false);
  assert.equal(decision.shouldNotify, false);
});

test('WeChat sends one daily summary at or after 18:00 and then suppresses repeats', () => {
  const now = new Date('2026-08-09T10:00:00Z'); // 18:00 UTC+8
  const decision = decideChannelNotification({
    now,
    currentHash: 'old-hash',
    state: oldState,
    channel: wechatChannel,
    activityDates: ['2026-08-09'],
  });
  assert.equal(decision.summaryDue, true);
  assert.deepEqual(decision.summaryDates, ['2026-08-09']);
  assert.equal(decision.shouldNotify, true);

  const delivery = commitChannelDelivery({
    now,
    entries: oldState.entries,
    hash: 'old-hash',
    decision,
  });
  const committedState = { ...oldState, schemaVersion: 3, deliveries: { serverchan: delivery } };
  const repeated = decideChannelNotification({
    now: new Date('2026-08-09T11:30:00Z'),
    currentHash: 'old-hash',
    state: committedState,
    channel: wechatChannel,
    activityDates: ['2026-08-09'],
  });
  assert.equal(repeated.shouldNotify, false);
});

test('email retains the two-hour daytime heartbeat policy', () => {
  const decision = decideChannelNotification({
    now: new Date('2026-08-09T02:00:00Z'), // 10:00 UTC+8
    currentHash: 'old-hash',
    state: oldState,
    channel: emailChannel,
  });
  assert.equal(decision.periodicDue, true);
  assert.equal(decision.shouldNotify, true);
});

test('email and WeChat keep independent update delivery state', () => {
  const state = {
    ...oldState,
    schemaVersion: 3,
    deliveries: {
      smtp: {
        notifiedEntries: [{ date: '2026-08-09', title: 'New model' }],
        notifiedHash: 'new-hash',
        notifiedAt: '2026-08-08T18:05:00.000Z',
      },
      serverchan: {
        notifiedEntries: oldState.entries,
        notifiedHash: 'old-hash',
        notifiedAt: oldState.checkedAt,
      },
    },
  };
  const now = new Date('2026-08-08T18:10:00Z');
  const email = decideChannelNotification({ now, currentHash: 'new-hash', state, channel: emailChannel });
  const wechat = decideChannelNotification({ now, currentHash: 'new-hash', state, channel: wechatChannel });
  assert.equal(email.shouldNotify, false);
  assert.equal(wechat.shouldNotify, true);
  assert.equal(wechat.changedSinceNotification, true);
});

test('a change detected at 18:00 combines immediate WeChat update and daily summary', () => {
  const decision = decideChannelNotification({
    now: new Date('2026-08-09T10:00:00Z'),
    currentHash: 'new-hash',
    state: oldState,
    channel: wechatChannel,
    activityDates: ['2026-08-09'],
  });
  assert.equal(decision.changedSinceNotification, true);
  assert.equal(decision.summaryDue, true);
  assert.equal(decision.shouldNotify, true);
});

test('schema v2 migration treats today old periodic WeChat status as today summary', () => {
  const state = { ...oldState, lastPeriodicSlot: '2026-08-09T22:00:00+08:00' };
  const delivery = getChannelDelivery(state, wechatChannel);
  assert.equal(delivery.lastDailySummaryDate, '2026-08-09');
});
