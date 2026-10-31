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
  const whys = (Array.isArray(x?.whys) ? x.whys : []).map((w) => ({ answer: String(w?.answer ?? ''), evidence: String(w?.evidence ?? '') }));
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

// S14 (D-36): barrier analysis: the checks that should have stopped it, whether they worked, why not.
export interface Barrier { barrier: string; worked: '' | 'yes' | 'no' | 'not_present'; whyFailed: string }
export const emptyBarriers = (v?: unknown): Barrier[] => {
  const rows = (Array.isArray(v) ? v : []).map((b: Partial<Barrier>) => ({ barrier: String(b?.barrier ?? ''), worked: (b?.worked ?? '') as Barrier['worked'], whyFailed: String(b?.whyFailed ?? '') }));
  return rows.length ? rows : [{ barrier: '', worked: '', whyFailed: '' }];
};
const WORKED: Record<string, string> = { yes: 'Worked', no: 'Did not work', not_present: 'Not present' };
export function BarriersEdit({ value, onChange }: { value: Barrier[]; onChange?: (v: Barrier[]) => void }) {
  if (!onChange) {
    return <table className="isnot"><thead><tr><th>Barrier</th><th>Did it work?</th><th>Why it failed</th></tr></thead>
      <tbody>{value.map((b, i) => <tr key={i}><td>{b.barrier}</td><td>{WORKED[b.worked] ?? '—'}</td><td>{b.whyFailed || '—'}</td></tr>)}</tbody></table>;
  }
  const set = (i: number, patch: Partial<Barrier>) => onChange(value.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="form">
      <table className="isnot"><thead><tr><th>Barrier that should have prevented it</th><th>Did it work?</th><th>Why it failed</th><th /></tr></thead>
        <tbody>{value.map((b, i) => (
          <tr key={i}>
            <td><input aria-label={`Barrier ${i + 1}`} value={b.barrier} placeholder="e.g. Supervisor check, interlock" onChange={(e) => set(i, { barrier: e.target.value })} /></td>
            <td><select aria-label={`Barrier ${i + 1}: did it work`} value={b.worked} onChange={(e) => set(i, { worked: e.target.value as Barrier['worked'] })}>
              <option value="">Choose…</option>{Object.entries(WORKED).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select></td>
            <td><input aria-label={`Barrier ${i + 1}: why it failed`} value={b.whyFailed} onChange={(e) => set(i, { whyFailed: e.target.value })} /></td>
            <td>{value.length > 1 && <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</button>}</td>
          </tr>
        ))}</tbody></table>
      <div><button type="button" onClick={() => onChange([...value, { barrier: '', worked: '', whyFailed: '' }])}>Add a barrier</button></div>
    </div>
  );
}

// FMEA: risk to the patient if the CAPA is not done. RPN = severity × occurrence × detection.
export interface Fmea { severity: number; occurrence: number; detection: number; patientRisk: string }
export const emptyFmea = (v?: unknown): Fmea => {
  const x = v as Partial<Fmea> | undefined;
  return { severity: Number(x?.severity ?? 0), occurrence: Number(x?.occurrence ?? 0), detection: Number(x?.detection ?? 0), patientRisk: String(x?.patientRisk ?? '') };
};
export function FmeaEdit({ value, onChange }: { value: Fmea; onChange?: (v: Fmea) => void }) {
  const rpn = value.severity * value.occurrence * value.detection;
  const pick = (k: 'severity' | 'occurrence' | 'detection', label: string, hint: string) => (
    <label>{label} (1–10)<select aria-label={`FMEA: ${label}`} value={value[k]} onChange={(e) => onChange?.({ ...value, [k]: Number(e.target.value) })} title={hint}>
      <option value={0}>Choose…</option>{Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
    </select></label>
  );
  if (!onChange) return <p>Severity {value.severity} × occurrence {value.occurrence} × detection {value.detection} = <b>RPN {rpn}</b>. {value.patientRisk}</p>;
  return (
    <div className="form">
      <div className="grid3">
        {pick('severity', 'Severity', '10 = could seriously harm a patient')}
        {pick('occurrence', 'Occurrence', '10 = will happen again often')}
        {pick('detection', 'Detection', '10 = would not be detected before release')}
      </div>
      <p className="small">Risk priority number: <b>{rpn || '—'}</b>{rpn >= 100 ? ' · high: the CAPA should be strong' : ''}</p>
      <label>Risk to the patient if the CAPA is not done<textarea aria-label="FMEA: risk to the patient" rows={2} value={value.patientRisk} onChange={(e) => onChange({ ...value, patientRisk: e.target.value })} /></label>
    </div>
  );
}

// KT checklist for lab / OOS deviations: Phase 1A in the lab, Phase 1B in manufacturing if no lab cause.
export const KT_CHECKS = [['solutionPrep', 'Solution preparation'], ['dilution', 'Dilution'], ['instrument', 'Instrument'], ['column', 'Column'],
  ['calculation', 'Calculation'], ['glassware', 'Glassware'], ['labelling', 'Labelling']] as const;
export const KT_QUESTIONS = [
  ['sameSampleReproduces', 'Can the OOS be reproduced with the same sample?'],
  ['freshPrepReproduces', 'Can it be reproduced with a fresh sample preparation?'],
  ['instrumentMalfunctionLogged', 'Is there any instrument malfunction log? (attach it)'],
  ['secondAnalystSame', 'Does a second analyst get the same result?'],
] as const;
export type Kt = Record<string, unknown> & { analystInterview: string; hypothesisTesting: string; assignableLabCause: string; checklist: Record<string, string>; phase1b: { manufacturingReview: string; retestPlan: string } };
export const emptyKt = (v?: unknown): Kt => {
  const x = (v ?? {}) as Partial<Kt>;
  return {
    ...Object.fromEntries(KT_QUESTIONS.map(([k]) => [k, String((x as Record<string, unknown>)[k] ?? '')])),
    analystInterview: String(x.analystInterview ?? ''), hypothesisTesting: String(x.hypothesisTesting ?? ''), assignableLabCause: String(x.assignableLabCause ?? ''),
    checklist: Object.fromEntries(KT_CHECKS.map(([k]) => [k, String((x.checklist as Record<string, unknown> | undefined)?.[k] ?? '')])),
    phase1b: { manufacturingReview: String(x.phase1b?.manufacturingReview ?? ''), retestPlan: String(x.phase1b?.retestPlan ?? '') },
  };
};
export function KtEdit({ value, onChange }: { value: Kt; onChange?: (v: Kt) => void }) {
  const ro = !onChange;
  const yn = (k: string, q: string) => (
    <div className="row" key={k} role="radiogroup" aria-label={q}>
      <span className="q">{q}</span>
      {(['yes', 'no'] as const).map((a) => <label className="check" key={a}><input type="radio" disabled={ro} name={`kt-${k}`} checked={value[k] === a} onChange={() => onChange?.({ ...value, [k]: a })} /> {a === 'yes' ? 'Yes' : 'No'}</label>)}
    </div>
  );
  return (
    <div className="form">
      <b>Phase 1A: in the lab (first 24 hours)</b>
      <label>Analyst interview<textarea aria-label="KT: analyst interview" readOnly={ro} rows={2} value={value.analystInterview} onChange={(e) => onChange?.({ ...value, analystInterview: e.target.value })} /></label>
      <table className="isnot"><tbody>{KT_CHECKS.map(([k, l]) => (
        <tr key={k}><th>{l}</th><td>
          <select aria-label={`KT checklist: ${l}`} disabled={ro} value={value.checklist[k]} onChange={(e) => onChange?.({ ...value, checklist: { ...value.checklist, [k]: e.target.value } })}>
            <option value="">Choose…</option><option value="ok">OK</option><option value="error">Error found</option><option value="na">Not applicable</option>
          </select></td></tr>
      ))}</tbody></table>
      {KT_QUESTIONS.map(([k, q]) => yn(k, q))}
      <label>Hypothesis testing (re-injection, fresh preparation)<textarea aria-label="KT: hypothesis testing" readOnly={ro} rows={2} value={value.hypothesisTesting} onChange={(e) => onChange?.({ ...value, hypothesisTesting: e.target.value })} /></label>
      {yn('assignableLabCause', 'Assignable lab cause found, with proof? (if yes, the OOS is invalid)')}
      {value.assignableLabCause === 'no' && <>
        <b>Phase 1B: full-scale (no lab cause found)</b>
        <label>Manufacturing investigation (fishbone and batch record review)<textarea aria-label="KT 1B: manufacturing review" readOnly={ro} rows={2} value={value.phase1b.manufacturingReview} onChange={(e) => onChange?.({ ...value, phase1b: { ...value.phase1b, manufacturingReview: e.target.value } })} /></label>
        <label>Retest plan (samples, by whom, which lab, statistics)<textarea aria-label="KT 1B: retest plan" readOnly={ro} rows={2} value={value.phase1b.retestPlan} onChange={(e) => onChange?.({ ...value, phase1b: { ...value.phase1b, retestPlan: e.target.value } })} /></label>
      </>}
    </div>
  );
}

// Fault tree for critical deviations: the top event, then branches (OR / AND), each tested with evidence.
export interface Branch { id: string; parent: string | null; gate: 'OR' | 'AND'; text: string; evidence: string; verdict: '' | 'ruled_in' | 'ruled_out' }
export interface FaultTree { topEvent: string; topGate: 'OR' | 'AND'; branches: Branch[] }
export const emptyFaultTree = (v?: unknown): FaultTree => {
  const x = (v ?? {}) as Partial<FaultTree>;
  return { topEvent: String(x.topEvent ?? ''), topGate: x.topGate === 'AND' ? 'AND' : 'OR', branches: Array.isArray(x.branches) ? x.branches as Branch[] : [] };
};
export function FaultTreeEdit({ value, onChange }: { value: FaultTree; onChange?: (v: FaultTree) => void }) {
  const ro = !onChange;
  const nextId = () => `b${value.branches.reduce((m, b) => Math.max(m, Number(b.id.slice(1)) || 0), 0) + 1}`;
  const add = (parent: string | null) => onChange?.({ ...value, branches: [...value.branches, { id: nextId(), parent, gate: 'OR', text: '', evidence: '', verdict: '' }] });
  const set = (id: string, patch: Partial<Branch>) => onChange?.({ ...value, branches: value.branches.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  const remove = (id: string) => {
    const gone = new Set([id]);
    let grew = true;
    while (grew) { grew = false; for (const b of value.branches) if (b.parent && gone.has(b.parent) && !gone.has(b.id)) { gone.add(b.id); grew = true; } }
    onChange?.({ ...value, branches: value.branches.filter((b) => !gone.has(b.id)) });
  };
  const gateOf = (parent: string | null) => (parent === null ? value.topGate : value.branches.find((b) => b.id === parent)?.gate ?? 'OR');
  const children = (parent: string | null, depth: number): React.ReactNode =>
    value.branches.filter((b) => b.parent === parent).map((b) => (
      <li key={b.id} style={{ marginLeft: depth ? 18 : 0 }}>
        <span className="chip">{gateOf(parent)}</span>
        {ro ? <> {b.text} <span className="muted small">· {b.evidence}</span> {b.verdict && <span className={`chip ${b.verdict === 'ruled_in' ? 'chip-bad' : 'chip-ok'}`}>{b.verdict === 'ruled_in' ? 'Ruled in' : 'Ruled out'}</span>}</> : (
          <span className="row">
            <input aria-label={`Branch ${b.id}`} value={b.text} placeholder="Possible cause" onChange={(e) => set(b.id, { text: e.target.value })} />
            <input aria-label={`Branch ${b.id}: evidence`} value={b.evidence} placeholder="Evidence" onChange={(e) => set(b.id, { evidence: e.target.value })} />
            <select aria-label={`Branch ${b.id}: verdict`} value={b.verdict} onChange={(e) => set(b.id, { verdict: e.target.value as Branch['verdict'] })}>
              <option value="">Ruled in or out?</option><option value="ruled_in">Ruled in</option><option value="ruled_out">Ruled out</option>
            </select>
            <select aria-label={`Branch ${b.id}: its sub-branches combine with`} value={b.gate} onChange={(e) => set(b.id, { gate: e.target.value as 'OR' | 'AND' })}>
              <option value="OR">sub-branches: OR</option><option value="AND">sub-branches: AND</option>
            </select>
            <button type="button" onClick={() => add(b.id)}>Add sub-branch</button>
            <button type="button" onClick={() => remove(b.id)}>Remove</button>
          </span>
        )}
        <ul className="tree">{children(b.id, depth + 1)}</ul>
      </li>
    ));
  return (
    <div className="form">
      {ro ? <p><b>Top event:</b> {value.topEvent}</p> : (
        <div className="grid2">
          <label>Top event (the failure)<input aria-label="Fault tree: top event" value={value.topEvent} onChange={(e) => onChange!({ ...value, topEvent: e.target.value })} /></label>
          <label>Branches under it combine with<select value={value.topGate} onChange={(e) => onChange!({ ...value, topGate: e.target.value as 'OR' | 'AND' })}><option value="OR">OR</option><option value="AND">AND</option></select></label>
        </div>
      )}
      <ul className="tree">{children(null, 0)}</ul>
      {!ro && <div><button type="button" onClick={() => add(null)}>Add branch</button></div>}
    </div>
  );
}
