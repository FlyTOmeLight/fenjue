export function page(records, after, size) {
  const start = after == null ? 0 : records.findIndex(r => r.id === after) + 1;
  const items = records.slice(start, start + size);
  return { items, next: items.length ? items.at(-1).id : null };
}
