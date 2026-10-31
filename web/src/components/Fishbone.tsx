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

// S13 (D-33): the 6M fishbone with evidence. For every M: what was checked, the evidence, ruled in or out.
export type Verdict = '' | 'ruled_in' | 'ruled_out';
export interface MCheck { checked: string; evidence: string; verdict: Verdict }
export type SixM = Record<FishboneKey, MCheck>;
export const emptySixM = (v?: unknown): SixM => Object.fromEntries(FISHBONE.map(([k]) => {
  const x = (v as Record<string, Partial<MCheck>> | undefined)?.[k];
  return [k, { checked: String(x?.checked ?? ''), evidence: String(x?.evidence ?? ''), verdict: (x?.verdict ?? '') as Verdict }];
})) as SixM;
const VERDICT: Record<string, string> = { ruled_in: 'Ruled in', ruled_out: 'Ruled out' };

export function SixMDiagram({ value, effect, onChange }: { value: SixM; effect: string; onChange?: (v: SixM) => void }) {
  const set = (k: FishboneKey, patch: Partial<MCheck>) => onChange?.({ ...value, [k]: { ...value[k], ...patch } });
  const bone = ([k, label]: (typeof FISHBONE)[number]) => {
    const m = value[k];
    return (
      <div className={`bone ${m.verdict}`} key={k}>
        {onChange ? (
          <fieldset className="mcheck">
            <legend>{label}</legend>
            <label>What was checked<textarea aria-label={`${label}: what was checked`} rows={2} value={m.checked} onChange={(e) => set(k, { checked: e.target.value })} /></label>
            <label>Evidence<textarea aria-label={`${label}: evidence`} rows={2} value={m.evidence} placeholder="Record, log, certificate…" onChange={(e) => set(k, { evidence: e.target.value })} /></label>
            <div className="row" role="radiogroup" aria-label={`${label}: verdict`}>
              {(['ruled_in', 'ruled_out'] as const).map((v) => (
                <label className="check" key={v}><input type="radio" name={`verdict-${k}`} checked={m.verdict === v} onChange={() => set(k, { verdict: v })} /> {VERDICT[v]}</label>
              ))}
            </div>
          </fieldset>
        ) : (
          <>
            <b>{label}</b> {m.verdict && <span className={`chip ${m.verdict === 'ruled_in' ? 'chip-bad' : 'chip-ok'}`}>{VERDICT[m.verdict]}</span>}
            <p>{m.checked || <span className="muted">Nothing noted</span>}</p>
            {m.evidence && <p className="small"><span className="muted">Evidence:</span> {m.evidence}</p>}
          </>
        )}
      </div>
    );
  };
  return (
    <div className="fishbone" role="group" aria-label="Fishbone diagram">
      <div className="bones">{FISHBONE.slice(0, 3).map(bone)}</div>
      <div className="spine"><span className="spine-line" /><span className="effect">{effect}</span></div>
      <div className="bones">{FISHBONE.slice(3).map(bone)}</div>
    </div>
  );
}
