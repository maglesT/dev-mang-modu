// S11 (D-31): the deviation's existing steps shown as DMAIC phases. No new data or rules: derived from the
// deviation step, its CAPAs and the closure's "no CAPA" reason.
export type PhaseState = 'done' | 'current' | 'todo';
export interface Phase { key: 'D' | 'M' | 'A' | 'I' | 'C'; name: string; what: string; where: string; state: PhaseState }

export const PHASES = {
  D: { name: 'Define', what: 'What happened and how serious it is' },
  M: { name: 'Measure', what: 'The facts: impact, other batches checked, repeats' },
  A: { name: 'Analyze', what: 'Why it happened' },
  I: { name: 'Improve', what: 'Fix it and stop it coming back' },
  C: { name: 'Control', what: 'Check the fix works and keep it in place' },
} as const;

export function dmaicPhases(step: string, capaSteps: string[], noCapaReason: string): Phase[] | null {
  if (step === 'rejected') return null;
  const defined = !['classification', 'approval'].includes(step);
  const investigated = step === 'closure' || step === 'closed';
  const closed = step === 'closed';
  const hasCapas = capaSteps.length > 0;
  const improved = (hasCapas && capaSteps.every((s) => s !== 'open')) || (closed && !hasCapas && !!noCapaReason);
  const controlled = closed && capaSteps.every((s) => s === 'closed');
  const state = (done: boolean, current: boolean): PhaseState => (done ? 'done' : current ? 'current' : 'todo');
  return [
    { key: 'D', ...PHASES.D, where: 'Report and classification', state: state(defined, true) },
    { key: 'M', ...PHASES.M, where: 'Impact, other batches, "Things to look at"', state: state(investigated, defined) },
    { key: 'A', ...PHASES.A, where: 'Fishbone, AI help and root cause', state: state(investigated, defined) },
    { key: 'I', ...PHASES.I, where: 'CAPAs', state: state(improved, hasCapas || investigated) },
    { key: 'C', ...PHASES.C, where: 'Effectiveness checks, closure, trends', state: state(controlled, improved || closed) },
  ];
}
