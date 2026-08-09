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
      localDate,
      localTime: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
      periodicSlot: null,
    };
  }

  const slotHour = 8 + Math.floor((hour - 8) / 2) * 2;
  return {
    quiet,
    localDate,
    localTime: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    periodicSlot: {
      hour: slotHour,
      id: `${localDate}T${pad2(slotHour)}:00:00+08:00`,
    },
  };
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

export function decideNotification({ now = new Date(), currentHash, state }) {
  const schedule = getUtc8Schedule(now);
  const notified = getNotifiedSnapshot(state);
  const changedSinceNotification = currentHash !== notified.hash;
  const periodicDue = !!schedule.periodicSlot && state?.lastPeriodicSlot !== schedule.periodicSlot.id;
  const shouldNotify = !schedule.quiet && (changedSinceNotification || periodicDue);

  return {
    ...schedule,
    notified,
    changedSinceNotification,
    periodicDue,
    shouldNotify,
    reason: changedSinceNotification ? 'change' : (periodicDue ? 'periodic' : 'none'),
  };
}

export function buildNextState({
  now = new Date(),
  entries,
  hash,
  previousState,
  decision,
  notificationCommitted = false,
}) {
  const previousNotified = getNotifiedSnapshot(previousState);
  const committed = decision.shouldNotify && notificationCommitted;

  return {
    schemaVersion: 2,
    checkedAt: now.toISOString(),
    entries,
    hash,
    notifiedAt: committed ? now.toISOString() : previousNotified.notifiedAt,
    notifiedEntries: committed ? entries : previousNotified.entries,
    notifiedHash: committed ? hash : previousNotified.hash,
    lastPeriodicSlot: committed && decision.periodicDue
      ? decision.periodicSlot.id
      : (previousState?.lastPeriodicSlot ?? null),
  };
}
