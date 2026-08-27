#!/usr/bin/env node
/**
 * Age monitor for the *published* snapshot manifest.
 *
 * The build workflow can already shout when a run fails, but that signal is
 * blind to two failure modes: a scheduled run that never started (GitHub
 * disables cron schedules in a repository idle for 60 days) and a run that
 * reported success while nothing new actually landed in R2. Both look
 * identical from the outside — `publishedAt` simply stops moving — and both
 * are what let issue #8 sit unnoticed for six days.
 *
 * So this check deliberately trusts nothing but the public artifact: it reads
 * https://mcpfinder.dev/api/v1/snapshot/manifest.json the way a client would
 * and judges only its age.
 *
 * A frozen publication is *not* an availability incident: the previous
 * complete snapshot keeps being served, byte for byte. What decays is the
 * freshness of the data, which is why the threshold below is generous.
 */
import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { isMainModule } from './verify-snapshot-upload.mjs';

/**
 * Three missed build cycles.
 *
 * The build runs on `17 * / 6 * * *` — every six hours. One failed build is
 * normal operational noise (a registry times out, a runner dies) and the next
 * cycle usually repairs it, so alarming at 6h or 12h would train everyone to
 * ignore this monitor. Eighteen hours means three consecutive cycles produced
 * nothing: that is a stall, not noise.
 */
export const STALENESS_THRESHOLD_HOURS = 18;

const DEFAULT_BASE_URL = 'https://mcpfinder.dev/api/v1/snapshot';

/**
 * Same ladder as scripts/verify-snapshot-upload.mjs, for the same reason: one
 * 502 from the edge, or a DNS blip on the runner, is not evidence that
 * publication stopped. Without these retries a single packet of bad luck files
 * a freeze issue that the next run closes two hours later — precisely the
 * cry-wolf churn the generous 18-hour threshold exists to avoid.
 */
const RETRY_DELAYS_MS = [500, 1_500, 4_500];
/**
 * A stalled connection is worse here than a failed one: the checker is the
 * step that produces the outputs the alarm reads, so a fetch that hangs until
 * the job's `timeout-minutes` elapses means no verdict is ever emitted. Four
 * attempts at 15s cap the whole probe at roughly a minute.
 */
const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * `shared/snapshot-artifacts.js` only builds *data* URLs (`data.sqlite.gz?sha=…`)
 * relative to the snapshot base; there is no helper for the manifest pointer
 * itself, so the path is joined here against the same
 * `MCPFINDER_SNAPSHOT_BASE_URL` override that scripts/verify-snapshot-upload.mjs
 * honours — one env var moves both the preflight and this monitor to a staging
 * Worker.
 */
export function snapshotManifestJsonUrl(baseUrl = process.env.MCPFINDER_SNAPSHOT_BASE_URL ?? DEFAULT_BASE_URL) {
  return `${baseUrl.replace(/\/+$/, '')}/manifest.json`;
}

/**
 * Strict ISO-8601 instant, deliberately narrower than `Date.parse`.
 *
 * `Date.parse` accepts a great deal more than the `toISOString()` output every
 * publisher of this manifest actually writes — including parenthesised
 * comments, which may contain newlines: `Date.parse('Aug 27 2026 (\nx\n)')`
 * succeeds. Since `publishedAt` is remote, attacker-shaped input as far as this
 * monitor is concerned, anything that is not the shape we publish is treated as
 * unreadable rather than fed to a lenient parser.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Why the verdict came out the way it did, as a token that is stable across
 * runs — `age-exceeded`, `http-502`, `no-published-at`.
 *
 * The freeze signature is built from this rather than from `reason`, and the
 * two requirements pull against each other. `reason` carries the age in hours
 * and the offending value, so signing with it would make every two-hourly pass
 * a "new" alarm and undo the throttle. Signing with `state` alone was the
 * opposite failure: `unreadable` because of a 502 and `unreadable` because the
 * manifest stopped carrying a timestamp are different incidents, and a switch
 * from one to the other went unremarked for up to twelve hours. The cause is
 * the middle term: it changes when the problem changes and not otherwise.
 *
 * Every token must therefore match /^[a-z0-9-]+$/ and contain nothing derived
 * from a clock, a run or free-text error copy.
 */
