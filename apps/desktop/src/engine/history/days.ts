export function localCalendarDay(value: Date): string {
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
