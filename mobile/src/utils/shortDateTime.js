const pad = (value) => String(value).padStart(2, "0");

function toValidDate(iso) {
  // new Date(null) is 1970-01-01, not an invalid date, so empty values are rejected up front.
  if (iso == null || iso === "") return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// "2026-10-16T10:17:00Z" -> "10/16 18:17" (device-local time, month and day without leading zeros).
export function formatShortDateTime(iso) {
  const date = toValidDate(iso);
  if (!date) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// "10/16 18:47 - 21:47"; when the range crosses midnight the end carries its own date.
export function formatShortTimeRange(startIso, endIso) {
  const start = toValidDate(startIso);
  const end = toValidDate(endIso);
  if (!start || !end) return "";
  const sameDay = start.toDateString() === end.toDateString();
  const endText = sameDay ? `${pad(end.getHours())}:${pad(end.getMinutes())}` : formatShortDateTime(endIso);
  return `${formatShortDateTime(startIso)} - ${endText}`;
}
