import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PdfPrinter from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { PLANT_TZ } from './deviations.js';

// Copied from the logbook (D-06). Embedded Unicode fonts, so names and symbols print exactly as entered.
// Characters neither font has are printed as a visible code point, never silently changed.
const here = path.dirname(fileURLToPath(import.meta.url));
const FONTS = [path.resolve(here, 'fonts'), path.resolve(here, '../../server/fonts')].find((d) => existsSync(path.join(d, 'NotoSans-Regular.ttf')))!;
const font = (f: string) => path.join(FONTS, f);
const printer = new PdfPrinter({
  Noto: { normal: font('NotoSans-Regular.ttf'), bold: font('NotoSans-Bold.ttf'), italics: font('NotoSans-Regular.ttf'), bolditalics: font('NotoSans-Bold.ttf') },
  NotoMath: { normal: font('NotoSansMath-Regular.ttf'), bold: font('NotoSansMath-Regular.ttf'), italics: font('NotoSansMath-Regular.ttf'), bolditalics: font('NotoSansMath-Regular.ttf') },
});
const fontkit = createRequire(import.meta.url)('@foliojs-fork/fontkit') as { openSync: (f: string) => { hasGlyphForCodePoint: (c: number) => boolean } };
const mainGlyphs = fontkit.openSync(font('NotoSans-Regular.ttf'));
const mathGlyphs = fontkit.openSync(font('NotoSansMath-Regular.ttf'));

// Splits text into runs per font; unknown characters become [U+XXXX].
export function runs(text: string): { text: string; font?: string }[] {
  const out: { text: string; font?: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const ctrl = cp === 10 || cp === 9;
    const [t, f] = ctrl || mainGlyphs.hasGlyphForCodePoint(cp) ? [ch, undefined] : mathGlyphs.hasGlyphForCodePoint(cp) ? [ch, 'NotoMath'] : [`[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`, undefined];
    const last = out.at(-1);
    if (last && last.font === f) last.text += t;
    else out.push(f ? { text: t, font: f } : { text: t });
  }
  return out;
}

// DV-16: plant time with the zone label.
export const plant = (d: Date | string | null) =>
  d ? `${new Date(d).toLocaleString('en-IN', { timeZone: PLANT_TZ, dateStyle: 'medium', timeStyle: 'short' })} IST` : '—';

export const t = (text: unknown, extra: Record<string, unknown> = {}): Content =>
  ({ text: runs(text === null || text === undefined || text === '' ? '—' : String(text)), ...extra }) as Content;
export const heading = (text: string): Content => ({ text: runs(text), bold: true, fontSize: 11, margin: [0, 12, 0, 4] }) as Content;

// Two-column field list.
export const fields = (rows: [string, unknown][]): Content => ({
  table: { widths: [130, '*'], body: rows.map(([k, v]) => [t(k, { bold: true }), t(v)]) },
  layout: 'lightHorizontalLines',
  fontSize: 8,
});

export const table = (head: string[], rows: unknown[][], widths?: (number | string)[]): Content =>
  rows.length === 0
    ? t('None.', { italics: true, fontSize: 8 })
    : ({
        table: { headerRows: 1, widths: widths ?? head.map(() => '*'), body: [head.map((h) => t(h, { bold: true })), ...rows.map((r) => r.map((c) => t(c)))] },
        layout: 'lightHorizontalLines',
        fontSize: 7,
      }) as Content;

// DV-21: a readable true copy with site, title, generation time and the person who printed it.
export function render(siteName: string, title: string, by: string, content: Content[]): Promise<Buffer> {
  const def: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [28, 50, 28, 36],
    defaultStyle: { font: 'Noto', fontSize: 9 },
    header: { text: runs(`${siteName} · ${title}`), margin: [28, 20, 28, 0], fontSize: 9, bold: true },
    footer: (page, pages) => ({
      text: runs(`Generated ${plant(new Date())} by ${by} · true copy of the electronic record · page ${page} of ${pages}`),
      margin: [28, 10, 28, 0],
      fontSize: 7,
    }),
    content,
  };
  const doc = printer.createPdfKitDocument(def);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
