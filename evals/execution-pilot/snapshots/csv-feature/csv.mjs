export function parseCSV(text) { return text.split("\n").map(line => line.split(",")); }
