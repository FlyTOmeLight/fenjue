export function createLedger() {
  const rows = new Map();
  return {
    applyBatch(events) {
      for (const event of events) rows.set(event.id, { version: event.version, value: event.value });
    },
    get(id) { return rows.get(id); },
  };
}
