// Negative proof for the client behaviours the smoke suite is supposed to guard:
// each mutation is applied to a THROWAWAY byte-copy of the package and the suite
// is run against it. The source tree and the installed tree are never written —
// which matters because the installed files are hard-linked to the source, so a
// "temporary" edit there is a real edit here.
//
//   node scripts/neg-proof.mjs [pluginDir] [suitePath]
//
// A mutation that produces no failures means the suite has stopped guarding it.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const profileCopy = join(
  homedir(),
  '.dsh',
  'profiles',
  process.env.DSH_PROFILE ?? 'desktop',
  'node_modules',
  'dsh-provider-quota',
);
// The copy is only mutated, so it needs no node_modules: the installed package is
// the useful default, and the repository is the fallback.
const pluginDir =
  process.argv[2] ?? (existsSync(join(profileCopy, 'package.json')) ? profileCopy : repoDir);
const suite = process.argv[3] ?? join(here, 'smoke.mjs');
const stage = mkdtempSync(join(tmpdir(), 'dspq-neg-'));
console.log(`mutating copies of: ${pluginDir}`);

/** The mutations: a label and the replacement that breaks the guarded behaviour. */
const MUTATIONS = [
  {
    label: 'card is never collapsed',
    why: 'the body is mounted unconditionally, which is the shape the card was complained about',
    mutate(code) {
      const mounted = code.replace('\t\t\t\topen ? bodyNode : null,\n', '\t\t\t\tbodyNode,\n');
      if (mounted === code) throw new Error('body mount not found');
      return mounted.replace(
        '\t\t\t\t\th(\n\t\t\t\t\t\t"button",\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tkey: "head",',
        '\t\t\t\t\th(\n\t\t\t\t\t\t"div",\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tkey: "head",',
      );
    },
  },
  {
    label: 'one label hardcoded',
    why: 'a Chinese literal sneaks back in beside the dictionary lookups',
    mutate: (code) => code.replace('t(field.label)', '"预警阈值"'),
  },
  {
    label: 'dictionaries not registered',
    why: 'the locale namespace is never registered, so an English shell renders raw keys',
    mutate: (code) => code.replace('ctx.locale.register(NS, DICTS)', 'void NS'),
  },
  {
    label: 'page ignores the served namespace',
    why: 'the page registers without whileServed, so an unserved namespace still shows a card',
    mutate: (code) => code.replace('return scope.configForms.whileServed([NS], function () {', 'return (function () {'),
  },
];

let proved = 0;
for (const mutation of MUTATIONS) {
  const dir = join(stage, mutation.label.replace(/[^a-z0-9]+/gi, '-'));
  cpSync(pluginDir, dir, {
    recursive: true,
    filter: (src) => !src.slice(pluginDir.length).split(/[\\/]/).includes('node_modules'),
  });
  const clientPath = join(dir, 'lib', 'client.js');
  const before = readFileSync(clientPath, 'utf8');
  const after = mutation.mutate(before);
  if (after === before) throw new Error(`mutation "${mutation.label}" changed nothing — the code it targets moved`);
  writeFileSync(clientPath, after);
  let out = '';
  try {
    out = execFileSync(process.execPath, [suite], {
      env: { ...process.env, DSPQ_PLUGIN_DIR: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const lines = out.split(/\r?\n/);
  const fails = lines.filter((line) => line.includes('  FAIL  '));
  const passes = lines.filter((line) => line.includes('  PASS  ')).length;
  console.log(`\n=== ${mutation.label}`);
  console.log(`    ${mutation.why}`);
  console.log(`    ${passes} PASS, ${fails.length} FAIL`);
  for (const line of fails) console.log(`   ${line.trim()}`);
  if (fails.length > 0) proved += 1;
}

rmSync(stage, { recursive: true, force: true });
console.log(`\nmutations that produced failures: ${proved}/${MUTATIONS.length}`);
process.exit(proved === MUTATIONS.length ? 0 : 1);