function unreadable(reason, cause) {
  return { state: 'unreadable', reason, cause, publishedAt: '', ageHours: null };
}

/**
 * Classify a manifest as fresh / stale / unreadable.
 *
 * `unreadable` is a first-class alarm state, never a silent success: a
 * manifest we cannot fetch or parse tells us exactly as little about
 * publication health as one that is six days old.
 */
export function evaluateSnapshotFreshness({
  manifest,
  error,
  now = Date.now(),
  thresholdHours = STALENESS_THRESHOLD_HOURS,
} = {}) {
  if (error) {
    return unreadable(
      `the public manifest could not be read: ${error instanceof Error ? error.message : error}`,
      error?.probeCause ?? 'probe-failed',
    );
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return unreadable('the public manifest is not a JSON object', 'not-an-object');
  }
  const publishedAt = manifest.publishedAt;
  if (typeof publishedAt !== 'string' || publishedAt === '') {
    return unreadable('the public manifest carries no `publishedAt` string', 'no-published-at');
  }
  if (!ISO_INSTANT.test(publishedAt)) {
    return unreadable(
      `\`publishedAt\` is not an ISO-8601 instant: ${JSON.stringify(publishedAt)}`,
      'unparseable-timestamp',
    );
  }
  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) {
    return unreadable(
      `\`publishedAt\` is not a parseable timestamp: ${publishedAt}`,
      'unparseable-timestamp',
    );
  }
  const ageHours = Math.round(((now - publishedMs) / 3_600_000) * 10) / 10;
  // A pointer stamped in the future is a broken clock or a corrupted publish,
  // not freshness — reporting it as healthy would hide the very stall we watch
  // for. One hour of tolerance absorbs ordinary runner/CDN skew.
  if (ageHours < -1) {
    return {
      state: 'unreadable',
      reason: `\`publishedAt\` is ${Math.abs(ageHours)}h in the future: ${publishedAt}`,
      cause: 'future-timestamp',
      publishedAt,
      ageHours,
    };
  }
  if (ageHours > thresholdHours) {
    return {
      state: 'stale',
      reason: `the published snapshot is ${ageHours}h old (threshold ${thresholdHours}h, publishedAt ${publishedAt})`,
      cause: 'age-exceeded',
      publishedAt,
      ageHours,
    };
  }
  return {
    state: 'fresh',
    reason: `the published snapshot is ${ageHours}h old (publishedAt ${publishedAt})`,
    cause: 'fresh',
    publishedAt,
    ageHours,
  };
}

/**
 * A probe failure that another attempt might survive. `probeCause` — not the
 * message — is what the freeze signature is built from: the message names the
 * host and the OS error text, which drift between two passes of the same
 * outage, while the cause class does not.
 */
class RetryableManifestError extends Error {
  constructor(message, probeCause) {
    super(message);
    this.probeCause = probeCause;
  }
}

function isRetryableStatus(status) {
  return status === 404 || status === 429 || status >= 500;
}

/** `http-502`, and `http-unknown` for a stub that answers with a non-status. */
function httpCause(status) {
  return `http-${Number.isInteger(status) ? status : 'unknown'}`;
}

async function fetchManifestAttempt({ url, fetchImpl, timeoutMs, setTimer, clearTimer }) {
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new RetryableManifestError(
        `transport failed: ${error instanceof Error ? error.message : error}`,
        'transport',
      );
    }
    if (!response.ok) {
      const message = `HTTP ${response.status}`;
      if (isRetryableStatus(response.status)) {
        throw new RetryableManifestError(message, httpCause(response.status));
      }
      const permanent = new Error(message);
      permanent.probeCause = httpCause(response.status);
      throw permanent;
    }
    try {
      return await response.json();
    } catch (error) {
      // A truncated or half-written body is transport noise, not a verdict:
      // the manifest pointer is overwritten in place on every publish.
      throw new RetryableManifestError(
        `response body was not JSON: ${error instanceof Error ? error.message : error}`,
        'malformed-body',
      );
    }
  } finally {
    clearTimer(timer);
  }
}

