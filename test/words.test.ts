import { describe, expect, it } from 'vitest';
import { actionWords, oosRoomArea, oosWhat, plantDateTime, plantDay, valueWords } from '../server/words.js';

// Display round 20 Nov 2026: one date style, plain words in history lines.
describe('words on screens and PDFs', () => {
  it('screens: "20 Nov, 21:21 IST", the year only when it is not this year', () => {
    const now = new Date('2026-11-21T10:00:00Z');
    expect(plantDateTime('2026-11-20T15:51:30Z', false, now)).toBe('20 Nov, 21:21 IST');
    expect(plantDateTime('2025-11-20T15:51:30Z', false, now)).toBe('20 Nov 2025, 21:21 IST');
    expect(valueWords({ eventAt: '2026-11-20T15:51:00Z' }, '', false)).toMatch(/^Event time: 20 Nov(?: 2026)?, 21:21 IST$/);
  });

  it('PDFs: always "20 Nov 2026, 21:21 IST"; calendar dates "20 Nov 2026" (24-hour, plant time)', () => {
    expect(plantDateTime('2026-11-20T15:51:30Z')).toBe('20 Nov 2026, 21:21 IST');
    expect(plantDateTime('2026-11-19T19:00:00Z')).toBe('20 Nov 2026, 00:30 IST');
    expect(plantDay('2026-09-02')).toBe('2 Sep 2026');
    expect(plantDay('2026-11-20T20:00:00Z')).toBe('21 Nov 2026');
    expect(plantDateTime(null)).toBe('—');
  });

  it('a cancelled report\'s history has no raw keys or JSON', () => {
    expect(actionWords('signed.cancelled')).toBe('Signed: Cancelled: not a deviation');
    expect(actionWords('deviation.cancelled')).toBe('Cancelled by QA: not a deviation');
    expect(actionWords('something_new.done')).toBe('Something new done');
    expect(valueWords({ step: 'classification' })).toBe('Status: Awaiting classification');
    expect(valueWords({ targetDate: '2026-11-21' })).toBe('Target date: 21 Nov 2026');
    expect(valueWords({ signatureId: 1234, automatic: true })).toBe('Signature: 1234; Automatic: yes');
    expect(valueWords({ eventAt: '2026-11-20T15:51:00Z', rows: 1200 })).toBe('Event time: 20 Nov 2026, 21:21 IST; Rows: 1,200');
  });

  it('an EM OOS names its point, room and batch, not a lot', () => {
    const em = { itemKind: 'ROOM', itemCode: 'RM-207', itemName: 'Aseptic filling room', lot: 'RM207-CP1', test: 'Contact plate' };
    expect(oosWhat({ ...em, point: 'RM207-CP1', room: 'RM-207', batch: 'TI260016' })).toBe('Contact plate, point RM207-CP1, room RM-207, taken during batch TI260016');
    // A view without the 0031 columns: the lot_number is the point, the room is the item.
    expect(oosWhat(em)).toBe('Contact plate, point RM207-CP1, room RM-207');
    expect(oosRoomArea(em)).toBe('RM-207 Aseptic filling room');
    expect(oosWhat({ itemKind: 'PRODUCT', itemCode: 'P1', itemName: 'Tablet', lot: 'L1', test: 'Assay' })).toBe('Assay of P1 Tablet, lot L1');
    expect(oosRoomArea({ itemKind: 'PRODUCT', itemCode: 'P1' })).toBeNull();
  });
});
