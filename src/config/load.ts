import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  appConfigSchema,
  modelWeightsSchema,
  rulesSchema,
  type AppConfig,
  type Config,
  type ModelWeights,
  type Rules,
} from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root, from src/config/ -> ../../ */
export const PROJECT_ROOT = resolve(HERE, '..', '..');
export const CONFIG_DIR = resolve(PROJECT_ROOT, 'config');

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Config files carry `$comment` keys for humans. Strip them recursively so the schemas can stay
 * strict - an unknown key should mean "you made a typo", not "you wrote a note".
 */
export function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key.startsWith('$')) continue;
      out[key] = stripComments(val);
    }
    return out;
  }
  return value;
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Cannot read config file ${path}: ${(cause as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`${path} is not valid JSON: ${(cause as Error).message}`);
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(stripComments(value));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`${path} failed validation:\n${issues}`);
  }
  return result.data;
}

/** `config/local.<name>.json`, when present, shallow-overrides `config/<name>.json` per top-level key. */
function loadWithLocalOverride(name: string, dir: string): unknown {
  const base = readJson(resolve(dir, `${name}.json`));
  const localPath = resolve(dir, `local.${name}.json`);
  if (!existsSync(localPath)) return base;
  const local = readJson(localPath);
  if (typeof base !== 'object' || base === null || typeof local !== 'object' || local === null) {
    throw new ConfigError(`Cannot merge ${localPath}: both files must contain a JSON object`);
  }
  return { ...(base as object), ...(local as object) };
}

function sumValues(map: Record<string, number>): number {
  return Object.values(map).reduce((total, n) => total + n, 0);
}

/**
 * Internal consistency of the rules file. These are the invariants the optimiser relies on;
 * catching a contradiction here beats emitting a squad that cannot legally exist.
 */
export function validateRulesConsistency(rules: Rules): void {
  const problems: string[] = [];

  const squadTotal = sumValues(rules.squad.positionCounts);
  if (squadTotal !== rules.squad.size) {
    problems.push(
      `squad.positionCounts sums to ${squadTotal} but squad.size is ${rules.squad.size}`,
    );
  }

  if (rules.startingXi.size + rules.bench.size !== rules.squad.size) {
    problems.push(
      `startingXi.size (${rules.startingXi.size}) + bench.size (${rules.bench.size}) must equal squad.size (${rules.squad.size})`,
    );
  }

  const squadPositions = Object.keys(rules.squad.positionCounts).sort();
  const xiPositions = Object.keys(rules.startingXi.positionBounds).sort();
  if (squadPositions.join(',') !== xiPositions.join(',')) {
    problems.push(
      `squad.positionCounts covers [${squadPositions.join(', ')}] but startingXi.positionBounds covers [${xiPositions.join(', ')}] - they must describe the same positions`,
    );
  }

  let minStarters = 0;
  let maxStarters = 0;
  for (const [position, bounds] of Object.entries(rules.startingXi.positionBounds)) {
    if (bounds.min > bounds.max) {
      problems.push(`startingXi.positionBounds.${position}: min ${bounds.min} exceeds max ${bounds.max}`);
    }
    const squadCount = rules.squad.positionCounts[position];
    if (squadCount !== undefined && bounds.max > squadCount) {
      problems.push(
        `startingXi.positionBounds.${position}.max (${bounds.max}) exceeds the ${squadCount} ${position} in the squad`,
      );
    }
    minStarters += bounds.min;
    maxStarters += bounds.max;
  }
  if (minStarters > rules.startingXi.size) {
    problems.push(
      `startingXi position minimums sum to ${minStarters}, more than the ${rules.startingXi.size} starters allowed`,
    );
  }
  if (maxStarters < rules.startingXi.size) {
    problems.push(
      `startingXi position maximums sum to ${maxStarters}, fewer than the ${rules.startingXi.size} starters required`,
    );
  }

  for (const [position, benchCount] of Object.entries(rules.bench.positionCounts)) {
    const squadCount = rules.squad.positionCounts[position] ?? 0;
    const bounds = rules.startingXi.positionBounds[position];
    if (bounds && squadCount - bounds.max !== benchCount) {
      problems.push(
        `bench.positionCounts.${position} is ${benchCount}, but ${squadCount} in squad minus at most ${bounds.max} starting implies ${squadCount - bounds.max}`,
      );
    }
  }

  if (rules.transfers.maxBanked < rules.transfers.freePerGameweek) {
    problems.push(
      `transfers.maxBanked (${rules.transfers.maxBanked}) is below transfers.freePerGameweek (${rules.transfers.freePerGameweek})`,
    );
  }

  if (rules.captain.tripleCaptainMultiplier <= rules.captain.multiplier) {
    problems.push(
      `captain.tripleCaptainMultiplier (${rules.captain.tripleCaptainMultiplier}) should exceed captain.multiplier (${rules.captain.multiplier})`,
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `config/rules.json is internally inconsistent:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

/**
 * Reconcile the position codes in config against the element_types the live API actually returns.
 * The spec is explicit that positions are never hardcoded: config declares the *rules* for a
 * position, the API declares which positions exist. A mismatch (a rename, a new position, a
 * position we have no rules for) must stop the run rather than quietly skew a projection.
 */
export function reconcilePositions(rules: Rules, apiPositionCodes: readonly string[]): void {
  const configured = new Set(Object.keys(rules.squad.positionCounts));
  const live = new Set(apiPositionCodes);

  const missingFromConfig = [...live].filter((code) => !configured.has(code));
  const unknownToApi = [...configured].filter((code) => !live.has(code));

  const problems: string[] = [];
  if (missingFromConfig.length > 0) {
    problems.push(
      `the API returned position(s) [${missingFromConfig.join(', ')}] that config/rules.json has no rules for`,
    );
  }
  if (unknownToApi.length > 0) {
    problems.push(
      `config/rules.json defines position(s) [${unknownToApi.join(', ')}] that the API no longer returns`,
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `Position codes are out of step with the live FPL API:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}\nUpdate config/rules.json to match the current season's element_types.`,
    );
  }
}

export function loadRules(dir: string = CONFIG_DIR): Rules {
  const rules = parseOrThrow(rulesSchema, loadWithLocalOverride('rules', dir), `${dir}/rules.json`);
  validateRulesConsistency(rules);
  return rules;
}

export function loadModelWeights(dir: string = CONFIG_DIR): ModelWeights {
  return parseOrThrow(
    modelWeightsSchema,
    loadWithLocalOverride('model.weights', dir),
    `${dir}/model.weights.json`,
  );
}

export function loadAppConfig(dir: string = CONFIG_DIR): AppConfig {
  return parseOrThrow(appConfigSchema, loadWithLocalOverride('app', dir), `${dir}/app.json`);
}

export function loadConfig(dir: string = CONFIG_DIR): Config {
  return {
    rules: loadRules(dir),
    weights: loadModelWeights(dir),
    app: loadAppConfig(dir),
  };
}

/** Resolve a config-relative path (e.g. the database path) against the project root. */
export function resolveFromRoot(path: string): string {
  return resolve(PROJECT_ROOT, path);
}

/** The entry ID, or a clear instruction if it has not been set yet. */
export function requireTeamId(app: AppConfig): number {
  if (app.teamId === null) {
    throw new ConfigError(
      'No FPL team ID configured. Set "teamId" in config/app.json (or config/local.app.json) to ' +
        'the number from your fantasy.premierleague.com URL, e.g. .../entry/1234567/event/1.',
    );
  }
  return app.teamId;
}
