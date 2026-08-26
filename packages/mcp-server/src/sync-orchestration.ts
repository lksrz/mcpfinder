/**
 * Run registry syncs in deterministic order while retaining all-settled
 * semantics: a rejected source is recorded and later sources are still tried.
 */
export async function settleSequentially<T>(
  tasks: Array<() => Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = [];
  for (const task of tasks) {
    try {
      results.push({ status: 'fulfilled', value: await task() });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}
