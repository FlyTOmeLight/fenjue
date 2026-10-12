export class Projection {
  constructor() { this.values = new Map(); }
  apply(event) { this.values.set(event.id, event.value); }
  get(id) { return this.values.get(id); }
}
