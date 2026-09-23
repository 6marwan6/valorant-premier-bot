/**
 * Auth for endpoints an external scheduler (cron-job.org, Upstash QStash —
 * see README "Hosting & Deployment") hits over plain HTTP. Discord's own
 * Ed25519 signature scheme (discord/verifyInteraction.ts) only applies to
 * requests Discord itself sends — a cron endpoint has no equivalent
 * built-in authentication, so without this check anyone who discovers the
 * URL could trigger reminder sends on demand (plan section 55: "Rate
 * limiting where appropriate," "Permission checks before every privileged
 * command" — a cron trigger is exactly that kind of privileged action,
 * just not one a person invokes through Discord).
 *
 * Checked via a bearer token rather than a query-string secret so it
 * doesn't end up logged in plain sight in most HTTP access logs; every
 * external cron provider this project targets supports setting a custom
 * request header.
 */
export function isAuthorizedCronRequest(
  authorizationHeader: string | string[] | undefined,
  cronSecret: string | undefined,
): boolean {
  if (!cronSecret) return false;
  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!header) return false;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return false;
  return timingSafeEqual(token, cronSecret);
}

/**
 * Plain `===` on a secret leaks timing information proportional to how
 * many leading characters match. Low-stakes for a 6-7 person team's
 * private bot, but the fix costs nothing, so applied anyway.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
