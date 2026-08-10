/**
 * A minimal integer-programming interface, so the solver is swappable.
 *
 * The app uses GLPK (compiled to WebAssembly) today. Squad selection under budget, position
 * and club constraints is a classic integer program: a solver returns a provably optimal legal
 * squad, where a greedy or brute-force approach over ~700 players could not.
 */

export interface LinearTerm {
  variable: string;
  coefficient: number;
}

export type ConstraintBound =
  | { type: 'equal'; value: number }
  | { type: 'atMost'; value: number }
  | { type: 'atLeast'; value: number }
  | { type: 'between'; min: number; max: number };

export interface Constraint {
  name: string;
  terms: LinearTerm[];
  bound: ConstraintBound;
}

export interface IntegerProgram {
  name: string;
  direction: 'maximise' | 'minimise';
  objective: LinearTerm[];
  constraints: Constraint[];
  /** Variables restricted to 0 or 1. */
  binaries: string[];
}

export interface SolveResult {
  /** True only when the solver proved optimality. */
  optimal: boolean;
  status: string;
  objectiveValue: number;
  /** Variable name -> value. Binary variables come back as 0 or 1. */
  values: Map<string, number>;
}

export interface Solver {
  solve(program: IntegerProgram): Promise<SolveResult>;
}

export class InfeasibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfeasibleError';
  }
}
