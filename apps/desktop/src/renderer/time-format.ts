export function formatHourOfDay(hour: number): string {
  const normalizedHour = ((hour % 24) + 24) % 24;
  const displayHour = normalizedHour % 12 || 12;
  return `${displayHour}${normalizedHour < 12 ? "am" : "pm"}`;
}