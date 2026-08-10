/**
 * A small RFC 4180 CSV reader.
 *
 * Written rather than pulled in: spreadsheet exports are full of quoted commas, embedded
 * newlines and a UTF-8 BOM, and getting those wrong corrupts data silently rather than loudly.
 * This handles all three and nothing else.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Excel prefixes UTF-8 files with a byte-order mark, which otherwise corrupts the first header.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Treat CRLF as one break.
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Header names vary between exports; compare them loosely. */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

export function toTable(text: string): CsvTable {
  const raw = parseCsv(text);
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = raw[0]!.map((header) => normaliseHeader(header));
  const rows = raw.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim();
    });
    return record;
  });

  return { headers, rows };
}

/** Read the first header present from a list of accepted aliases. */
export function pick(row: Record<string, string>, ...aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const value = row[normaliseHeader(alias)];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** A number from a spreadsheet cell. Blank or unparseable becomes null, never NaN. */
export function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value.replace(/[£,]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}
