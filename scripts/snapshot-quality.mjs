/**
 * Pure quality checks for snapshot publication. This module deliberately has
 * no database or network dependency so CI behavior can be tested locally.
 */

export const DEFAULT_MAX_DROP_RATIO = 0.05;
const PREVIOUS_MANIFEST_RETRIES = 3;
const PREVIOUS_MANIFEST_TIMEOUT_MS = 20_000;

function finiteCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveCount(value) {
  return finiteCount(value) && value > 0;
}

export function baselineManifestErrors(manifest, requiredSources) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['previous manifest must be an object'];
  if (!positiveCount(manifest.serverCount)) {
    errors.push('previous manifest serverCount must be a positive number');
  }
  if (!manifest.counts || typeof manifest.counts !== 'object') {
    errors.push('previous manifest counts must be an object');
  } else {
    for (const source of requiredSources) {
      if (!positiveCount(manifest.counts[source])) {
        errors.push(`previous manifest counts.${source} must be a positive number`);
      }
    }
  }
  return errors;
}

export function currentSnapshotErrors(current, requiredSources) {
  const errors = [];
  if (!current || typeof current !== 'object') return ['current snapshot must be an object'];
  if (!positiveCount(current.serverCount)) {
    errors.push('current serverCount must be a positive number');
  }
  if (!current.counts || typeof current.counts !== 'object') {
    errors.push('current counts must be an object');
  } else {
    for (const source of requiredSources) {
      if (!positiveCount(current.counts[source])) {
        errors.push(`current counts.${source} must be a positive number`);
      }
    }
  }
  return errors;
}

function sourceHealthMessages(syncLog, sources, kind) {
  const messages = [];
  const bySource = new Map(syncLog.map((entry) => [entry.source, entry]));
  for (const source of sources) {
    const entry = bySource.get(source);
    if (!entry) {
      messages.push(`${kind} source ${source} has no sync_log entry`);
    } else if (entry.status !== 'ok') {
      messages.push(
        `${kind} source ${source} is ${entry.status}` +
          (entry.error ? `: ${entry.error}` : ''),
      );
    }
  }
  return messages;
}

function sourceHealthErrors(syncLog, requiredSources) {
  return sourceHealthMessages(syncLog, requiredSources, 'required');
}

/**
 * Best-effort sources never gate publication. A degraded, skipped, or missing
 * one only warns, so an upstream that closes its API (Glama did on 2026-08-26)
 * cannot stall the snapshot pipeline indefinitely.
 */
function bestEffortSourceWarnings(syncLog, optionalSources) {
  return sourceHealthMessages(syncLog, optionalSources, 'best-effort');
}

/** Sources that did not report a healthy sync in this run. */
function unhealthySources(syncLog, sources) {
  const bySource = new Map(syncLog.map((entry) => [entry.source, entry]));
  return sources.filter((source) => bySource.get(source)?.status !== 'ok');
}

/** Source health and positive current counts, without baseline diagnostics. */
export function evaluateCurrentSnapshotQuality({
  syncLog,
  requiredSources,
  optionalSources = [],
  current,
}) {
  const errors = [
    ...sourceHealthErrors(syncLog, requiredSources),
    ...currentSnapshotErrors(current, requiredSources),
  ];
  return {
    ok: errors.length === 0,
    errors,
    warnings: bestEffortSourceWarnings(syncLog, optionalSources),
    regressionOverridden: false,
  };
}

/**
 * Fetch and validate the last-known-good manifest. Only a 404 is a legitimate
 * no-baseline result. Network errors, 429/5xx, malformed JSON, and schema drift
 * are retried and then fail closed.
 */
export async function fetchPreviousManifest({
  url,
  requiredSources,
  fetchImpl = fetch,
  retries = PREVIOUS_MANIFEST_RETRIES,
  timeoutMs = PREVIOUS_MANIFEST_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 3 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) {
        const error = new Error(`fetch previous manifest: HTTP ${response.status}`);
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
        continue;
      }
      const manifest = await response.json();
      const errors = baselineManifestErrors(manifest, requiredSources);
      if (errors.length > 0) throw new Error(`invalid previous manifest: ${errors.join('; ')}`);
      return manifest;
    } catch (error) {
      lastError = error;
      // Non-retryable 4xx errors are already precise and should fail closed.
      if (/HTTP 4\d\d/.test(error?.message ?? '') && !/HTTP 429/.test(error.message)) throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `previous manifest unavailable after ${retries + 1} attempts: ` +
      (lastError?.message ?? lastError),
  );
}

