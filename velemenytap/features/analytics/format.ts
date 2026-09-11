export function formatDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString("hu-HU", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
