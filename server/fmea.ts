// FMEA scales (D-64): one scale across the suite. These three lists MIRROR the QMS risk assessment
// (QMS server/kinds/risk.ts: SEVERITY, OCCURRENCE, DETECTION) and must stay word for word equal to them.
// They are copied, not imported, because Deviations is also sold on its own.
// Score = S x O x D (1 to 125). An FMEA saved before D-64 has no `scale` and used 1 to 10 (RPN up to 1000):
// it is shown and printed exactly as recorded, marked "old 1-10 scale"; editing it means picking again on 1 to 5.
export const SEVERITY = ['Negligible: no effect on quality or the patient', 'Minor: small effect, no patient harm', 'Moderate: quality defect, patient harm unlikely', 'Major: quality defect, possible patient harm', 'Critical: likely patient harm or recall'];
export const OCCURRENCE = ['Remote: almost never', 'Low: has happened rarely', 'Moderate: happens now and then', 'High: happens often', 'Very high: expected to happen'];
export const DETECTION = ['Almost certain to be detected before release', 'High chance of detection', 'Moderate chance of detection', 'Low chance of detection', 'Cannot be detected'];
export const FMEA_SCALE = 5;

type F = { scale?: unknown; severity?: unknown; occurrence?: unknown; detection?: unknown };
export const isOldFmea = (f: unknown): boolean => !!f && typeof f === 'object' && (f as F).scale !== FMEA_SCALE;

// One line for the screen and the PDF.
export const fmeaLine = (f: F): string => {
  const s = Number(f.severity), o = Number(f.occurrence), d = Number(f.detection);
  if (isOldFmea(f)) return `severity ${s} x occurrence ${o} x detection ${d} = RPN ${s * o * d} (old 1-10 scale)`;
  const w = (list: string[], n: number) => `${n} (${list[n - 1] ?? '?'})`;
  return `severity ${w(SEVERITY, s)} x occurrence ${w(OCCURRENCE, o)} x detection ${w(DETECTION, d)} = score ${s * o * d} of 125`;
};
