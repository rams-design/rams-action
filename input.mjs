// Action inputs from the runner env. GitHub uppercases the name and keeps
// hyphens (`api-key` -> INPUT_API-KEY); the underscore form is the fallback.
export function readInput(env, name, dflt) {
  const up = name.toUpperCase();
  const v = env[`INPUT_${up}`] ?? env[`INPUT_${up.replace(/-/g, '_')}`];
  return v === undefined || v === '' ? dflt : v;
}
