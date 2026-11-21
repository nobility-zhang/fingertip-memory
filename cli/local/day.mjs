export function localDayRange(at, timeZone) {
  if (!Number.isFinite(at)) {
    throw new TypeError('Current timestamp must be finite');
  }
  const current = dateParts(at, timeZone);
  const tomorrow = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  return {
    startAt: wallClockToTimestamp(current, timeZone),
    endAt: wallClockToTimestamp(
      {
        year: tomorrow.getUTCFullYear(),
        month: tomorrow.getUTCMonth() + 1,
        day: tomorrow.getUTCDate(),
      },
      timeZone,
    ),
  };
}

function dateParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
  };
}

function wallClockToTimestamp(parts, timeZone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = dateParts(guess, timeZone);
    const observed = Date.UTC(current.year, current.month - 1, current.day);
    const difference = target - observed;
    guess += difference;
    if (difference === 0) {
      break;
    }
  }
  return guess;
}
