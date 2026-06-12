import type { EmailAddress } from "@/jmap/types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Display name for the first address: its name, else the bare email, else a placeholder. */
export function senderName(addresses: EmailAddress[] | null): string {
  const first = addresses?.[0];
  if (!first) return "(unknown sender)";
  return first.name?.trim() || first.email;
}

/**
 * Compact, locale-independent timestamp for list rows: time if today, weekday within
 * the past week, "Mon D" earlier this year, "Mon D, YYYY" otherwise. `now` is
 * injectable so the branching is deterministically testable.
 */
export function formatDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === now.toDateString())
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const elapsed = now.getTime() - d.getTime();
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  if (elapsed >= 0 && elapsed < WEEK) return DAYS[d.getDay()] ?? "";
  const month = MONTHS[d.getMonth()] ?? "";
  if (d.getFullYear() === now.getFullYear()) return `${month} ${d.getDate()}`;
  return `${month} ${d.getDate()}, ${d.getFullYear()}`;
}
