/**
 * Validates an IANA timezone identifier.
 *
 * Exists because the plan (section 3) specifies "Europe/frankfurt" as the
 * team's default timezone, but that is NOT a valid IANA zone — Germany has
 * a single zone, "Europe/Berlin". Rather than silently accepting an invalid
 * string that would later break date math (plan section 11: "The bot
 * should validate: Date is valid, Time is valid", section 60: "timezone
 * conversion" is an explicit unit-test target), every place that accepts a
 * timezone from a user (currently /setup; later /create-match) runs it
 * through this check first.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
