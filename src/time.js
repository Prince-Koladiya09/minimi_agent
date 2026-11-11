export function getNow() {
  return process.env.NOW_OVERRIDE ? new Date(process.env.NOW_OVERRIDE) : new Date();
}

function localYmd(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function shiftYmd(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function resolveDatePhrases(input, now, timezone) {
  const today = localYmd(now, timezone);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const out = [];
  const add = (phrase, date, confidence = "high") =>
    out.push({ phrase, start: `${date}T00:00:00`, end: `${date}T23:59:59`, confidence });

  const relative = input.match(/\b(yesterday|today)\b/i);
  if (relative) add(relative[1], relative[1].toLowerCase() === "today" ? today : shiftYmd(today, -1));

  const lastWeekday = input.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  const weekdayOnly = !lastWeekday && input.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  const match = lastWeekday ?? weekdayOnly;
  if (match) {
    const names = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const target = names.indexOf(match[1].toLowerCase());
    let delta = (weekday - target + 7) % 7;
    if (delta === 0 || lastWeekday) delta += 7;
    add(match[0], shiftYmd(today, -delta));
  }

  const dateMatch = input.match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/i);
  if (dateMatch) {
    const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const month = months.indexOf(dateMatch[2].toLowerCase());
    let year = dateMatch[3] ? Number(dateMatch[3]) : Number(today.slice(0,4));
    let date = `${year}-${String(month + 1).padStart(2,"0")}-${String(Number(dateMatch[1])).padStart(2,"0")}`;
    if (!dateMatch[3] && date > today) {
      year--;
      date = `${year}-${String(month + 1).padStart(2,"0")}-${String(Number(dateMatch[1])).padStart(2,"0")}`;
    }
    add(dateMatch[0], date, dateMatch[3] ? "high" : "medium");
  }
  return out;
}
