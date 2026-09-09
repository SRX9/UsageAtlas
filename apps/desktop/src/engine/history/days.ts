const dayFormats = new Map<string, Intl.DateTimeFormat>();

export function localCalendarDay(value: Date, timeZone?: string): string {
  if (timeZone) {
    let formatter = dayFormats.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
      dayFormats.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(value);
    const get = (type: string) => parts.find(part => part.type === type)!.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftLocalDay(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return localCalendarDay(date);
}

export function inclusiveDayCount(startDay: string, endDay: string): number {
  const start = new Date(`${startDay}T12:00:00`).valueOf();
  const end = new Date(`${endDay}T12:00:00`).valueOf();
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

export function dayRange(startDay: string, endDay: string): string[] {
  if (endDay < startDay) return [];
  const days: string[] = [];
  let cursor = startDay;
  while (cursor <= endDay) {
    days.push(cursor);
    cursor = shiftLocalDay(cursor, 1);
  }
  return days;
}

export function lookbackDays(earliestMissing: string | null, today: string, maximum = 90): number {
  if (earliestMissing === null || earliestMissing > today) return 1;
  return Math.min(maximum, inclusiveDayCount(earliestMissing, today));
}
