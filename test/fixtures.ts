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
};
