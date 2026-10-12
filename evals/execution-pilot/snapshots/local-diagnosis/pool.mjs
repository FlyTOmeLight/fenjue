export async function runPool(jobs, limit) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++;
      try { results.push({ status: 'fulfilled', value: await jobs[index]() }); }
      catch (reason) { results.push({ status: 'rejected', reason }); }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}
