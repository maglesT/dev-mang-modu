// S13 (D-33, D-35): investigation tools of the owner's method. Plain forms; required on every deviation.
export const IS_IS_NOT = [
  ['what', 'What', 'Which defect or problem, and which not?'],
  ['where', 'Where', 'Which machine, room or line, and which not?'],
  ['when', 'When', 'From when, which batches or shifts, and which not?'],
  ['who', 'Who', 'Which people or shifts were involved, and which not?'],
  ['extent', 'Extent', 'How many or how much is affected, and how much is not?'],
] as const;
export type IsKey = (typeof IS_IS_NOT)[number][0];
export interface IsRow { is: string; isNot: string; tells: string }
export type IsIsNot = Record<IsKey, IsRow>;
export const emptyIsIsNot = (v?: unknown): IsIsNot => Object.fromEntries(IS_IS_NOT.map(([k]) => {
  const x = (v as Record<string, Partial<IsRow>> | undefined)?.[k];
  return [k, { is: String(x?.is ?? ''), isNot: String(x?.isNot ?? ''), tells: String(x?.tells ?? '') }];
})) as IsIsNot;

export function IsIsNotTable({ value, onChange }: { value: IsIsNot; onChange?: (v: IsIsNot) => void }) {
  const set = (k: IsKey, patch: Partial<IsRow>) => onChange?.({ ...value, [k]: { ...value[k], ...patch } });
  return (
    <table className="isnot" aria-label="Is / Is Not">
      <thead><tr><th /><th>Is</th><th>Is not</th><th>What it tells us</th></tr></thead>
      <tbody>
        {IS_IS_NOT.map(([k, label, hint]) => (
          <tr key={k}>
            <th title={hint}>{label}</th>
            {(['is', 'isNot', 'tells'] as const).map((c) => (
              <td key={c}>{onChange
                ? <input aria-label={`${label}: ${c === 'is' ? 'is' : c === 'isNot' ? 'is not' : 'what it tells'}`} value={value[k][c]} placeholder={c === 'is' ? hint : ''} onChange={(e) => set(k, { [c]: e.target.value })} />
                : value[k][c] || '—'}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface Why { answer: string; evidence: string }
export interface FiveWhys { problem: string; whys: Why[] }
export const emptyFiveWhys = (v?: unknown): FiveWhys => {
  const x = v as Partial<FiveWhys> | undefined;
  const whys = (x?.whys ?? []).map((w) => ({ answer: String(w?.answer ?? ''), evidence: String(w?.evidence ?? '') }));
  while (whys.length < 3) whys.push({ answer: '', evidence: '' });
  return { problem: String(x?.problem ?? ''), whys };
};

export function FiveWhysEdit({ value, onChange }: { value: FiveWhys; onChange?: (v: FiveWhys) => void }) {
  const setWhy = (i: number, patch: Partial<Why>) => onChange?.({ ...value, whys: value.whys.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  if (!onChange) {
    return (
      <div>
        <p><b>Problem:</b> {value.problem}</p>
        <ol>{value.whys.map((w, i) => <li key={i}>{w.answer} <span className="muted small">· evidence: {w.evidence}</span></li>)}</ol>
      </div>
    );
  }
  return (
    <div className="form">
      <label>Problem statement<input aria-label="5 Whys: problem statement" value={value.problem} placeholder="e.g. Tablet hardness 2 kg/cm² against 5–8" onChange={(e) => onChange({ ...value, problem: e.target.value })} /></label>
      <ol className="whys">
        {value.whys.map((w, i) => (
          <li key={i}>
            <b>Why {i + 1}?</b>
            <input aria-label={`Why ${i + 1}: answer`} value={w.answer} placeholder="Because…" onChange={(e) => setWhy(i, { answer: e.target.value })} />
            <input aria-label={`Why ${i + 1}: evidence`} value={w.evidence} placeholder="Evidence" onChange={(e) => setWhy(i, { evidence: e.target.value })} />
            {value.whys.length > 3 ? <button type="button" onClick={() => onChange({ ...value, whys: value.whys.filter((_, j) => j !== i) })}>Remove</button> : <span />}
          </li>
        ))}
      </ol>
      {value.whys.length < 7 && <div><button type="button" onClick={() => onChange({ ...value, whys: [...value.whys, { answer: '', evidence: '' }] })}>Ask another why</button></div>}
      <p className="muted small">Keep asking why until you reach a system cause (a missing interlock, an unclear SOP), not just a person.</p>
    </div>
  );
}

export const ROOT_CAUSE_CATEGORY: Record<string, string> = {
  system: 'System', process: 'Process', human: 'Human', equipment: 'Equipment', material: 'Material', environment: 'Environment',
};
