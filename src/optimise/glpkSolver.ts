import GLPKFactory from 'glpk.js/node';
import type { Constraint, IntegerProgram, SolveResult, Solver } from './solver.js';

/**
 * GLPK via WebAssembly.
 *
 * Note the import path: the package's default entry point is browser-targeted and fails in
 * Node with "Worker is not defined". `glpk.js/node` is the Node build.
 */

type Glpk = Awaited<ReturnType<typeof GLPKFactory>>;

let glpkPromise: Promise<Glpk> | undefined;

async function getGlpk(): Promise<Glpk> {
  glpkPromise ??= GLPKFactory() as Promise<Glpk>;
  return glpkPromise;
}

function toBounds(glpk: Glpk, constraint: Constraint) {
  const { bound } = constraint;
  switch (bound.type) {
    case 'equal':
      return { type: glpk.GLP_FX, lb: bound.value, ub: bound.value };
    case 'atMost':
      return { type: glpk.GLP_UP, lb: 0, ub: bound.value };
    case 'atLeast':
      return { type: glpk.GLP_LO, lb: bound.value, ub: 0 };
    case 'between':
      // GLPK's double bound requires lb < ub. A range whose ends meet - "exactly one
      // goalkeeper" - is a fixed bound, and passing it as a double bound makes the whole
      // model unsolvable.
      return bound.min === bound.max
        ? { type: glpk.GLP_FX, lb: bound.min, ub: bound.max }
        : { type: glpk.GLP_DB, lb: bound.min, ub: bound.max };
  }
}

export class GlpkSolver implements Solver {
  async solve(program: IntegerProgram): Promise<SolveResult> {
    const glpk = await getGlpk();

    const model = {
      name: program.name,
      objective: {
        direction: program.direction === 'maximise' ? glpk.GLP_MAX : glpk.GLP_MIN,
        name: 'objective',
        vars: program.objective.map((term) => ({ name: term.variable, coef: term.coefficient })),
      },
      subjectTo: program.constraints.map((constraint) => ({
        name: constraint.name,
        vars: constraint.terms.map((term) => ({ name: term.variable, coef: term.coefficient })),
        bnds: toBounds(glpk, constraint),
      })),
      binaries: program.binaries,
    };

    const output = await glpk.solve(model, { msglev: glpk.GLP_MSG_OFF });
    const result = output?.result;

    if (!result || result.status === undefined) {
      // A malformed model can come back with no result at all. Say so, rather than reporting
      // it as an ordinary infeasibility and sending the caller looking in the wrong place.
      return {
        optimal: false,
        status: 'solver returned no result (the model was rejected)',
        objectiveValue: 0,
        values: new Map(),
      };
    }

    const values = new Map<string, number>();
    for (const [name, value] of Object.entries(result.vars ?? {})) {
      // Integer solvers return values like 0.9999999997; snap binaries to whole numbers.
      values.set(name, Math.round((value as number) * 1e6) / 1e6);
    }

    return {
      optimal: result.status === glpk.GLP_OPT,
      status: statusName(glpk, result.status),
      objectiveValue: result.z ?? 0,
      values,
    };
  }
}

function statusName(glpk: Glpk, status: number): string {
  const names: Record<number, string> = {
    [glpk.GLP_OPT]: 'optimal',
    [glpk.GLP_FEAS]: 'feasible',
    [glpk.GLP_INFEAS]: 'infeasible',
    [glpk.GLP_NOFEAS]: 'no feasible solution',
    [glpk.GLP_UNBND]: 'unbounded',
    [glpk.GLP_UNDEF]: 'undefined',
  };
  return names[status] ?? `unknown (${status})`;
}
