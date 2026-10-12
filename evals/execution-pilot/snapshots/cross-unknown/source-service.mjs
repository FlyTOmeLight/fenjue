export async function publish(items, deliver) {
  for (const item of items) { await deliver(item); await deliver(item); }
}
