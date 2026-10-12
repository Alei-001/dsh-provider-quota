// Negative proof for the client behaviours the smoke suite is supposed to guard:
// each mutation is applied to a THROWAWAY byte-copy of the package and the suite
// is run against it. The source tree and the installed tree are never written —
// which matters because the installed files are hard-linked to the source, so a
// "temporary" edit there is a real edit here.
//
//   node scripts/neg-proof.mjs [pluginDir] [suitePath]
//
// A mutation that produces no failures means the suite has stopped guarding it.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  {
    label: 'remote answer read as the value',
    why: 'the check takes the answer itself for the bundle list, which is exactly how the update row was lost',
    mutate(code) {
      const direct = code.replace(
        'Promise.resolve(manager.listBundles()).then(remoteResult),',
        'Promise.resolve(manager.listBundles()),',
      );
      if (direct === code) throw new Error('wrapped bundle read not found');
      return direct;
    },
  },
  {
    label: 'unreadable version passes for no update',
    why: 'a comparison that cannot be made answers "current" again, so a broken check looks like an up-to-date install',
    mutate(code) {
      const bail = code.replace('if (installed === null || remote === null) {', 'if (false) {');
      if (bail === code) throw new Error('readability guard not found');
      return bail;
    },
  },
  {
    label: 'update row back inside the body',
    why: 'the row hides behind the disclosure again, so nobody who leaves the card closed ever sees a release',
    mutate(code) {
      const inBody = code.replace('\n\t\t\t\tcheckLine,\n', '\n\t\t\t\tupdateRow,\n\t\t\t\tcheckLine,\n');
      if (inBody === code) throw new Error('body head not found');
      const outOfCard = inBody.replace('\t\t\t\tupdateRow,\n\t\t\t\topen ? bodyNode : null,\n', '\t\t\t\topen ? bodyNode : null,\n');
      if (outOfCard === inBody) throw new Error('card-level row not found');
      return outOfCard;
    },
  },
  {
    label: 'two notices, one state',
    why: 'dismiss writes the save notice again, so the finished-update notice cannot be closed',
    mutate(code) {
      const shared = code.replace('setStoredNotice(null);', 'setSaveNotice(null);');
      if (shared === code) throw new Error('stored-notice setter not found');
      return shared;
    },
  },
  {
    label: 'the hour has no budget',
    why: 'the check cadence is bounded by nothing, so a reader who alt-tabs spends the rate limit',
    mutate(code) {
      const unbounded = code.replace('return recent < CHECKS_PER_HOUR;', 'return true;');
      if (unbounded === code) throw new Error('hourly budget not found');
      return unbounded;
    },
  },
  {
    label: 'a re-check blanks the row',
    why: 'the transient checking status takes the row off the card again, which is where it started',
    mutate(code) {
      const blanked = code.replace(
        'if (previous.status === "idle" || previous.status === "checking") next.status = "checking";',
        'next.status = "checking";',
      );
      if (blanked === code) throw new Error('verdict-keeping guard not found');
      return blanked;
    },
  },
  {
    label: 'a failed re-check withdraws the row',
    why: 'an answer that never came passes for "nothing to install", which is the failure this set out to end',
    mutate(code) {
      const withdrawn = code.replace(
        'if (previous.status === "available" || previous.status === "updated") return kept;',
        'if (false) return kept;',
      );
      if (withdrawn === code) throw new Error('row-keeping guard not found');
      return withdrawn;
    },
  },
  {
    label: 'a check landing after unmount still arms',
    why: 'the promise arms a retry timer after the effect has been torn down, and nothing will clear it',
    mutate(code) {
      const orphaned = code.replace('if (live !== true) return status;', 'if (live === "no") return status;');
      if (orphaned === code) throw new Error('liveness guard not found');
      return orphaned;
    },
  },
  {
    label: 'the list names every adapter',
    why: 'a provider this host does not serve is shown as measurable, when its cell stays empty anyway',
    mutate(code) {
      const unserved = code.replace('if (measured === null) measured = listOf("adapted");', 'measured = listOf("adapted");');
      if (unserved === code) throw new Error('matched fallback not found');
      return unserved;
    },
  },
  {
    label: 'the host stops narrowing the list',
    why: 'the discovery answer offers adapters the host never routes, which is what the page then shows',
    file: 'lib/index.js',
    mutate(code) {
      const unnarrowed = code.replace(
        'const matched = available === null ? adapted : adapted.filter((id) => available.includes(id));',
        'const matched = adapted;',
      );
      if (unnarrowed === code) throw new Error('matched narrowing not found');
      return unnarrowed;
    },
  },
];

let proved = 0;
for (const mutation of MUTATIONS) {
  const dir = join(stage, mutation.label.replace(/[^a-z0-9]+/gi, '-'));
  cpSync(pluginDir, dir, {
    recursive: true,
    filter: (src) => !src.slice(pluginDir.length).split(/[\\/]/).includes('node_modules'),
  });
  // The throwaway copy carries the plugin's dependencies as a link rather than a
  // second install. Without them the suite dies at the host half's peer import —
  // a run that mutates the client half would still show its failures, but the
  // counts would describe a truncated run, and a mutation guarded anywhere after
  // that import would be counted as proved without ever being run.
  const modules = join(pluginDir, 'node_modules');
  if (existsSync(modules)) {
    try {
      symlinkSync(modules, join(dir, 'node_modules'), 'junction');
    } catch (error) {
      console.warn(`    (no dependency link for this copy: ${String(error?.message ?? error)})`);
    }
  }
  // A mutation names its own file: most guards live in the client half, and the
  // discovery answer — the list the page finally shows — is the host's.
  const mutatedPath = join(dir, mutation.file ?? join('lib', 'client.js'));
  const before = readFileSync(mutatedPath, 'utf8');
  const after = mutation.mutate(before);
  if (after === before) throw new Error(`mutation "${mutation.label}" changed nothing — the code it targets moved`);
  writeFileSync(mutatedPath, after);
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
