
const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday"
];

const MONTHS = [
  "january", "february", "march", "april",
  "may", "june", "july", "august",
  "september", "october", "november", "december"
];

export function getNow() {
  const value = process.env.NOW_OVERRIDE;
  return value ? new Date(value) : new Date();
}

function partsAt(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function localDate(date, timezone) {
  const p = partsAt(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

function shiftDate(ymd, days) {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateParts(ymd) {
  const [year, month, day] = ymd.split("-").map(Number);
  return { year, month, day };
}

function localToUtc(ymd, hour, minute, second, timezone) {
  const { year, month, day } = dateParts(ymd);

  const target = Date.UTC(
    year, month - 1, day, hour, minute, second
  );

  // Iteratively solve the local timezone offset.
  let guess = target;

  for (let i = 0; i < 4; i++) {
    const p = partsAt(new Date(guess), timezone);
    const represented = Date.UTC(
      Number(p.year), Number(p.month) - 1,
      Number(p.day), Number(p.hour),
      Number(p.minute), Number(p.second)
    );

    guess += target - represented;
  }

  return new Date(guess).toISOString();
}

function windowForDate(phrase, date, timezone, confidence = "high") {
  return {
    phrase,
    date,
    start: localToUtc(date, 0, 0, 0, timezone),
    end: localToUtc(date, 23, 59, 59, timezone),
    timezone,
    confidence
  };
}

function dayOfWeek(ymd) {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

function mostRecentWeekday(today, target, allowToday = false) {
  let delta = (dayOfWeek(today) - target + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  return shiftDate(today, -delta);
}

function parseCalendarDate(day, month, year, today) {
  let y = year || Number(today.slice(0, 4));
  const date =
    `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const d = new Date(`${date}T12:00:00Z`);

  if (
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) return null;

  if (!year && date > today) {
    y--;
  }

  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function resolveDatePhrases(input, now, timezone) {
  const text = String(input || "").toLowerCase();
  const today = localDate(now, timezone);
  const found = [];
  const used = new Set();

  const add = (phrase, date, confidence = "high") => {
    if (!date || used.has(date)) return;
    used.add(date);
    found.push(windowForDate(phrase, date, timezone, confidence));
  };

  // Explicit relative days.
  if (/\btoday\b/.test(text)) add("today", today);
  if (/\byesterday\b/.test(text)) {
    add("yesterday", shiftDate(today, -1));
  }

  if (/\btwo days ago\b/.test(text)) {
    add("two days ago", shiftDate(today, -2));
  }

  if (/\bthree days ago\b/.test(text)) {
    add("three days ago", shiftDate(today, -3));
  }

  if (/\bthis morning\b/.test(text)) {
    const date = windowForDate("this morning", today, timezone);
    date.start = localToUtc(today, 5, 0, 0, timezone);
    date.end = localToUtc(today, 12, 0, 0, timezone);
    found.push(date);
  }

  // Last week: Monday through Sunday.
  if (/\blast week\b/.test(text)) {
    const currentMonday = shiftDate(
      today, -((dayOfWeek(today) + 6) % 7)
    );

    const monday = shiftDate(currentMonday, -7);
    const sunday = shiftDate(monday, 6);

    found.push({
      phrase: "last week",
      date: monday,
      start: localToUtc(monday, 0, 0, 0, timezone),
      end: localToUtc(sunday, 23, 59, 59, timezone),
      timezone,
      confidence: "high"
    });
  }

  // Weekdays, including multiple weekday matches.
  const weekdayPattern =
    /\b(last|this|next)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g;

  for (const match of text.matchAll(weekdayPattern)) {
    const modifier = match[1] || "";
    const target = WEEKDAYS.indexOf(match[2]);
    const current = dayOfWeek(today);

    let date;
    let confidence = "medium";

    if (modifier === "next") {
      let delta = (target - current + 7) % 7;
      if (delta === 0) delta = 7;
      date = shiftDate(today, delta);
      confidence = "high";
    } else if (modifier === "last") {
      date = mostRecentWeekday(today, target, false);
      confidence = "high";
    } else if (modifier === "this") {
      date = shiftDate(today, target - current);
      confidence = "high";
    } else {
      date = mostRecentWeekday(today, target, false);
    }

    add(match[0].trim(), date, confidence);
  }

  // 3rd November, November 3, November 3rd.
  const monthFirst =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/g;

  const dayFirst =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/g;

  for (const match of text.matchAll(monthFirst)) {
    const month = MONTHS.indexOf(match[1]) + 1;
    add(match[0], parseCalendarDate(
      Number(match[2]), month,
      match[3] ? Number(match[3]) : null, today
    ), match[3] ? "high" : "medium");
  }

  for (const match of text.matchAll(dayFirst)) {
    const month = MONTHS.indexOf(match[2]) + 1;
    add(match[0], parseCalendarDate(
      Number(match[1]), month,
      match[3] ? Number(match[3]) : null, today
    ), match[3] ? "high" : "medium");
  }

  // Numeric dates: DD/MM, interpreted using day-first convention.
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) continue;

    add(match[0], parseCalendarDate(
      day, month,
      match[3] ? Number(match[3]) : null, today
    ), match[3] ? "high" : "low");
  }

  return found.sort((a, b) => a.start.localeCompare(b.start));
}
