// Writes pack.json in a stable, readable layout: objects indented, arrays of plain values on one line.

export function formatPackJson(value: unknown, indent = ''): string {
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) return '[' + value.map((v) => JSON.stringify(v)).join(', ') + ']';
    return '[\n' + value.map((v) => inner + formatPackJson(v, inner)).join(',\n') + '\n' + indent + ']';
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    return '{\n' + entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatPackJson(v, inner)}`).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(value);
}
