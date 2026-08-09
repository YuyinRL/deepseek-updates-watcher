const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function hasOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Return the notification window and latest two-hour slot for a point in time.
 * China Standard Time is a fixed UTC+8 offset and has no daylight-saving time.
 */
export function getUtc8Schedule(now = new Date()) {
  const shifted = new Date(now.getTime() + UTC8_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  const localDate = `${year}-${month}-${day}`;
  const quiet = hour < 8;

  if (quiet) {
    return {
      quiet,
      hour,
      localDate,
      localTime: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
      periodicSlot: null,
    };
  }

  const slotHour = 8 + Math.floor((hour - 8) / 2) * 2;
  return {
    quiet,
    hour,
    localDate,
    localTime: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    periodicSlot: {
      hour: slotHour,
      id: `${localDate}T${pad2(slotHour)}:00:00+08:00`,
    },
  };
}

export function getChannelDelivery(state, channel) {
  const existing = state?.deliveries?.[channel.id];
  if (existing) {
    return {
      notifiedEntries: existing.notifiedEntries ?? [],
      notifiedHash: existing.notifiedHash ?? null,
      notifiedAt: existing.notifiedAt ?? null,
      lastPeriodicSlot: existing.lastPeriodicSlot ?? null,
      lastDailySummaryDate: existing.lastDailySummaryDate ?? null,
    };
  }

  // A channel added after schema v3 starts from the current observation instead
  // of replaying the entire historical changelog.
  const migrated = state?.schemaVersion >= 3
    ? { entries: state.entries ?? [], hash: state.hash ?? null, notifiedAt: state.checkedAt ?? null }
    : getNotifiedSnapshot(state);

  return {
    notifiedEntries: migrated.entries,
    notifiedHash: migrated.hash,
    notifiedAt: migrated.notifiedAt,
    lastPeriodicSlot: channel.kind === 'wechat' ? null : (state?.lastPeriodicSlot ?? null),
    // The last old-style periodic status already delivered today counts as the
    // migration-day WeChat summary, avoiding a duplicate message on deployment.
    lastDailySummaryDate: channel.kind === 'wechat' && state?.lastPeriodicSlot
      ? state.lastPeriodicSlot.slice(0, 10)
      : null,
  };
}

export function decideChannelNotification({
  now = new Date(),
  currentHash,
  state,
  channel,
  activityDates = [],
}) {
  const schedule = getUtc8Schedule(now);
  const delivery = getChannelDelivery(state, channel);
  const changedSinceNotification = currentHash !== delivery.notifiedHash;

  if (channel.kind === 'wechat') {
    const summaryDates = schedule.hour >= 18
      ? activityDates
          .filter((date) => date <= schedule.localDate && (!delivery.lastDailySummaryDate || date > delivery.lastDailySummaryDate))
          .sort()
      : [];
    return {
      ...schedule,
      delivery,
      changedSinceNotification,
      periodicDue: false,
      summaryDates,
      summaryDue: summaryDates.length > 0,
      shouldNotify: changedSinceNotification || summaryDates.length > 0,
    };
  }

  const periodicDue = !!schedule.periodicSlot && delivery.lastPeriodicSlot !== schedule.periodicSlot.id;
  return {
    ...schedule,
    delivery,
    changedSinceNotification,
    periodicDue,
    summaryDates: [],
    summaryDue: false,
    shouldNotify: changedSinceNotification || periodicDue,
  };
}

export function commitChannelDelivery({ now, entries, hash, decision }) {
  const next = { ...decision.delivery };
  if (decision.changedSinceNotification) {
    next.notifiedEntries = entries;
    next.notifiedHash = hash;
    next.notifiedAt = now.toISOString();
  }
  if (decision.periodicDue) next.lastPeriodicSlot = decision.periodicSlot.id;
  if (decision.summaryDue) next.lastDailySummaryDate = decision.summaryDates.at(-1);
  return next;
}

/**
 * Old GitHub Actions state files only had `entries` and `hash`. In that schema,
 * the observed snapshot was also the last successfully notified snapshot.
 */
export function getNotifiedSnapshot(state) {
  if (!state) return { entries: [], hash: null, notifiedAt: null };
  return {
    entries: hasOwn(state, 'notifiedEntries') ? (state.notifiedEntries ?? []) : (state.entries ?? []),
    hash: hasOwn(state, 'notifiedHash') ? state.notifiedHash : (state.hash ?? null),
    notifiedAt: hasOwn(state, 'notifiedAt') ? state.notifiedAt : (state.checkedAt ?? null),
  };
}