function regressionMessage(label, current, previous, maxDropRatio) {
  if (!finiteCount(current) || !finiteCount(previous) || previous === 0) return null;
  const dropRatio = (previous - current) / previous;
  if (dropRatio <= maxDropRatio) return null;
  return (
    `${label} dropped from ${previous} to ${current} ` +
    `(${(dropRatio * 100).toFixed(2)}%, allowed ${(maxDropRatio * 100).toFixed(2)}%)`
  );
}

/**
 * Evaluate source health and last-known-good count regressions.
 * Count regressions may be explicitly overridden for a controlled data reset;
 * degraded/missing required sources are never overrideable. Best-effort
 * sources listed in `optionalSources` only ever produce warnings.
 *
 * `previous.serverCount` is a deduplicated row count while `previous.counts.X`
 * are raw per-registry record counts that overlap across registries, so a
 * degraded best-effort source cannot be subtracted from the baseline in any
 * honest way. Instead, when such a source is unhealthy the aggregate
 * `serverCount` regression check is skipped with an explicit warning; the
 * per-source checks for required sources (raw vs raw) keep guarding the gate.
 */
export function evaluateSnapshotQuality({
  syncLog,
  requiredSources,
  optionalSources = [],
  current,
  previous = null,
  maxDropRatio = DEFAULT_MAX_DROP_RATIO,
  allowRegression = false,
}) {
  if (!Number.isFinite(maxDropRatio) || maxDropRatio < 0 || maxDropRatio >= 1) {
    throw new RangeError('maxDropRatio must be a number in the range [0, 1)');
  }

  const errors = [
    ...sourceHealthErrors(syncLog, requiredSources),
    ...currentSnapshotErrors(current, requiredSources),
  ];
  const warnings = bestEffortSourceWarnings(syncLog, optionalSources);

  const regressions = [];
  if (!previous) {
    warnings.push('previous manifest unavailable; count regression check skipped');
  } else {
    const baselineErrors = baselineManifestErrors(previous, requiredSources);
    if (baselineErrors.length > 0) {
      errors.push(...baselineErrors);
      return {
        ok: false,
        errors,
        warnings,
        regressionOverridden: false,
      };
    }

    // A degraded best-effort source legitimately shrinks the corpus, but the
    // baseline cannot be corrected for it: `serverCount` is deduplicated while
    // `counts.X` are raw, overlapping per-registry totals. Skip the aggregate
    // check outright rather than subtract incomparable units.
    const degradedOptional = unhealthySources(syncLog, optionalSources);
    for (const source of degradedOptional) {
      warnings.push(
        `serverCount regression check skipped: best-effort source ${source} is ` +
          `unavailable and its contribution to the deduplicated baseline cannot be isolated`,
      );
    }

    if (degradedOptional.length === 0) {
      const totalRegression = regressionMessage(
        'serverCount',
        current.serverCount,
        previous.serverCount,
        maxDropRatio,
      );
      if (totalRegression) regressions.push(totalRegression);
    }

    for (const source of requiredSources) {
      const sourceRegression = regressionMessage(
        `counts.${source}`,
        current.counts?.[source],
        previous.counts?.[source],
        maxDropRatio,
      );
      if (sourceRegression) regressions.push(sourceRegression);
    }

    // A per-source shrink of a best-effort registry only warns; the aggregate
    // serverCount check above still guards the corpus while that source is
    // healthy, so a real collapse it caused remains a blocking error.
    for (const source of optionalSources) {
      const sourceRegression = regressionMessage(
        `counts.${source}`,
        current.counts?.[source],
        previous.counts?.[source],
        maxDropRatio,
      );
      if (sourceRegression) warnings.push(`best-effort ${sourceRegression}`);
    }
  }

  if (regressions.length > 0) {
    if (allowRegression) {
      warnings.push(`count regression override enabled: ${regressions.join('; ')}`);
    } else {
      errors.push(...regressions);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    regressionOverridden: allowRegression && regressions.length > 0,
  };
}
