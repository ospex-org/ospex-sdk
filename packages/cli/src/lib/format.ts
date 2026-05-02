/**
 * Output formatter. Two modes:
 *
 *   json:  serialize with JSON.stringify (BigInt-safe via replacer).
 *   human: terminal-friendly. Arrays of objects render as a table;
 *          single objects render as key/value lines; primitives render
 *          as their string form.
 *
 * Renders to a `Writable` (stdout by default) so tests can capture it.
 */

import Table from 'cli-table3';

export interface FormatOptions {
  json: boolean;
  /** Override target stream — defaults to process.stdout. */
  out?: NodeJS.WritableStream;
}

export function formatOutput(data: unknown, options: FormatOptions): void {
  const stream = options.out ?? process.stdout;
  if (options.json) {
    stream.write(JSON.stringify(data, jsonReplacer, 2) + '\n');
    return;
  }
  stream.write(toHuman(data) + '\n');
}

/** Exported for tests. */
export function toHuman(data: unknown): string {
  if (data === null || data === undefined) return '(empty)';
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }
  if (typeof data === 'bigint') return data.toString();
  if (Array.isArray(data)) {
    if (data.length === 0) return '(no results)';
    if (data.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))) {
      return arrayOfObjectsToTable(data as Array<Record<string, unknown>>);
    }
    return data.map((item) => toHuman(item)).join('\n');
  }
  if (typeof data === 'object') {
    return objectToKeyValueLines(data as Record<string, unknown>);
  }
  return String(data);
}

function arrayOfObjectsToTable(rows: Array<Record<string, unknown>>): string {
  const columns = Array.from(
    rows.reduce<Set<string>>((acc, row) => {
      for (const k of Object.keys(row)) acc.add(k);
      return acc;
    }, new Set()),
  );
  const table = new Table({ head: columns });
  for (const row of rows) {
    table.push(columns.map((c) => formatCell(row[c])));
  }
  return table.toString();
}

function objectToKeyValueLines(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '(empty)';
  const width = Math.max(...keys.map((k) => k.length));
  return keys
    .map((k) => `${k.padEnd(width)}  ${formatCell(obj[k])}`)
    .join('\n');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value, jsonReplacer);
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}
