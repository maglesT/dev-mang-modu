// Fishbone (Ishikawa) diagram: possible causes per category, pointing at the deviation (D-26).
// Same categories as FISHBONE in server/deviations.ts (the web build cannot import server code); keep both in step.
// Editable in the investigation form, read-only on the page. Three categories above the spine, three below.
export const FISHBONE = [
  ['man', 'People'], ['machine', 'Machine / equipment'], ['method', 'Method'],
  ['material', 'Material'], ['measurement', 'Measurement'], ['environment', 'Environment'],
] as const;
export type FishboneKey = (typeof FISHBONE)[number][0];
export type FishboneValue = Record<FishboneKey, string>;

export const emptyFishbone = (v?: unknown): FishboneValue =>
  Object.fromEntries(FISHBONE.map(([k]) => [k, String((v as Record<string, unknown> | undefined)?.[k] ?? '')])) as FishboneValue;
export const hasFishbone = (v?: unknown) => FISHBONE.some(([k]) => String((v as Record<string, unknown> | undefined)?.[k] ?? '').trim());

export function Fishbone({ value, effect, onChange }: { value: FishboneValue; effect: string; onChange?: (v: FishboneValue) => void }) {
  const bone = ([k, label]: (typeof FISHBONE)[number]) => (
    <div className="bone" key={k}>
      {onChange ? (
        <label>{label}<textarea aria-label={`Fishbone: ${label}`} rows={3} value={value[k]} placeholder="Possible causes considered"
          onChange={(e) => onChange({ ...value, [k]: e.target.value })} /></label>
      ) : (
        <><b>{label}</b><p>{value[k].trim() || <span className="muted">Nothing noted</span>}</p></>
      )}
    </div>
  );
  return (
    <div className="fishbone" role="group" aria-label="Fishbone diagram">
      <div className="bones">{FISHBONE.slice(0, 3).map(bone)}</div>
      <div className="spine"><span className="spine-line" /><span className="effect">{effect}</span></div>
      <div className="bones">{FISHBONE.slice(3).map(bone)}</div>
    </div>
  );
}
