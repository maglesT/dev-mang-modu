// A complete set of investigation tools (S13, D-33), for tests that sign an investigation.
const m = (checked: string, verdict: 'ruled_in' | 'ruled_out') => ({ checked, evidence: 'Records reviewed', verdict });
export const TOOLS = {
  isIsNot: Object.fromEntries(['what', 'where', 'when', 'who', 'extent'].map((k) => [k, { is: `${k}: this`, isNot: `${k}: not that`, tells: 'Narrows the scope' }])),
  sixM: {
    man: m('Training valid', 'ruled_out'), machine: m('Setting changed after maintenance', 'ruled_in'), method: m('SOP current', 'ruled_out'),
    material: m('Same lot fine elsewhere', 'ruled_out'), measurement: m('Instrument calibrated', 'ruled_out'), environment: m('RH within limits', 'ruled_out'),
  },
  fiveWhys: {
    problem: 'The problem as observed',
    whys: [{ answer: 'Because A', evidence: 'Log 1' }, { answer: 'Because B', evidence: 'Log 2' }, { answer: 'Because no interlock', evidence: 'Design review' }],
  },
  rootCauseCategory: 'equipment',
  barriers: [{ barrier: 'Supervisor check', worked: 'no', whyFailed: 'Supervisor not present' }, { barrier: 'Interlock', worked: 'not_present', whyFailed: 'No interlock fitted' }],
  fmea: { severity: 6, occurrence: 4, detection: 5, patientRisk: 'Soft tablets could break; dose not affected.' },
};
// S14: the KT checklist (lab / OOS types) and a fault tree (critical deviations).
export const KT = {
  analystInterview: 'Analyst followed the method.', hypothesisTesting: 'Re-injected the same solution: same result.',
  checklist: Object.fromEntries(['solutionPrep', 'dilution', 'instrument', 'column', 'calculation', 'glassware', 'labelling'].map((k) => [k, 'ok'])),
  sameSampleReproduces: 'yes', freshPrepReproduces: 'yes', instrumentMalfunctionLogged: 'no', secondAnalystSame: 'yes',
  assignableLabCause: 'no', phase1b: { manufacturingReview: 'Batch record and fishbone reviewed.', retestPlan: 'Two analysts, 6 samples, QC lab.' },
};
export const FAULT_TREE = {
  topEvent: 'Hardness failure', topGate: 'OR',
  branches: [
    { id: 'b1', parent: null, gate: 'AND', text: 'Granules too wet', evidence: 'Drying record 20 min', verdict: 'ruled_in' },
    { id: 'b2', parent: null, gate: 'OR', text: 'Press force low', evidence: 'Force log normal', verdict: 'ruled_out' },
  ],
};