/** Fetch the public manifest and classify it. Transport errors never throw. */
export async function checkSnapshotStaleness({
  url = snapshotManifestJsonUrl(),
  fetchImpl = fetch,
  now = Date.now(),
  thresholdHours = STALENESS_THRESHOLD_HOURS,
  retries = RETRY_DELAYS_MS.length,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const attempts = Math.min(Math.max(0, retries), RETRY_DELAYS_MS.length) + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const manifest = await fetchManifestAttempt({
        url,
        fetchImpl,
        timeoutMs,
        setTimer,
        clearTimer,
      });
      return { ...evaluateSnapshotFreshness({ manifest, now, thresholdHours }), url };
    } catch (error) {
      if (!(error instanceof RetryableManifestError)) {
        return { ...evaluateSnapshotFreshness({ error }), url };
      }
      lastError = error;
    }
  }
  // The last attempt's cause is the one that survives into the signature: a
  // 502 that turned into a DNS failure is a different incident, and the
  // exhausted ladder is not one of its own.
  return {
    ...evaluateSnapshotFreshness({
      error: new RetryableManifestError(
        `${attempts} attempts failed, last: ${lastError?.message ?? 'unknown error'}`,
        lastError?.probeCause ?? 'probe-failed',
      ),
    }),
    url,
  };
}

/**
 * Render `key=value` pairs for `$GITHUB_OUTPUT` in the heredoc form, always.
 *
 * The plain `key=value` form ends at the first newline, so *any* value that can
 * carry one lets its source append further outputs of its own choosing. Here
 * the values come from a remote JSON document, which makes that a remote
 * capability: a `publishedAt` carrying a newline could append `state=fresh`
 * after the real verdict, silencing the alarm and making the clear step close
 * the open freeze issue. Rather than sanitising the one field noticed today,
 * every value goes through a per-value random delimiter, which the writer of
 * the value cannot predict and therefore cannot terminate.
 */
export function formatGithubOutputs(values, { randomBytesImpl = randomBytes } = {}) {
  let rendered = '';
  for (const [key, raw] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`refusing to write an unsafe GITHUB_OUTPUT key: ${JSON.stringify(key)}`);
    }
    const value = String(raw ?? '');
    let delimiter;
    do {
      delimiter = `ghadelim_${randomBytesImpl(16).toString('hex')}`;
    } while (value.includes(delimiter));
    rendered += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  return rendered;
}

/**
 * The verdict as the workflow consumes it.
 *
 * `cause` travels alongside `state` because the freeze signature is built from
 * both: a changed cause is new information and must break through the shared
 * script's 12-hour throttle, while a changed age — which is all `reason` gains
 * between two passes of the same stall — must not.
 */
export function stalenessOutputs(verdict) {
  return {
    state: verdict.state,
    cause: verdict.cause,
    age_hours: verdict.ageHours ?? '',
    published_at: verdict.publishedAt,
    // Collapsed for legibility in the issue body, not for safety — the heredoc
    // form above is what makes newlines harmless.
    reason: verdict.reason.replace(/\r?\n/g, ' '),
  };
}

if (await isMainModule({ moduleUrl: import.meta.url })) {
  const verdict = await checkSnapshotStaleness();
  console.log(`[snapshot-staleness] ${verdict.state} (${verdict.cause}): ${verdict.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, formatGithubOutputs(stalenessOutputs(verdict)));
  }
  // Exit 0 even when stale: the alarm is an issue, not a red X nobody reads.
  // A non-zero exit here would only add a second silent failure channel.
}
