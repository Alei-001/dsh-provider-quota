// Smoke test for the provider quota plugin, run against a locally installed React.
//
// The client half is a module-loader bundle: it registers a factory that the
// browser materializes later. This reproduces that contract in Node with the
// only module the bundle may require (`react`), renders the registered
// components, and fails if the bundle ever reaches for a Harness Client package
// — `references/practices.md` forbids that, and a throwing factory blanks the
// slot entry rather than reporting anything.
//
// The host half is driven end to end: a fixture upstream and a stub credential
// store go in through the real route handler, and the normalised payload comes
// out.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// React is a test-harness dependency only: the shipped plugin resolves `react`
// from the shell's baseline module table, which no Node install can stand in for.
// Neither default carries machine-specific state:
//  - `DSPQ_HARNESS_DIR` is the directory holding a `react` install, defaulting to
//    the `dspq-harness` folder under the temp dir;
//  - `DSPQ_PLUGIN_DIR` is what the checks read, defaulting to the profile's
//    installed copy when there is one (the host half imports a peer —
//    `@deepseek-ai/schemastery` — that only resolves there) and to this
//    repository otherwise.
const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const profileCopy = join(
  homedir(),
  '.dsh',
  'profiles',
  process.env.DSH_PROFILE ?? 'desktop',
  'node_modules',
  'dsh-provider-quota',
);
const harnessDir = process.env.DSPQ_HARNESS_DIR ?? join(tmpdir(), 'dspq-harness', 'package.json');
const projectDir =
  process.env.DSPQ_PLUGIN_DIR ?? (existsSync(join(profileCopy, 'package.json')) ? profileCopy : repoDir);

const require = createRequire(harnessDir);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/**
 * Materialize the shipped bundle against one require implementation.
 * `@deepseek-ai/dsh-client-ui-primitives` and every other Harness Client package
 * is refused here on purpose: the bundle must not require any of them.
 */
function forbiddenRequire(id) {
  throw new Error(`the bundle required "${id}", which a plain-JS client half must not load`);
}

let capturedCss = '';
const fakeDocument = {
  baseURI: 'http://127.0.0.1:19387/',
  body: {},
  getElementById: () => null,
  createElement: () => ({ id: '', set textContent(value) { capturedCss = value; } }),
  head: { appendChild() {} },
  visibilityState: 'visible',
  listeners: {},
  addEventListener(name, handler) {
    (this.listeners[name] ??= []).push(handler);
  },
  removeEventListener(name, handler) {
    this.listeners[name] = (this.listeners[name] ?? []).filter((entry) => entry !== handler);
  },
  fire(name) {
    for (const handler of [...(this.listeners[name] ?? [])]) handler({ type: name });
  },
};
void capturedCss;

/**
 * The one thing a tab keeps between two loads: the finished-update notice. It is
 * a real store here because "dismiss" has to be provable — the row is written by
 * one card and read by the next, across the reload an update triggers.
 */
const sessionStore = new Map();
const fakeSessionStorage = {
  getItem: (key) => (sessionStore.has(key) ? sessionStore.get(key) : null),
  setItem: (key, value) => sessionStore.set(key, String(value)),
  removeItem: (key) => sessionStore.delete(key),
};

/**
 * A window with the timer, event and storage surface a browser has, and the
 * handles kept so the suite can fire a beat or a tab return by hand. A harness
 * that stubs these into no-ops only proves the bundle's guards work: every
 * cadence this card has lives in that surface, so it is the surface the tests
 * have to drive.
 */
function createShell() {
  return {
    intervals: [],
    timeouts: [],
    listeners: {},
    setInterval(callback, ms) {
      this.intervals.push({ callback, ms, cleared: false });
      return this.intervals.length;
    },
    clearInterval(handle) {
      const timer = this.intervals[handle - 1];
      if (timer !== undefined) timer.cleared = true;
    },
    setTimeout(callback, ms) {
      this.timeouts.push({ callback, ms, cleared: false });
      return this.timeouts.length;
    },
    clearTimeout(handle) {
      const timer = this.timeouts[handle - 1];
      if (timer !== undefined) timer.cleared = true;
    },
    addEventListener(name, handler) {
      (this.listeners[name] ??= []).push(handler);
    },
    removeEventListener(name, handler) {
      this.listeners[name] = (this.listeners[name] ?? []).filter((entry) => entry !== handler);
    },
    fire(name) {
      for (const handler of [...(this.listeners[name] ?? [])]) handler({ type: name });
    },
    pendingTimeouts() {
      return this.timeouts.filter((timer) => timer.cleared !== true);
    },
    /** Fire every armed timeout, as a clock would, and consume its handle. */
    fireTimeouts() {
      for (const timer of this.pendingTimeouts()) {
        timer.cleared = true;
        timer.callback();
      }
    },
  };
}

/** Materialize the shipped bundle against one require implementation. */
function loadBundle(requireImpl) {
  const code = readFileSync(`${projectDir}/lib/client.js`, 'utf8');
  let bundle = null;
  const win = Object.assign(createShell(), {
    __ModuleLoader__: { load(spec) { bundle = spec; } },
    sessionStorage: fakeSessionStorage,
  });
  new Function('window', 'document', code)(win, fakeDocument);
  return { bundle, exports: bundle.factory(requireImpl), win };
}

const liveRequire = (id) => {
  if (id === 'react') return React;
  return forbiddenRequire(id);
};

/** A session model-selection store, as `modelDirectories.directoryFor(id).store` is. */
function storeFor(state) {
  return { subscribe: () => () => {}, getSnapshot: () => state };
}
function selectionFor(provider) {
  return {
    current: provider === null ? null : { provider, model: 'some-model', reasoningEffort: 'max' },
    routable: true,
    groups: [],
    failures: [],
    status: 'ready',
    error: null,
  };
}

/** Run apply() against stub slots + modelDirectories + locale + configForms. */
async function mount(exports) {
  const registrations = [];
  const seen = { inject: [], slotKey: null, slotKeys: [], effects: 0, dictionaries: null, served: null };
  const scope = {
    effect(callback, label) {
      seen.effects += 1;
      return callback();
    },
    slots: {
      inject(key, callback) {
        if (seen.slotKey === null) seen.slotKey = key;
        seen.slotKeys.push(key);
        return callback();
      },
      register(spec, Component) { registrations.push({ spec, Component }); return () => {}; },
    },
    locale: {
      register(namespace, dicts) {
        seen.dictionaries = { namespace, dicts };
        return () => {};
      },
    },
    remote: {
      // The update row's one dependency, as the client remotes expose it: every
      // unary call resolves to `RemoteResult` — `{ ok: true, value }`, or
      // `{ ok: false, error }` — and never to the bare value. A harness that
      // answered with the bare value is what let a dead update check pass this
      // suite: `listBundles` returned an array here and a `RemoteResult` in the
      // browser, so the row never appeared for anyone but the test.
      pluginManager: {
        listBundles() {
          return Promise.resolve({ ok: true, value: [{ name: 'dsh-provider-quota', version: '0.1.0' }] });
        },
        installBundle(spec, options) {
          seen.install = { spec, options };
          return Promise.resolve({
            ok: true,
            value: {
              changed: true,
              application: 'restart-required',
              stage: 'enable',
              target: 'dsh-provider-quota',
              packageResult: { exitCode: 0, output: '' },
            },
          });
        },
      },
    },
    modelDirectories: {
      directoryFor(sessionId) {
        seen.directorySession = sessionId;
        return { store: storeFor(selectionFor('opencode-go')), load: () => Promise.resolve() };
      },
    },
    configForms: {
      // The page registration follows the served namespace, as the host's own
      // settings pages do: a deployment without this namespace shows no page.
      whileServed(namespaces, register) {
        seen.served = namespaces;
        return register(new Set(namespaces));
      },
      get(entryId) {
        seen.configFormFor = entryId;
        // The real controller reads `this.store` inside these methods, so the stub
        // does too: a detached method — the bug that abdicated this entry once —
        // then throws here instead of silently emptying the page in the browser.
        return {
          store: { status: 'ready', value: { warnRemaining: 30, dangerRemaining: 10 }, revision: 7, writable: true },
          subscribe(listener) { return this.store === undefined ? undefined : () => {}; },
          getSnapshot() { return this.store; },
          mutate(operations, revision) { seen.configOps = { operations, revision }; return Promise.resolve(true); },
        };
      },
    },
  };
  await exports.apply({
    effect: (callback) => callback(),
    inject(services, callback) { seen.inject.push(services); return callback(scope); },
    locale: scope.locale,
  });
  return { registrations, seen, scope };
}

// -------------------------------------------------------------- bundle contract
/** Pull the stylesheet back out of rendered markup. */
function cssOf(html) {
  const match = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  return match === null ? '' : match[1];
}

console.log(`under test: ${projectDir}`);
console.log('client half — bundle');
const requested = [];
const live = loadBundle((id) => {
  requested.push(id);
  return liveRequire(id);
});
check('registers one bundle', live.bundle !== null);
check('bundle id is the package name', live.bundle?.id === 'dsh-provider-quota', String(live.bundle?.id));
check('exports apply()', typeof live.exports?.apply === 'function');
check('requires react and nothing else', requested.length === 1 && requested[0] === 'react', requested.join(', '));
check(
  'loads no Harness Client package as a module',
  requested.every((id) => !id.startsWith('@deepseek-ai/')),
  requested.join(', '),
);

// --------------------------------------------------------------- slot placement
console.log('client half — slot placement');
const mounted = await mount(live.exports);
check('waits for slots and modelDirectories', mounted.seen.inject.some((services) => services.includes('slots') && services.includes('modelDirectories')), JSON.stringify(mounted.seen.inject));
check('declares locale and slots in its own inject', Array.isArray(live.exports.inject) && live.exports.inject.includes('locale') && live.exports.inject.includes('slots'), JSON.stringify(live.exports.inject));
check('registers its dictionaries under one namespace', mounted.seen.dictionaries?.namespace === 'provider-quota', String(mounted.seen.dictionaries?.namespace));
check('registers both languages', Object.keys(mounted.seen.dictionaries?.dicts ?? {}).join(',') === 'en,zh', Object.keys(mounted.seen.dictionaries?.dicts ?? {}).join(','));
check('injects the composer tool-row slot', mounted.seen.slotKey === 'conversation.input.right', String(mounted.seen.slotKey));
check('takes the settings form from its own inject', mounted.seen.inject.some((services) => services.includes('configForms')), JSON.stringify(mounted.seen.inject));
check('asks the client remotes for the plugin manager', mounted.seen.inject.some((services) => services.includes('remote.pluginManager')), JSON.stringify(mounted.seen.inject));
check('registers two components', mounted.registrations.length === 2, String(mounted.registrations.length));
const spec = mounted.registrations.find(({ spec }) => spec.name === 'conversation.input.right')?.spec;
check('uses its own cell id', spec?.id === 'provider-quota', spec?.id);
check('orders before the web-search chip (20), placing it to its left', spec?.order === 10, String(spec?.order));
check('reuses no shipped id', spec?.id !== 'search-connection');
check('takes its state from the session directory', mounted.seen.directorySession === 'session-x' || typeof spec?.inject === 'function');
check('declares the locale namespace on the chip', spec?.locale === 'provider-quota', String(spec?.locale));
const pageRegistration = mounted.registrations.find(({ spec }) => spec.name === 'plugins.bundle.config');
check('puts the configuration on the bundle page, not on a row page', mounted.seen.slotKeys.includes('plugins.bundle.config') && !mounted.seen.slotKeys.includes('plugins.row.config'), mounted.seen.slotKeys.join(','));
check('keys that seat by package name', pageRegistration?.spec?.key === 'dsh-provider-quota', String(pageRegistration?.spec?.key));
check('declares the locale namespace on the page too', pageRegistration?.spec?.locale === 'provider-quota', String(pageRegistration?.spec?.locale));
check('and asks the settings mirror for this entry form', mounted.seen.configFormFor === 'provider-quota', String(mounted.seen.configFormFor));
check('follows the served namespace, so an unserved page leaves no trace', mounted.seen.served?.join(',') === 'provider-quota', JSON.stringify(mounted.seen.served));
check('the page component is the settings page', typeof pageRegistration?.Component === 'function');

// ---------------------------------------------------------------------- chip gating
// This is the behaviour the architecture exists for: the cell must be EMPTY for
// a provider no adapter covers, rather than showing another vendor's numbers.
console.log('client half — provider gating');
const renderChip = (exports, provider, adapted) => {
  exports.__internal.__primeAdapted(adapted);
  return renderToStaticMarkup(
    React.createElement(exports.__internal.ProviderQuotaChip, {
      directory: storeFor(selectionFor(provider)),
      load: () => {},
    }),
  );
};

const adaptedBoth = ['opencode-go', 'deepseek-official'];
const supportedHtml = renderChip(live.exports, 'opencode-go', adaptedBoth);
check('renders for an adapted provider', supportedHtml.includes('dsog-chip'));
check('renders for the second adapted provider', renderChip(live.exports, 'deepseek-official', adaptedBoth).includes('dsog-chip'));
check(
  'renders NOTHING for an unadapted provider',
  renderChip(live.exports, 'openai', adaptedBoth) === '',
  renderChip(live.exports, 'openai', adaptedBoth).slice(0, 120),
);
check('renders NOTHING for an unknown provider id', renderChip(live.exports, 'some-new-vendor', adaptedBoth) === '');
check('renders NOTHING with no adapted providers', renderChip(live.exports, 'opencode-go', []) === '');
check(
  'renders NOTHING before the session selection resolves',
  renderChip(live.exports, null, adaptedBoth) === '',
);
check(
  'renders NOTHING before the adapted list arrives',
  renderChip(live.exports, 'opencode-go', null) === '',
);
check('an unadapted provider is not rendered merely by being selected', renderChip(live.exports, 'anthropic', adaptedBoth) === '');
// The slot may inject no face at all; the hooks must still run in a fixed order.
const noStoreHtml = renderToStaticMarkup(React.createElement(live.exports.__internal.ProviderQuotaChip, { load: () => {} }));
check('renders NOTHING without an injected store, without throwing', noStoreHtml === '', noStoreHtml.slice(0, 120));

// -------------------------------------------------------------------- stylesheet
// The stylesheet rides the render tree. A tag injected once from apply() belongs
// to no lifecycle: if a swap drops it, every class stops applying and the chip
// degrades to an unstyled <button> with an invisible SVG ring.
console.log('client half — stylesheet');
const css = cssOf(supportedHtml);
check('carries its stylesheet in the rendered tree', supportedHtml.includes('<style') && supportedHtml.includes('data-provider-quota'), supportedHtml.slice(0, 100));
check('the stylesheet survives a server render intact', css.includes('.dsog-chip{') && css.length > 3000, `len=${css.length}`);
// The panel is its own popover surface now: it paints the host's menu material
// and undoes the UA's popover box, which would otherwise centre it and draw a
// border of its own.
check('panel paints the host popover material', /\.dsog-panel\{[^}]*background:var\(--dsw-menu-surface-fill,var\(--dsw-alias-bg-layer-1\)\)/.test(css));
check('panel blurs like the host menus', css.includes('backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%))'));
check('panel neutralizes the UA popover box', css.includes('.dsog-panel{position:fixed;inset:auto;margin:0;border:.5px solid'));
check('panel keeps no opaque backdrop', css.includes('.dsog-panel::backdrop{background:transparent}'));
check('the card is a disclosure', css.includes('.dsog-card{') && css.includes('.dsog-card-head{') && css.includes('.dsog-card-body{'));
check('the chevron turns when the card opens', css.includes('.dsog-card[data-open="true"] .dsog-chevron{transform:rotate(180deg)}'));
check('chip hover matches the search chip', css.includes('.dsog-chip:hover{background:var(--dsw-alias-interactive-bg-hover)'));
check('open chip uses the active wash', css.includes('.dsog-chip[data-open="true"]{background:var(--dsw-alias-interactive-bg-active)'));
check('no solid layer fill on hover', !/\.dsog-chip:hover\{[^}]*bg-layer/.test(css));
check('panel actions hover the same way', css.includes('.dsog-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover)'));
check('bars are green at rest', css.includes('.dsog-bar-fill[data-tone="ok"]{background:var(--dsw-alias-state-success-primary)}'));
check('bars are amber when low', css.includes('.dsog-bar-fill[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}'));
check('bars are red at the limit', css.includes('.dsog-bar-fill[data-tone="danger"]{background:var(--dsw-alias-state-error-primary)}'));
check('ring is green at rest', css.includes('.dsog-ring-value[data-tone="ok"]{stroke:var(--dsw-alias-state-success-primary)}'));
// Every variable the stylesheet names must be one the live theme defines: the
// `--dsw-alias-*` tokens, the radius/focus/elevation scales, and the two
// menu-surface variables the theme publishes for its own popovers (each of those
// is referenced with an alias fallback).
const liveTokens = new Set([
  ...[
    'bg-base', 'bg-document-preview', 'bg-document-selection', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-mask-1', 'bg-mask-2',
    'bg-mask-3', 'bg-mask-drop', 'bg-mask-photo', 'bg-module-platform', 'bg-multi-select', 'bg-overlay', 'bg-skeleton',
    'border-inverted', 'border-inverted2', 'border-l1', 'border-l2', 'border-l2-darkmode-thin', 'border-l3', 'border-l4',
    'brand-primary', 'brand-primary-invert', 'brand-primary-new-colorprimary-new-color', 'brand-text', 'button-contrast-fill',
    'button-elevated-fill', 'button-floating-fill', 'button-floating-hover', 'button-ghost-active-border', 'button-ghost-active-fill',
    'button-ghost-active-hover', 'button-info-fill', 'button-info-hover', 'button-primary-dimmed', 'button-primary-fill',
    'button-primary-hover', 'button-tool-bar-fill', 'button-tool-bar-fill-invisible', 'button-tool-bar-hover', 'code-diff-added',
    'code-diff-deleted', 'file-diff-added-bg', 'file-diff-added-gutter', 'file-diff-added-marker', 'file-diff-deleted-bg',
    'file-diff-deleted-gutter', 'file-diff-deleted-marker', 'interactive-bg-active', 'interactive-bg-hover', 'interactive-bg-hover-accent',
    'interactive-bg-hover-danger', 'interactive-bg-hover-solid', 'label-caption', 'label-deep-diving', 'label-deep-diving-shimmer',
    'label-dimmed', 'label-document-preview', 'label-primary', 'label-primary-bluish', 'label-primary-dimmed',
    'label-primary-foreground', 'label-primary-inverted', 'label-secondary', 'label-shimmer', 'label-tertiary', 'link',
    'markdown-citation', 'markdown-code-block', 'markdown-code-block-banner', 'markdown-code-segment-selected',
    'markdown-code-segment-unselected', 'markdown-inline-code', 'markdown-placeholder', 'markdown-tag', 'menu-group-header-fill',
    'menu-icon', 'onboarding-accent', 'onboarding-card-fill', 'onboarding-checkbox-border', 'onboarding-secondary-fill',
    'scrollbar-bg-l1', 'scrollbar-bg-l2', 'scrollbar-hover-l1', 'scrollbar-hover-l2', 'settings-card-fill', 'settings-card-stroke',
    'state-business-primary', 'state-business-tertiary', 'state-error-primary', 'state-error-secondary', 'state-idle-primary',
    'state-success-primary', 'state-success-secondary', 'state-success-tertiary', 'state-warn-label', 'state-warn-primary',
    'state-warn-secondary', 'state-warn-tertiary', 'switch-thumb', 'toast-bg', 'toast-label', 'tooltip-bg', 'tooltip-key-bg',
    'turn-trigger-bg', 'turn-trigger-bg-hover',
  ].map((name) => `--dsw-alias-${name}`),
  '--dsw-radius-xs', '--dsw-radius-sm', '--dsw-radius-md', '--dsw-radius-lg', '--dsw-radius-xl', '--dsw-radius-panel',
  '--dsw-focus-ring-color', '--dsw-focus-ring-width',
  '--dsw-elevation-panel', '--dsw-elevation-stroke', '--dsw-elevation-stroke-color',
  '--dsw-menu-surface-fill', '--dsw-menu-backdrop-filter',
]);
const usedTokens = [...new Set(css.match(/--dsw-[a-z0-9-]+/g) ?? [])];
check('only live theme variables are referenced', usedTokens.every((token) => liveTokens.has(token)), usedTokens.filter((t) => !liveTokens.has(t)).join(' '));
check('the only non-alias variables are the theme\'s own surface scales', usedTokens.every((token) => token.startsWith('--dsw-alias-') || /^--dsw-(radius|focus|elevation|menu)-/.test(token)), usedTokens.filter((t) => !t.startsWith('--dsw-alias-') && !/^--dsw-(radius|focus|elevation|menu)-/.test(t)).join(' '));

// The ring must degrade visibly: SVG `stroke` defaults to `none`, so a missing
// stylesheet would erase it entirely without a presentation-attribute fallback.
// Asserted with the panel below, which is where the ring is drawn.
check('the stylesheet is absent when nothing renders', cssOf(renderChip(live.exports, 'openai', adaptedBoth)) === '');

// --------------------------------------------------------------------- the panel
console.log('client half — panel');
const internal = live.exports?.__internal;
const hours = 3600 * 1000;
const ago = (h) => new Date(Date.now() + h * hours).toISOString();

/** The shape the host returns for opencode-go. */
const measuredSnapshot = {
  ok: true,
  provider: 'opencode-go',
  label: 'OpenCode Go',
  primary: 'rolling',
  windows: [
    { key: 'rolling', label: '5 小时窗口', used: 6, remaining: 94, resetsAt: ago(2), value: null, hint: null, tone: 'ok' },
    { key: 'weekly', label: '本周', used: 61, remaining: 39, resetsAt: ago(96), value: null, hint: null, tone: 'warn' },
    { key: 'monthly', label: '本月', used: 41, remaining: 59, resetsAt: ago(624), value: null, hint: null, tone: 'ok' },
  ],
  fetchedAt: Date.now(),
};

/** The shape the host returns for a balance-style provider. */
const valuedSnapshot = {
  ok: true,
  provider: 'deepseek',
  label: 'DeepSeek API',
  primary: 'balance-0',
  windows: [{ key: 'balance-0', label: '账户余额', used: null, remaining: null, resetsAt: null, value: 'CNY 110.00', hint: null, tone: 'ok' }],
  fetchedAt: Date.now(),
};

const renderPanel = (entry) =>
  renderToStaticMarkup(
    React.createElement(internal.Panel, {
      panelRef: React.createRef(),
      position: { left: 120, top: 240 },
      entry,
      provider: entry?.snapshot?.provider ?? 'unknown',
      onRefresh: () => {},
      onClose: () => {},
    }),
  );

const ready = { snapshot: measuredSnapshot, fetchedAt: Date.now(), error: null, warning: null };
const panelHtml = renderPanel(ready);
check('panel renders', panelHtml.includes('dsog-panel'));
check('panel is a popover, so it escapes the row without a portal', panelHtml.includes('popover="manual"'));
check('panel names the provider', panelHtml.includes('OpenCode Go'));
check('panel is positioned at the anchor', panelHtml.includes('left:120px') && panelHtml.includes('top:240px'));
check('header has two local buttons', (panelHtml.match(/class="dsog-icon-button"/g) ?? []).length === 2, String((panelHtml.match(/dsog-icon-button/g) ?? []).length));
check('refresh action draws its own glyph', panelHtml.includes('dsog-icon-refresh'));
check('close action draws its own glyph', panelHtml.includes('dsog-icon-close'));
check('no borrowed control anywhere', !panelHtml.includes('data-prim='));
check('hero draws the primary window as a ring', panelHtml.includes('dsog-ring') && panelHtml.includes('>94%<'));
check(
  'the ring carries a color fallback',
  (panelHtml.match(/<circle[^>]*stroke="currentColor"/g) ?? []).length === 2,
  String((panelHtml.match(/<circle[^>]*stroke="currentColor"/g) ?? []).length),
);
check('hero names the window from the adapter', panelHtml.includes('5 小时窗口'));
check('hero states the used figure', panelHtml.includes('已用 6%'));
check('the status dot takes the window tone', panelHtml.includes('class="dsog-dot" data-tone="ok"'));
check('the remaining two windows are bars', panelHtml.includes('本周') && panelHtml.includes('剩余 39%') && panelHtml.includes('本月') && panelHtml.includes('剩余 59%'));
check('bars fill by remaining quota', panelHtml.includes('width:39%') && panelHtml.includes('width:59%'), panelHtml.match(/width:\d+%/g)?.join(' '));
check('a healthy bar is green', panelHtml.includes('dsog-bar-fill" data-tone="ok"'));
check('every measured window states its reset', (panelHtml.match(/后重置/g) ?? []).length === 3, String((panelHtml.match(/后重置/g) ?? []).length));

// A balance has no percentage: it must render as a value, never as a meter.
const valuedHtml = renderPanel({ snapshot: valuedSnapshot, fetchedAt: Date.now(), error: null, warning: null });
check('a value-only window renders its amount', valuedHtml.includes('CNY 110.00'));
check('a value-only window draws no ring', !valuedHtml.includes('dsog-ring'));
check('a value-only window draws no bar', !valuedHtml.includes('dsog-bar'));
check('a value-only window keeps the provider name', valuedHtml.includes('DeepSeek API'));

const errorHtml = renderPanel({ snapshot: null, fetchedAt: 0, error: '未配置凭据 DEEPSEEK_API_KEY：请在 DSH 凭据中为该名称设置记录', warning: null });
check('panel surfaces a credential error', errorHtml.includes('未配置凭据 DEEPSEEK_API_KEY'));
check('panel reports it has no data yet', errorHtml.includes('尚未获取'));

const staleHtml = renderPanel({ snapshot: measuredSnapshot, fetchedAt: Date.now(), error: null, warning: '上游返回 503' });
check('panel keeps the last good snapshot when a refresh fails', staleHtml.includes('剩余 39%') && staleHtml.includes('上游返回 503'));

// ------------------------------------------------------------------- pure helpers
console.log('client half — helpers');
check('hero is the adapter-named primary', internal.heroOf(measuredSnapshot).key === 'rolling');
check('hero falls back to the first window', internal.heroOf({ primary: 'nope', windows: measuredSnapshot.windows }).key === 'rolling');
check('rest excludes the hero', internal.restOf(measuredSnapshot).map((w) => w.key).join(',') === 'weekly,monthly');
check('a measured window is a meter', internal.isMeasured(measuredSnapshot.windows[0]));
check('a valued window is not a meter', !internal.isMeasured(valuedSnapshot.windows[0]));
check('thresholds: an absent pair falls back to the shipped cut points', JSON.stringify(internal.thresholdsOf(undefined)) === '{"warn":30,"danger":10,"warnValue":0,"dangerValue":0}');
check('thresholds: a published pair is shown as it arrived', internal.thresholdsOf({ warn: 40, danger: 12, warnValue: 7, dangerValue: 2 }).danger === 12);
check('thresholds: an amount pair defaults to disabled', internal.thresholdsOf(undefined).warnValue === 0 && internal.thresholdsOf(undefined).dangerValue === 0);
check('tone: a window the host toned is drawn with the host tone', internal.toneOfWindow({ remaining: 50, tone: 'danger' }) === 'danger');
check('tone: a balance window is drawn with the host tone', internal.toneOfWindow({ value: 'CNY 5.00', tone: 'warn' }) === 'warn');
check('tone: a window with no tone stays neutral', internal.toneOfWindow({ value: 'CNY 5.00' }) === 'unknown');
check('tone: no window at all stays neutral', internal.toneOfWindow(null) === 'unknown');
check('fallback: a balance warning off shows nothing', internal.fallbackValue(internal.PAGE_FIELDS[4], internal.thresholdsOf({ warnValue: 0 })) === null);
check('fallback: a balance warning on shows the value', internal.fallbackValue(internal.PAGE_FIELDS[4], internal.thresholdsOf({ warnValue: 40 })) === 40);
check('the page shows six live fields', internal.PAGE_FIELDS.length === 6, String(internal.PAGE_FIELDS.length));
check('field parsing accepts an in-range integer', internal.parseField(internal.PAGE_FIELDS[0], '25').value === 25);
check('field parsing refuses a fraction', internal.parseField(internal.PAGE_FIELDS[0], '25.5').error !== null);
check('field parsing refuses an out-of-range value', internal.parseField(internal.PAGE_FIELDS[0], '101').error !== null);
check('provider read from the selection', internal.providerOf(selectionFor('opencode-go')) === 'opencode-go');
check('no provider before the selection resolves', internal.providerOf({ current: null }) === null);
check('malformed selection resolves no provider', internal.providerOf({ current: { model: 'x' } }) === null);
check('route path at the root', internal.routePaths('dsh-provider-quota/usage', 'http://127.0.0.1:19387/').join(' ') === '/dsh-provider-quota/usage');
check(
  'route path under a sub-path mount falls back to the root',
  internal.routePaths('dsh-provider-quota/usage', 'http://127.0.0.1:19387/app/').join(' ') === '/app/dsh-provider-quota/usage /dsh-provider-quota/usage',
  internal.routePaths('dsh-provider-quota/usage', 'http://127.0.0.1:19387/app/').join(' '),
);

// ------------------------------------------------------------------- the update
// The row is offered on a version comparison, and the install it triggers is the
// manager's, not ours: the only thing this package decides is the spec.
console.log('client half — update');
check('version: a newer release is newer', internal.isNewer('0.2.0', '0.1.0') === true);
check('version: the same release is not newer', internal.isNewer('0.1.0', '0.1.0') === false);
check('version: an older release is not newer', internal.isNewer('0.1.0', '0.2.0') === false);
check('version: parts compare as numbers, not as text', internal.isNewer('0.10.0', '0.9.0') === true);
check('version: a missing part counts as zero', internal.isNewer('1.0.1', '1.0') === true && internal.isNewer('1.0', '1.0.0') === false);
check(
  'version: a leading v and a prerelease suffix are tolerated',
  internal.isNewer('v1.0.0', '0.9.9') === true && internal.isNewer('1.0.0-rc.1', '1.0.0') === false,
);
check('version: junk never reads as newer', internal.isNewer('banana', '0.1.0') === false && internal.isNewer('0.2.0', null) === false);
const availableDecision = internal.updateDecision('0.1.0', '0.2.0', 'deadbeef');
check('decision: a newer remote offers the update', availableDecision.status === 'available' && availableDecision.sha === 'deadbeef', JSON.stringify(availableDecision));
const currentDecision = internal.updateDecision('0.2.0', '0.2.0', 'deadbeef');
check('decision: an up-to-date install offers nothing', currentDecision.status === 'current' && currentDecision.sha === null, JSON.stringify(currentDecision));
check(
  'bundles: the installed version is read by package name',
  internal.installedVersion([{ name: 'other', version: '9.9.9' }, { name: 'dsh-provider-quota', version: '0.1.0' }]) === '0.1.0',
);
check('bundles: an absent package has no version', internal.installedVersion([]) === null && internal.installedVersion(null) === null);
check(
  'github: the base64 manifest yields its version',
  internal.remoteVersion({ content: Buffer.from(JSON.stringify({ version: '0.2.0' })).toString('base64') }) === '0.2.0',
);
check('github: a malformed answer yields no version', internal.remoteVersion({ content: '!!!' }) === null && internal.remoteVersion(null) === null);
check('failure: a failed run reports its diagnostic', internal.updateFailure({ application: 'failed', error: { diagnostic: 'boom' } }) === 'boom');
check('failure: a non-zero pnpm exit reports its output', internal.updateFailure({ application: 'restart-required', packageResult: { exitCode: 1, output: 'ENOENT' } }) === 'ENOENT');
check('failure: a successful run reports nothing', internal.updateFailure({ application: 'restart-required', packageResult: { exitCode: 0, output: '' } }) === null);
check('failure: a cancelled run is a failure too', internal.updateFailure({ application: 'cancelled' }) === 'cancelled');

// The remote face's own shape. Every unary `ctx.remote` call resolves to
// `RemoteResult` — `{ ok: true, value }` or `{ ok: false, error }` — so the
// bundle list is the value INSIDE the answer. Handing `installedVersion` the
// wrapper is exactly how the update row was lost: it read "installed version
// unknown" in every real deployment, and the row it would have drawn never
// appeared for anyone.
check('remote: an answer carries its value', JSON.stringify(internal.remoteResult({ ok: true, value: [1, 2] })) === '[1,2]');
check('remote: a plain value passes through', internal.remoteResult('plain') === 'plain' && internal.remoteResult(null) === null);
check(
  'remote: a refusal keeps its code and its message',
  (() => {
    try {
      internal.remoteResult({ ok: false, error: { code: 'gateway/offline', message: 'carrier gone' } });
      return false;
    } catch (error) {
      return String(error.message) === 'gateway/offline: carrier gone';
    }
  })(),
);
check(
  'failure: a refused call is a failure, not a success',
  internal.updateFailure({ ok: false, error: { code: 'gateway/offline', message: 'carrier gone' } }) === 'gateway/offline: carrier gone',
);
check(
  'failure: a wrapped failed run reports its diagnostic',
  internal.updateFailure({ ok: true, value: { application: 'failed', error: { diagnostic: 'boom' } } }) === 'boom',
);
check(
  'failure: a wrapped non-zero exit reports its output',
  internal.updateFailure({ ok: true, value: { application: 'restart-required', packageResult: { exitCode: 1, output: 'ENOENT' } } }) === 'ENOENT',
);
check(
  'failure: a wrapped successful run reports nothing',
  internal.updateFailure({ ok: true, value: { application: 'restart-required', packageResult: { exitCode: 0, output: '' } } }) === null,
);

// The whole check, against the shape a deployment really answers with: a wrapped
// bundle list, the published manifest, and the commit a newer release points at.
const realCheckFetch = globalThis.fetch;
const asked = [];
const githubAnswering = (version) => async (url) => {
  asked.push(String(url));
  if (String(url).includes('/contents/package.json')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: Buffer.from(JSON.stringify({ version })).toString('base64') }),
    };
  }
  if (String(url).includes('/commits/')) return { ok: true, status: 200, json: async () => ({ sha: 'deadbeefcafe1234' }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const wrappedBundles = (version) => ({
  listBundles: () => Promise.resolve({ ok: true, value: [{ name: 'dsh-provider-quota', version }] }),
});
globalThis.fetch = githubAnswering('0.2.0');
const availableCheck = await internal.runUpdateCheck(wrappedBundles('0.1.0'));
check(
  'check: a wrapped bundle list yields the row it should',
  availableCheck.status === 'available' &&
    availableCheck.installed === '0.1.0' &&
    availableCheck.remote === '0.2.0' &&
    availableCheck.sha === 'deadbeefcafe1234',
  JSON.stringify(availableCheck),
);
check('check: the commit is read once, and only for a newer release', asked.filter((url) => url.includes('/commits/')).length === 1, asked.join(' '));
globalThis.fetch = githubAnswering('0.1.0');
const currentCheck = await internal.runUpdateCheck(wrappedBundles('0.1.0'));
check('check: an up-to-date install draws nothing', currentCheck.status === 'current', JSON.stringify(currentCheck));
globalThis.fetch = async () => {
  throw new Error('GitHub 403');
};
const failedCheck = await internal.runUpdateCheck(wrappedBundles('0.1.0'));
check(
  'check: a carrier failure says so instead of passing for "no update"',
  failedCheck.status === 'error' && failedCheck.unreadable === false && failedCheck.error === 'GitHub 403',
  JSON.stringify(failedCheck),
);
globalThis.fetch = githubAnswering('0.2.0');
const unknownCheck = await internal.runUpdateCheck({
  listBundles: () => Promise.resolve({ ok: true, value: [{ name: 'another-package', version: '9.9.9' }] }),
});
check(
  'check: a bundle list without this package is unreadable, not current',
  unknownCheck.status === 'error' && unknownCheck.unreadable === true,
  JSON.stringify(unknownCheck),
);
const refusedCheck = await internal.runUpdateCheck({
  listBundles: () => Promise.resolve({ ok: false, error: { code: 'gateway/offline', message: 'carrier gone' } }),
});
check(
  'check: a refused bundle read is reported, not swallowed',
  refusedCheck.status === 'error' && refusedCheck.error === 'gateway/offline: carrier gone',
  JSON.stringify(refusedCheck),
);
check('check: no manager means no check at all', (await internal.runUpdateCheck(null)) === null);
globalThis.fetch = realCheckFetch;

check(
  'spec: the install spec pins the commit in the alias form',
  internal.installSpecFor('deadbeef') === 'dsh-provider-quota@github:Alei-001/dsh-provider-quota#deadbeef',
  internal.installSpecFor('deadbeef'),
);

// ------------------------------------------------------------------- stylesheet
// Covered above, where the shell's own render supplies the stylesheet.

// --------------------------------------------------------------- settings page
console.log('client half — settings page');
const settingsValues = {
  warnRemaining: 30,
  dangerRemaining: 10,
  minIntervalMs: 15000,
  timeoutMs: 10000,
  warnValue: 0,
  dangerValue: 0,
};
const settingsForm = {
  state: { status: 'ready', value: settingsValues, revision: 7, writable: true },
  mutate: () => Promise.resolve(true),
};
const settingsHtml = renderToStaticMarkup(
  React.createElement(live.exports.__internal.ProviderQuotaSettings, { view: 'page', form: settingsForm, defaultOpen: true }),
);
check(
  'the page renders every live field',
  Object.values(settingsValues).every((value) => settingsHtml.includes(`value="${value}"`)),
  settingsHtml.slice(0, 220),
);
check('the page names the balance warning', settingsHtml.includes('余额预警值') && settingsHtml.includes('余额危险值'));
check('the page offers save and restore', settingsHtml.includes('保存') && settingsHtml.includes('恢复默认'));
check('the page names its section', settingsHtml.includes('本机可测量的供应商'));
check('the page shows the two rows the question needs', settingsHtml.includes('已适配') && settingsHtml.includes('本机提供'));
check('the page lists no derived overlap', !settingsHtml.includes('会显示'));
// Two diagnostic rows plus the refresh control, which is disabled while the read
// is in flight and says so.
check('the page shows both rows and its refresh control waiting', (settingsHtml.match(/读取中…/g) ?? []).length === 3, String((settingsHtml.match(/读取中…/g) ?? []).length));
check('the page warns in a count, not a paragraph', !settingsHtml.includes('永远不会显示') && !settingsHtml.includes('会显示'));
check('the page paints from the shared tokens', cssOf(settingsHtml).includes('.dsog-field') && cssOf(settingsHtml).includes('.dsog-pill'));

// The card is a disclosure like the host's own plugin cards: a header that
// names it and states the live cut points, and a body that exists only while it
// is open.
const collapsedHtml = renderToStaticMarkup(
  React.createElement(live.exports.__internal.ProviderQuotaSettings, { view: 'page', form: settingsForm }),
);
check('the card is a list item the host page can lay out', collapsedHtml.startsWith('<li') && collapsedHtml.includes('data-plugin-key="dsh-provider-quota"'), collapsedHtml.slice(0, 120));
check('the card starts collapsed', collapsedHtml.includes('data-open="false"') && collapsedHtml.includes('aria-expanded="false"'));
check('a collapsed card shows no body', !collapsedHtml.includes('class="dsog-card-body"') && !collapsedHtml.includes('<input'), collapsedHtml.slice(0, 200));
check('a collapsed card still states the cut points', collapsedHtml.includes('预警 ≤30%') && collapsedHtml.includes('危险 ≤10%'), collapsedHtml.slice(0, 400));
check('the header is a button with a labelled disclosure', collapsedHtml.includes('aria-label="展开: 供应商额度"') && collapsedHtml.includes('dsog-chevron'));
check('the open card points its header at the body', /aria-controls="([^"]+)"/.test(settingsHtml) && settingsHtml.includes('class="dsog-card-body" id="'));
check('the open card says how to close it', settingsHtml.includes('aria-label="收起: 供应商额度"') && settingsHtml.includes('data-open="true"'));

// The update row: it rides the card rather than its body, so a release is on
// screen whether or not the reader ever expands the disclosure — nobody should
// have to find a new version, or ask for one. The header button itself is
// untouched: same title, same summary, same chevron.
const renderCard = (extra) =>
  renderToStaticMarkup(
    React.createElement(internal.ProviderQuotaSettings, Object.assign({ view: 'page', form: settingsForm, defaultOpen: true }, extra)),
  );
const renderCollapsedCard = () =>
  renderToStaticMarkup(React.createElement(internal.ProviderQuotaSettings, { view: 'page', form: settingsForm }));
const idleUpdate = { status: 'idle', installed: null, remote: null, sha: null, busy: false, error: null, notice: null };
internal.__primeUpdate({ status: 'available', installed: '0.1.0', remote: '0.2.0', sha: 'deadbeefcafe1234', busy: false, error: null, notice: null });
const updateHtml = renderCard({});
const collapsedUpdate = renderCollapsedCard();
// The header button, by its own tags: the stylesheet mentions every class in the
// card, so a slice of the markup has to start after it.
const headStart = updateHtml.indexOf('<button');
const headEnd = updateHtml.indexOf('</button>') + '</button>'.length;
check('an available update adds one row', updateHtml.includes('class="dsog-update"') && updateHtml.includes('有新版本 v0.2.0'), updateHtml.slice(0, 200));
check(
  'the row is one line: what is published, the commit, what is installed',
  updateHtml.includes('有新版本 v0.2.0 → deadbee · 当前 v0.1.0'),
  updateHtml.slice(updateHtml.indexOf('dsog-update'), updateHtml.indexOf('dsog-update') + 300),
);
check('the row offers the update', updateHtml.includes('>更新<'));
check('the row rides the card, under its header button', updateHtml.indexOf('class="dsog-update"') > headEnd);
check('the row sits above the body', updateHtml.indexOf('class="dsog-update"') < updateHtml.indexOf('class="dsog-card-body"'));
check('nothing was added to the header button', headStart > 0 && headEnd > headStart && !updateHtml.slice(headStart, headEnd).includes('dsog-update'));
check(
  'a collapsed card shows the row too',
  collapsedUpdate.includes('class="dsog-update"') &&
    collapsedUpdate.includes('有新版本 v0.2.0') &&
    collapsedUpdate.includes('>更新<') &&
    !collapsedUpdate.includes('class="dsog-card-body"'),
  collapsedUpdate.slice(0, 200),
);
internal.__primeUpdate({ status: 'available', installed: '0.1.0', remote: '0.2.0', sha: 'deadbeefcafe1234', busy: false, error: 'ENOENT', notice: null });
check('a failed update says why in the row', renderCard({}).includes('更新失败：ENOENT'));
internal.__primeUpdate({ status: 'updated', installed: '0.1.0', remote: '0.2.0', sha: null, busy: false, error: null, notice: { version: '0.2.0', application: 'restart-required' } });
const updatedHtml = renderCard({});
check('a finished update leaves the restart notice', updatedHtml.includes('已更新到 v0.2.0') && updatedHtml.includes('重启 DSH') && updatedHtml.includes('知道了'));
check('the finished notice replaces the update button', !updatedHtml.includes('>更新<'));
check('the finished notice rides the card as well', !renderCollapsedCard().includes('class="dsog-card-body"') && renderCollapsedCard().includes('已更新到 v0.2.0'));
internal.__primeUpdate({ status: 'error', installed: null, remote: null, sha: null, busy: false, error: null, checkError: 'GitHub 403', checkUnreadable: false, notice: null });
const failedCheckHtml = renderCard({});
check(
  'a check that could not answer says so in the body',
  failedCheckHtml.includes('版本检查失败：GitHub 403') &&
    failedCheckHtml.indexOf('版本检查失败') > failedCheckHtml.indexOf('class="dsog-card-body"'),
  failedCheckHtml.slice(failedCheckHtml.indexOf('dsog-card-body'), failedCheckHtml.indexOf('dsog-card-body') + 300),
);
check('and says nothing in the header', !renderCollapsedCard().includes('版本检查失败'));
internal.__primeUpdate({ status: 'error', installed: null, remote: null, sha: null, busy: false, error: null, checkError: null, checkUnreadable: true, notice: null });
check('an unreadable answer says which half is missing', renderCard({}).includes('读不到已安装版本或仓库版本'));
internal.__primeUpdate({ status: 'current', installed: '0.2.0', remote: '0.2.0', sha: null, busy: false, error: null, notice: null });
const currentHtml = renderCard({});
check('an up-to-date install shows no update row', !currentHtml.includes('class="dsog-update"') && !currentHtml.includes('更新'), currentHtml.slice(0, 160));
check('a collapsed up-to-date card shows no row either', !renderCollapsedCard().includes('class="dsog-update"'));
internal.__primeUpdate(idleUpdate);
check(
  'the page says so when the Host offers no form',
  renderToStaticMarkup(
    React.createElement(live.exports.__internal.ProviderQuotaSettings, { view: 'page', form: undefined, defaultOpen: true }),
  ).includes('没有可写的表单'),
);
const noFormHtml = renderToStaticMarkup(
  React.createElement(live.exports.__internal.ProviderQuotaSettings, { view: 'page', form: undefined, defaultOpen: true }),
);
check(
  'without a form the cut points still show the shipped values',
  noFormHtml.includes('value="30"') && noFormHtml.includes('value="10"'),
  noFormHtml.slice(0, 260),
);
const summaryHtml = renderToStaticMarkup(
  React.createElement(live.exports.__internal.ProviderQuotaSettings, { view: 'summary', form: settingsForm }),
);
check('the summary view states the cut points', summaryHtml.includes('预警') && summaryHtml.includes('30'), summaryHtml);

// ------------------------------------------------------- the write path
// No server render reaches the page's handlers: they run in response to clicks.
// A minimal ReactCurrentDispatcher services the hooks so the component can be
// invoked directly and its `onChange`/`onClick` props called, which is the only
// way this suite can reach what `form.mutate` is handed.
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    adapted: ['opencode-go', 'deepseek-official', 'deepseek', 'deepseek-account'],
    available: ['opencode-go', 'deepseek-official', 'deepseek-account', 'openai'],
    matched: ['opencode-go', 'deepseek-official', 'deepseek-account'],
    thresholds: { warn: 30, danger: 10 },
  }),
});

/**
 * Render any page component with a minimal dispatcher, so click handlers run.
 * `useSyncExternalStore` calls the getter it was handed, exactly as React does:
 * a getter detached from its form then throws here, which is the bug that once
 * abdicated the bundle-config entry and left the page silently empty.
 *
 * Slot state, refs and memos persist across renders, as they do in an instance:
 * a rig that hands back a fresh ref every render silently disarms every ref-based
 * decision in the code under test (the retry allowance among them), and a
 * `useCallback` that never memoizes re-runs every effect that depends on it.
 *
 * With `{ effects: true }` the rig also runs effects after each pass and honours
 * their deps and cleanups, which is how the card's own cadence — the mount check,
 * the tab return, the beat, the retry — becomes reachable from this suite. The
 * returned render function carries `cleanup()` for unmount.
 */
function hookRender(Component, props, options) {
  const runEffects = options?.effects === true;
  const states = [];
  const setters = [];
  const refs = [];
  const memos = [];
  const effects = [];
  const cursor = { value: 0 };
  const refCursor = { value: 0 };
  const memoCursor = { value: 0 };
  const effectCursor = { value: 0 };
  const dispatcher = {
    useState(initial) {
      const index = cursor.value;
      cursor.value += 1;
      if (!(index in states)) {
        states[index] = initial;
        setters[index] = (value) => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        };
      }
      return [states[index], setters[index]];
    },
    useEffect(callback, deps) {
      const index = effectCursor.value;
      effectCursor.value += 1;
      if (!runEffects) return undefined;
      const previous = effects[index];
      const changed =
        previous === undefined ||
        deps === undefined ||
        previous.deps === undefined ||
        deps.length !== previous.deps.length ||
        deps.some((entry, position) => !Object.is(entry, previous.deps[position]));
      if (changed) effects[index] = { deps, callback, pending: true, cleanup: previous?.cleanup };
      return undefined;
    },
    useLayoutEffect(callback, deps) {
      return dispatcher.useEffect(callback, deps);
    },
    useCallback(handler, deps) {
      return memoized(() => handler, deps);
    },
    useMemo(factory, deps) {
      return memoized(factory, deps);
    },
    useRef(value) {
      const index = refCursor.value;
      refCursor.value += 1;
      if (!(index in refs)) refs[index] = { current: value };
      return refs[index];
    },
    useSyncExternalStore(subscribe, snapshot) {
      if (typeof subscribe === 'function') subscribe(() => {});
      return snapshot();
    },
    readContext() { return undefined; },
  };
  function memoized(factory, deps) {
    const index = memoCursor.value;
    memoCursor.value += 1;
    const previous = memos[index];
    const same =
      previous !== undefined &&
      deps !== undefined &&
      previous.deps !== undefined &&
      deps.length === previous.deps.length &&
      deps.every((entry, position) => Object.is(entry, previous.deps[position]));
    if (!same) memos[index] = { deps, value: factory() };
    return memos[index].value;
  }
  function commit() {
    for (const slot of effects) {
      if (slot === undefined || slot.pending !== true) continue;
      slot.pending = false;
      if (typeof slot.cleanup === 'function') slot.cleanup();
      const cleanup = slot.callback();
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    }
  }
  const render = () => {
    cursor.value = 0;
    refCursor.value = 0;
    memoCursor.value = 0;
    effectCursor.value = 0;
    internals.ReactCurrentDispatcher.current = dispatcher;
    let node = null;
    try {
      // Expand function components so a seat wrapper's inner page is reachable;
      // hook slots keep counting across the expansion, as they do in React.
      node = Component(props);
      for (let depth = 0; depth < 4 && node !== null && typeof node === 'object' && typeof node.type === 'function'; depth += 1) {
        node = node.type(node.props);
      }
    } finally {
      internals.ReactCurrentDispatcher.current = null;
    }
    if (runEffects) commit();
    return node;
  };
  render.cleanup = () => {
    for (const slot of effects) {
      if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup();
      if (slot !== undefined) slot.cleanup = undefined;
    }
  };
  return render;
}

function settingsRig(form, outcome) {
  const ops = [];
  const wired = Object.assign({}, form, {
    mutate: (operations, revision) => {
      ops.push({ operations: structuredClone(operations), revision });
      return outcome();
    },
  });
  const render = hookRender(live.exports.__internal.ProviderQuotaSettings, { view: 'page', form: wired, defaultOpen: true });
  return { render, ops };
}

function find(node, predicate) {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = find(item, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(node) === true) return node;
  return find(node.props?.children, predicate);
}
const firstInput = (tree) => find(tree, (node) => node.type === 'input');
const button = (tree, label) => find(tree, (node) => node.type === 'button' && node.props?.children === label);
const notice = (tree, text) => find(tree, (node) => typeof node.props?.children === 'string' && node.props.children.includes(text));

const readyForm = { state: { status: 'ready', value: settingsValues, revision: 7, writable: true } };

const saved = settingsRig(readyForm, () => Promise.resolve(true));
check('the save control is reachable', typeof button(saved.render(), '保存')?.props.onClick === 'function');
firstInput(saved.render()).props.onChange({ target: { value: '45' } });
check('an edit lands in the draft', firstInput(saved.render()).props.value === '45');
await button(saved.render(), '保存').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  'an accepted write sends a number, the field path and the revision the page read',
  JSON.stringify(saved.ops[0]) === '{"operations":[{"op":"set","path":["warnRemaining"],"value":45}],"revision":7}',
  JSON.stringify(saved.ops[0]),
);
check('an accepted write clears the draft', firstInput(saved.render()).props.value === '30');
check('an accepted write reports success', notice(saved.render(), '已保存') !== null);

const refused = settingsRig(readyForm, () => Promise.resolve(false));
firstInput(refused.render()).props.onChange({ target: { value: '45' } });
await button(refused.render(), '保存').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  'a refused write keeps what the user typed',
  firstInput(refused.render()).props.value === '45',
  'the input snapped back to the Host value, losing the edit',
);
check('a refused write says so', notice(refused.render(), '拒绝') !== null);
check('a refused write sends nothing further', refused.ops.length === 1, String(refused.ops.length));

const rejectedWrite = settingsRig(readyForm, () => Promise.reject(new Error('boom')));
firstInput(rejectedWrite.render()).props.onChange({ target: { value: '45' } });
await button(rejectedWrite.render(), '保存').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check('a rejected write reports the message', notice(rejectedWrite.render(), 'boom') !== null);
check('a rejected write keeps the draft too', firstInput(rejectedWrite.render()).props.value === '45');

const restore = settingsRig(readyForm, () => Promise.resolve(true));
await button(restore.render(), '恢复默认').props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  'restore clears exactly the six live fields',
  JSON.stringify(restore.ops[0].operations) ===
    JSON.stringify([
      { op: 'unset', path: ['warnRemaining'] },
      { op: 'unset', path: ['dangerRemaining'] },
      { op: 'unset', path: ['minIntervalMs'] },
      { op: 'unset', path: ['timeoutMs'] },
      { op: 'unset', path: ['warnValue'] },
      { op: 'unset', path: ['dangerValue'] },
    ]),
  JSON.stringify(restore.ops[0]),
);

// An invalid pair is refused before the Host sees anything.
const inverted = settingsRig(readyForm, () => Promise.resolve(true));
const inputsOf = (tree) => {
  const found = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'input') found.push(node);
    walk(node.props?.children);
  };
  walk(tree);
  return found;
};
const invertedInputs = () => inputsOf(inverted.render());
check('the page shows all six live fields', invertedInputs().length === 6, String(invertedInputs().length));
// PAGE_FIELDS order: warn, danger, interval, timeout.
invertedInputs()[0].props.onChange({ target: { value: '5' } });
invertedInputs()[1].props.onChange({ target: { value: '80' } });
check('an inverted pair blocks the save control', button(inverted.render(), '保存').props.disabled === true);
check('an inverted pair explains itself', notice(inverted.render(), '不能高于') !== null);
check('an inverted pair reaches the Host with nothing', inverted.ops.length === 0, String(inverted.ops.length));

const stateless = settingsRig(undefined, () => Promise.resolve(true));
check(
  'a form without state degrades instead of throwing',
  typeof stateless.render() === 'object' && notice(stateless.render(), '没有可写的表单') !== null,
);
check(
  'and with no state nothing is written',
  typeof button(stateless.render(), '保存')?.props.disabled === 'boolean',
);

// The update button, through the same dispatcher rig. What matters is the spec the
// manager is handed: the alias form with the commit pinned, which is the only
// shape `pnpm add` re-resolves instead of answering "Already up to date".
internal.__primeUpdate({ status: 'available', installed: '0.1.0', remote: '0.2.0', sha: 'deadbeefcafe1234', busy: false, error: null, notice: null });
const cardRender = hookRender(live.exports.__internal.ProviderQuotaSettings, { view: 'page', form: readyForm, defaultOpen: true });
const rowElement = find(cardRender(), (node) => node.type === internal.UpdateRow);
check('the card wires the update row to its own install action', rowElement !== null && rowElement.props.state.remote === '0.2.0');
const rowTree = hookRender(internal.UpdateRow, rowElement.props)();
const updateControl = button(rowTree, '更新');
check('the update control is reachable', typeof updateControl?.props.onClick === 'function');
await updateControl.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  'the update asks the manager for the pinned spec',
  mounted.seen.install?.spec === 'dsh-provider-quota@github:Alei-001/dsh-provider-quota#deadbeefcafe1234',
  JSON.stringify(mounted.seen.install),
);
check('the update leaves the bundle enabled', mounted.seen.install?.options?.enabled === true, JSON.stringify(mounted.seen.install?.options));
const afterTree = cardRender();
check(
  'a finished update swaps the row for the restart notice',
  find(afterTree, (node) => node.type === internal.UpdateRow) === null &&
    find(afterTree, (node) => node.type === internal.UpdateNotice)?.props.notice.application === 'restart-required',
);
internal.__primeUpdate(idleUpdate);

// The notice a completed update leaves for the reload, and the one control it
// has. This is where the card once held two states under one name — the second
// declaration took the first one's setter, so "知道了" wrote the save notice and
// the update notice stayed on screen for good.
const NOTICE_KEY = 'dsh-provider-quota/updated';
live.win.sessionStorage.setItem(NOTICE_KEY, JSON.stringify({ version: '0.2.0', application: 'restart-required' }));
const noticeRender = hookRender(live.exports.__internal.ProviderQuotaSettings, { view: 'page', form: readyForm });
const noticeElement = find(noticeRender(), (node) => node.type === internal.UpdateNotice);
check('a notice the reload left behind is still shown', noticeElement !== null && noticeElement.props.notice.version === '0.2.0');
const noticeTree = hookRender(internal.UpdateNotice, noticeElement.props)();
const dismissControl = button(noticeTree, '知道了');
check('the notice can be dismissed', typeof dismissControl?.props.onClick === 'function');
await dismissControl.props.onClick();
check('dismissing it takes the notice off the card', find(noticeRender(), (node) => node.type === internal.UpdateNotice) === null);
check('dismissing it forgets the notice', live.win.sessionStorage.getItem(NOTICE_KEY) === null);
check('a dismissed notice stays gone on the next mount', find(hookRender(live.exports.__internal.ProviderQuotaSettings, { view: 'page', form: readyForm })(), (node) => node.type === internal.UpdateNotice) === null);

// ------------------------------------------------------------ the update cadence
// Everything above renders markup. This block runs the card's effects, on a clock
// and a network the suite owns: mount check, tab return, beat, retry, cleanup and
// the row's survival across a re-check all live in that half, and a suite that
// stubs effects into no-ops cannot see any of them.
console.log('client half — update cadence');
const shell = live.win;
const realNow = Date.now;
let clock = realNow();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
shell.intervals.length = 0;
shell.timeouts.length = 0;
shell.listeners = {};
fakeDocument.listeners = {};
Date.now = () => clock;

const githubCalls = [];
const checkTimes = [];
/** GitHub answering the two version-check reads, and counting what it was asked. */
function githubStub(version) {
  return async (url) => {
    githubCalls.push(String(url));
    if (String(url).includes('/contents/package.json')) checkTimes.push(clock);
    if (String(url).includes('/contents/package.json')) {
      return { ok: true, status: 200, json: async () => ({ content: Buffer.from(JSON.stringify({ version })).toString('base64') }) };
    }
    if (String(url).includes('/commits/')) return { ok: true, status: 200, json: async () => ({ sha: 'deadbeefcafe1234' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const reads = () => githubCalls.filter((url) => url.includes('/contents/package.json')).length;
/** The busiest hour the check ever spent, which is what the API's budget bounds. */
const busiestHour = () => {
  let worst = 0;
  for (const at of checkTimes) {
    const within = checkTimes.filter((other) => other > at - 3600000 && other <= at).length;
    if (within > worst) worst = within;
  }
  return worst;
};
const markupOf = (tree) => renderToStaticMarkup(tree);
const rowOf = (tree) => find(tree, (node) => node.type === internal.UpdateRow);

globalThis.fetch = githubStub('0.2.0');
internal.__primeUpdate(idleUpdate);
const cadence = hookRender(internal.ProviderQuotaSettings, { view: 'page', form: readyForm, defaultOpen: true }, { effects: true });
cadence();
check('a mounted card asks for the published version', reads() === 1, String(reads()));
await flush();
check('a newer release costs the commit read as well', reads() === 1 && asked.some((url) => url.includes('/commits/')));
check(
  'the beat runs on the documented cadence',
  shell.intervals.filter((timer) => timer.ms === 900000 && timer.cleared !== true).length === 1,
  JSON.stringify(shell.intervals.map((timer) => timer.ms)),
);
check(
  'the card listens for a return to the tab, on either surface',
  (shell.listeners.focus ?? []).length >= 1 && (fakeDocument.listeners.visibilitychange ?? []).length >= 1,
  JSON.stringify({ window: Object.keys(shell.listeners), document: Object.keys(fakeDocument.listeners) }),
);
check('the row is up once the verdict lands', rowOf(cadence()) !== null);

shell.fire('focus');
await flush();
check('a tab return inside the floor costs nothing', reads() === 1, String(reads()));
clock += 6 * 60 * 1000;
shell.fire('focus');
await flush();
check('a tab return after the floor asks again', reads() === 2, String(reads()));

// The row is what the card knows, not what this instant's status says: a re-check
// nobody asked for must not take it off the screen between its question and its
// answer.
clock += 6 * 60 * 1000;
shell.fire('focus');
check('a re-check does not blink the row off the card', rowOf(cadence()) !== null);
await flush();

// Three hours of flipping between windows, six minutes apart: the budget bounds
// what any single hour of that spends, so a reader who alt-tabs cannot turn the
// check into the rate limit that stops it answering.
const beforeFlips = checkTimes.length;
for (let flip = 0; flip < 30; flip += 1) {
  clock += 6 * 60 * 1000;
  shell.fire('focus');
  fakeDocument.fire('visibilitychange');
}
await flush();
const flippedChecks = checkTimes.length - beforeFlips;
check('no hour of window flipping holds more than the budget', busiestHour() <= 6, String(busiestHour()));
check('and thirty flips did not buy thirty checks', flippedChecks < 30, String(flippedChecks));

// A check that cannot answer: one retry rather than a chain, the row kept, and the
// reason said out loud.
clock += 120 * 60 * 1000;
globalThis.fetch = async () => {
  throw new Error('GitHub 403');
};
fakeDocument.fire('visibilitychange');
await flush();
const armed = shell.pendingTimeouts();
check('a failing check arms exactly one retry', armed.length === 1 && armed[0].ms === 60000, JSON.stringify(armed.map((timer) => timer.ms)));
const failedTree = cadence();
check('a failed re-check keeps the row it had', rowOf(failedTree) !== null);
check('a failed re-check says why in the body', markupOf(failedTree).includes('版本检查失败：GitHub 403'));
shell.fireTimeouts();
await flush();
check('the retry is spent, not chained', shell.pendingTimeouts().length === 0, String(shell.pendingTimeouts().length));

// A later answer clears the complaint and re-arms the allowance.
clock += 120 * 60 * 1000;
globalThis.fetch = githubStub('0.2.0');
fakeDocument.fire('visibilitychange');
await flush();
check('an answer clears the last complaint', !markupOf(cadence()).includes('版本检查失败'));
globalThis.fetch = async () => {
  throw new Error('GitHub 403');
};
clock += 120 * 60 * 1000;
fakeDocument.fire('visibilitychange');
await flush();
check('a later failure gets its own retry', shell.pendingTimeouts().length === 1, String(shell.pendingTimeouts().length));

// Answer once more: that spends the armed retry and re-arms the allowance, so the
// next phase is a fresh failure rather than a spent one.
globalThis.fetch = githubStub('0.2.0');
clock += 120 * 60 * 1000;
fakeDocument.fire('visibilitychange');
await flush();
shell.fireTimeouts();
await flush();
check('an answer spends the armed retry', shell.pendingTimeouts().length === 0, String(shell.pendingTimeouts().length));

// A check in flight when the card goes away must not arm a timer nothing owns.
// The diagnostics route shares this fetch, so only the version read is held.
let inFlight = null;
globalThis.fetch = (url) => {
  if (String(url).includes('api.github.com')) {
    return new Promise((resolve, reject) => {
      inFlight = { resolve, reject };
    });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, adapted: [], available: [], thresholds: {} }) });
};
clock += 120 * 60 * 1000;
fakeDocument.fire('visibilitychange');
await flush();
check('a check is in flight', inFlight !== null);
cadence.cleanup();
check('unmount clears the beat and the listeners', shell.intervals.every((timer) => timer.cleared === true) && (shell.listeners.focus ?? []).length === 0);
inFlight.reject(new Error('GitHub 403'));
await flush();
check('a failure landing after unmount arms nothing', shell.pendingTimeouts().length === 0, String(shell.pendingTimeouts().length));

Date.now = realNow;
globalThis.fetch = realFetch;
internal.__primeUpdate(idleUpdate);

// The bundle-config seat renders a wrapper that subscribes to the entry form.
// Its methods must be called ON the form: a detached `subscribe`/`getSnapshot`
// reads `this.store` as undefined and throws, and the slot system answers a
// throwing entry by abdicating it — the page then stays silently empty.
const seatForm = {
  store: { status: 'ready', value: settingsValues, revision: 9, writable: true },
  subscribe(listener) { return this.store === undefined ? undefined : () => {}; },
  getSnapshot() { return this.store; },
  mutate(operations, revision) { return Promise.resolve(true); },
};
const wrapper = live.exports.__internal.bundleConfigOf(seatForm);
let seatError = null;
let seatTree = null;
try {
  seatTree = hookRender(wrapper, { view: 'page', defaultOpen: true })();
} catch (error) {
  seatError = String(error && error.message);
}
check('the bundle-config wrapper renders without throwing', seatError === null, String(seatError));
check(
  'and it hands the page the form state it read',
  seatTree !== null && Object.values(settingsValues).every((value) => find(seatTree, (node) => node.props?.value === String(value)) !== null),
  String(seatError),
);
check('the wrapper reads the form it was given', seatForm.store.revision === 9);

globalThis.fetch = realFetch;

// ------------------------------------------------------------------- locale
// Visible copy lives in the two dictionaries and nowhere else: the card and the
// panel render whatever `t` the slot kit hands them, and a component without one
// reads the shipped Chinese table.
console.log('client half — locale');
const en = internal.DICTS.en;
const zh = internal.DICTS.zh;
const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();
check('both dictionaries carry the same keys', enKeys.join(',') === zhKeys.join(','), enKeys.filter((k) => !zhKeys.includes(k)).join(','));
check('the dictionaries are not empty', enKeys.length > 40, String(enKeys.length));
check('no entry is blank', enKeys.every((key) => typeof en[key] === 'string' && en[key].length > 0 && typeof zh[key] === 'string' && zh[key].length > 0));
check('every key is used by the client half', enKeys.every((key) => readFileSync(`${projectDir}/lib/client.js`, 'utf8').includes(`${key}:`)));
const fillEn = (key, params) => {
  const template = Object.hasOwn(en, key) ? en[key] : key;
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
};
const enT = (key, params) => fillEn(key, params);
check('a component with no kit falls back to the shipped table', internal.tOf(null)('save') === '保存');
check('a component with a kit uses the kit translator', internal.tOf({ t: (key) => `x:${key}` })('save') === 'x:save');
check('the fallback substitutes parameters', internal.tOf(null)('usedPercent', { percent: 6 }) === '已用 6%');
const enCard = renderToStaticMarkup(
  React.createElement(internal.ProviderQuotaSettings, { view: 'page', form: settingsForm, defaultOpen: true, t: enT }),
);
check('the card renders English through the injected translator', enCard.includes('Warning threshold') && enCard.includes('Balance warning amount'));
check('the card offers English controls', enCard.includes('>Save<') && enCard.includes('Restore defaults'));
check('no Chinese is left in the English card', !/[\u4e00-\u9fff]/.test(enCard), (enCard.match(/[\u4e00-\u9fff]+/g) ?? []).slice(0, 4).join(' '));
check('the English card keeps the ids the Host gave it', enCard.includes('value="15000"'));
check('the English summary states the cut points', internal.tOf({ t: enT })('summary', { warn: 30, danger: 10 }) === 'Warn ≤30% · Danger ≤10%');
check(
  'the reset label is translated, not hardcoded',
  internal.resetText(new Date(Date.now() + 2 * 3600 * 1000).toISOString(), enT).startsWith('Resets in 2 h'),
  internal.resetText(new Date(Date.now() + 2 * 3600 * 1000).toISOString(), enT),
);
check('the reset label falls back to the shipped table', internal.resetText(new Date(Date.now() + 2 * 3600 * 1000).toISOString()).includes('2 小时后重置'));
const enPanel = renderToStaticMarkup(
  React.createElement(internal.Panel, {
    panelRef: React.createRef(),
    position: { left: 0, top: 0 },
    entry: { snapshot: { ...measuredSnapshot, label: 'OpenCode Go', windows: [{ ...measuredSnapshot.windows[0], label: 'rolling' }] }, fetchedAt: Date.now(), error: null, warning: null },
    provider: 'opencode-go',
    onRefresh: () => {},
    onClose: () => {},
    t: enT,
  }),
);
check('the panel renders English through the injected translator', enPanel.includes('Plan quota') && enPanel.includes('Remaining quota') && enPanel.includes('Used 6%'));
check('no Chinese is left in the English panel', !/[\u4e00-\u9fff]/.test(enPanel), (enPanel.match(/[\u4e00-\u9fff]+/g) ?? []).slice(0, 4).join(' '));

// ------------------------------------------------------- manifest metadata
// The Plugin Manager reads the card's title and description from `locale/*.json`
// without activating the plugin, so those files must exist and be exported.
console.log('client half — manifest');
const manifest = JSON.parse(readFileSync(`${projectDir}/package.json`, 'utf8'));
const enMeta = JSON.parse(readFileSync(`${projectDir}/locale/en.json`, 'utf8'));
const zhMeta = JSON.parse(readFileSync(`${projectDir}/locale/zh.json`, 'utf8'));
check('the manifest declares the client half', manifest.dsh?.client?.platform === 'web' && manifest.exports['./client'] === './lib/client.js');
check('the manifest exports the locale files', manifest.exports['./locale/*.json'] === './locale/*.json' && manifest.files.includes('locale'));
check('the card has a title and description in both languages', typeof enMeta.meta?.title === 'string' && typeof enMeta.meta?.description === 'string' && typeof zhMeta.meta?.title === 'string' && typeof zhMeta.meta?.description === 'string');
check('activation is ordered behind the packages this half reads', ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager'].every((name) => manifest.dsh.client.inject.includes(name)), JSON.stringify(manifest.dsh.client.inject));

// ----------------------------------------------------------------------- host half
console.log('host half');
const host = await import(`file:///${projectDir}/lib/index.js`);
check('exports name', host.name === 'provider-quota', String(host.name));
check('injects webServer', Array.isArray(host.inject) && host.inject.includes('webServer'), JSON.stringify(host.inject));
check('exports apply()', typeof host.apply === 'function');

let hostConfig = null;
try {
  hostConfig = typeof host.Config === 'function' ? host.Config({}) : null;
} catch (error) {
  hostConfig = { error: String(error && error.message) };
}
check('Config resolves defaults', hostConfig !== null && !('error' in hostConfig), JSON.stringify(hostConfig));
check('defaults name both routes', String(hostConfig?.routePath).includes('provider-quota') && String(hostConfig?.providersPath).includes('providers'), JSON.stringify(hostConfig));
check(
  'the live fields resolve to references, which is what makes them editable',
  typeof hostConfig?.warnRemaining?.get === 'function' && hostConfig.warnRemaining.get() === 30,
  JSON.stringify(hostConfig?.warnRemaining),
);
check(
  'the route fields stay plain strings',
  hostConfig?.routePath === '/dsh-provider-quota/usage' && hostConfig?.providersPath === '/dsh-provider-quota/providers',
  JSON.stringify({ routePath: hostConfig?.routePath, providersPath: hostConfig?.providersPath }),
);

// A fixture upstream and a stub credential store, wired through the real handler.
const OPENCODE_FIXTURE = {
  usage: {
    rolling: { status: 'ok', percent: 6, resetsAt: '2026-10-08T19:06:42.000Z' },
    weekly: { status: 'ok', percent: 61, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 41, resetsAt: '2026-11-03T13:10:59.000Z' },
  },
};
const DEEPSEEK_FIXTURE = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
};
const upstreamCalls = [];
globalThis.fetch = async (url, init) => {
  upstreamCalls.push({ url: String(url), authorization: init?.headers?.authorization });
  const target = String(url);
  if (target.includes('opencode.ai/zen/go/v1/usage')) {
    return { ok: true, status: 200, json: async () => OPENCODE_FIXTURE };
  }
  if (target.includes('api.deepseek.com/user/balance')) {
    return { ok: true, status: 200, json: async () => DEEPSEEK_FIXTURE };
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
};

const routes = [];
const credentialsAsked = [];
/** The account's wallets, as the host `deepseekAccount` service reports them. */
const ACCOUNT_FIXTURE = {
  status: 'ready',
  value: [{ currency: 'CNY', balance: '110.00' }],
  bonusWallets: [{ currency: 'CNY', balance: '5.50' }],
};
let accountClientSeen = null;
const hostCtx = {
  logger: { info() {}, warn() {} },
  effect: (callback) => callback(),
  get(service) {
    if (service === 'credentials') {
      return {
        async resolve(ref) {
          credentialsAsked.push(String(ref));
          return { value: ref === 'DEEPSEEK_API_KEY' ? 'ds-test-key' : 'og-test-key' };
        },
      };
    }
    if (service === 'llm') {
      // The ids the live Desktop host actually reports, plus one it does not
      // measure so the "not offered" path stays covered.
      return {
        listProviders: () => [
          { provider: 'opencode-go' },
          { provider: 'deepseek-official' },
          { provider: 'deepseek-account' },
          { provider: 'openai' },
        ],
      };
    }
    if (service === 'deepseekAccount') {
      return {
        getState: async () => ({ status: 'credential-stored' }),
        getBalance: async (client) => {
          accountClientSeen = client;
          return ACCOUNT_FIXTURE;
        },
      };
    }
    return undefined;
  },
  webServer: { register(route) { routes.push(route); return () => {}; } },
};
host.apply(hostCtx, hostConfig);
check('registers two routes', routes.length === 2, String(routes.length));
check('both routes are exact', routes.every((route) => route.kind === 'exact'));

// A second composition, the way a live settings edit re-resolves: same entry,
// override on top, so the tone cut points can be watched changing.
const overrideRoutes = [];
const overrideCtx = Object.assign({}, hostCtx, {
  webServer: { register(route) { overrideRoutes.push(route); return () => {}; } },
});
host.apply(overrideCtx, host.Config({
  warnValue: 100,
  dangerValue: 10,
  minIntervalMs: 1000,
  warnRemaining: 50,
  dangerRemaining: 5,
}));
const overrideProviders = overrideRoutes.find((route) => route.path === hostConfig.providersPath);
const overrideUsage = overrideRoutes.find((route) => route.path === hostConfig.routePath);
check('the override composition re-registers both routes', overrideRoutes.length === 2, String(overrideRoutes.length));
const overrideBalance = await call(overrideUsage, 'GET', `${hostConfig.routePath}?provider=deepseek-official`);
check('a balance above both cut points is fine', overrideBalance.json?.windows?.[0]?.valueNumber === 110 && overrideBalance.json?.windows?.[0]?.tone === 'ok', JSON.stringify(overrideBalance.json?.windows?.[0]));
const overrideAccount = await call(overrideUsage, 'GET', `${hostConfig.routePath}?provider=deepseek-account`);
check('a wallet at the danger cut point is toned danger', overrideAccount.json?.windows?.[1]?.valueNumber === 5.5 && overrideAccount.json?.windows?.[1]?.tone === 'danger', JSON.stringify(overrideAccount.json?.windows?.[1]));
const overrideDiscovery = await call(overrideProviders, 'GET', hostConfig.providersPath);
check('the override thresholds are published', overrideDiscovery.json?.thresholds?.warn === 50 && overrideDiscovery.json?.thresholds?.warnValue === 100, JSON.stringify(overrideDiscovery.json?.thresholds));
const overrideAgain = await call(overrideUsage, 'GET', `${hostConfig.routePath}?provider=deepseek-official`);
check('a reused snapshot is re-toned with the override', overrideAgain.json?.cached === true && overrideAgain.json?.windows?.[0]?.tone === 'ok', JSON.stringify({ cached: overrideAgain.json?.cached, tone: overrideAgain.json?.windows?.[0]?.tone }));

const providersRoute = routes.find((route) => route.path === hostConfig.providersPath);
const usageRoute = routes.find((route) => route.path === hostConfig.routePath);
check('the discovery route is registered', providersRoute !== undefined);
check('the usage route is registered', usageRoute !== undefined);

/** Drive one request through a route and collect the JSON answer. */
async function call(route, method, url) {
  const answer = {};
  const response = {
    writeHead(status, headers) { answer.status = status; answer.headers = headers; },
    end(body) { if (body !== undefined) answer.body = body; },
  };
  await route.handler({ method, url }, response);
  if (answer.body !== undefined) {
    try { answer.json = JSON.parse(answer.body); } catch { answer.json = null; }
  }
  return answer;
}

const discovery = await call(providersRoute, 'GET', hostConfig.providersPath);
check('discovery reports the adapted ids', JSON.stringify(discovery.json?.adapted) === '["opencode-go","deepseek-official","deepseek","deepseek-account"]', JSON.stringify(discovery.json?.adapted));
check('discovery reports the live provider ids', JSON.stringify(discovery.json?.available) === '["opencode-go","deepseek-official","deepseek-account","openai"]', JSON.stringify(discovery.json?.available));
check(
  'discovery offers only served providers',
  JSON.stringify(discovery.json?.matched) === '["opencode-go","deepseek-official","deepseek-account"]',
  JSON.stringify(discovery.json?.matched),
);
check(
  'a live provider with no adapter is not offered',
  !(discovery.json?.matched ?? []).includes('openai'),
  JSON.stringify(discovery.json?.matched),
);
check(
  'an adapted id no provider serves is not offered',
  !(discovery.json?.matched ?? []).includes('deepseek'),
  JSON.stringify(discovery.json?.matched),
);
check(
  'discovery carries the tone cut points the page edits',
  discovery.json?.thresholds?.warn === 30 && discovery.json?.thresholds?.danger === 10,
  JSON.stringify(discovery.json?.thresholds),
);

const usage = await call(usageRoute, 'GET', `${hostConfig.routePath}?provider=opencode-go`);
check('usage answers for an adapted provider', usage.json?.ok === true, JSON.stringify(usage.json).slice(0, 160));
check(
  'usage carries the tone cut points',
  usage.json?.thresholds?.warn === 30 && usage.json?.thresholds?.danger === 10,
  JSON.stringify(usage.json?.thresholds),
);
check('every window carries the tone the host decided', usage.json?.windows?.every((w) => ['ok', 'warn', 'danger', 'unknown'].includes(w.tone)), JSON.stringify(usage.json?.windows?.map((w) => w.tone)));
check('a percentage window is toned from the remaining share', usage.json?.windows?.[0]?.remaining === 94 && usage.json?.windows?.[0]?.tone === 'ok', JSON.stringify(usage.json?.windows?.[0]));
check('usage names the provider and its label', usage.json?.provider === 'opencode-go' && usage.json?.label === 'OpenCode Go');
check('usage normalises every window', usage.json?.windows?.length === 3, String(usage.json?.windows?.length));
check('usage converts used percent into remaining', usage.json?.windows?.[0]?.remaining === 94, JSON.stringify(usage.json?.windows?.[0]));
check('usage keeps the adapter window labels', usage.json?.windows?.[0]?.label === '5 小时窗口');
check('usage names the primary window', usage.json?.primary === 'rolling');
check('usage marks a fresh read uncached', usage.json?.cached === false);
check('the upstream got the credential store value', upstreamCalls.some((c) => c.url.includes('opencode.ai') && c.authorization === 'Bearer og-test-key'), String(upstreamCalls.map((c) => c.authorization)));
check('the credential was read by record name', credentialsAsked.includes('OPENCODE_GO_API_KEY'), credentialsAsked.join(','));

const balance = await call(usageRoute, 'GET', `${hostConfig.routePath}?provider=deepseek-official`);
check('the balance adapter answers too', balance.json?.ok === true && balance.json?.label === 'DeepSeek API', JSON.stringify(balance.json).slice(0, 160));
check('the balance adapter yields a value window', balance.json?.windows?.[0]?.value === 'CNY 110.00', JSON.stringify(balance.json?.windows?.[0]));
check('a balance window has no percentage', balance.json?.windows?.[0]?.remaining === null);
check('a balance window carries the amount behind its text', balance.json?.windows?.[0]?.valueNumber === 110, JSON.stringify(balance.json?.windows?.[0]));
check('a balance window has no tone while balance warnings are off', balance.json?.windows?.[0]?.tone === 'unknown', JSON.stringify(balance.json?.windows?.[0]?.tone));
check('the balance adapter read its own credential', upstreamCalls.some((c) => c.authorization === 'Bearer ds-test-key'));

// The account-backed provider reads a host service, not an endpoint: no URL, no
// API key, and its amounts are wallets rather than percentages.
const accountUsage = await call(usageRoute, 'GET', `${hostConfig.routePath}?provider=deepseek-account`);
check('the account adapter answers', accountUsage.json?.ok === true && accountUsage.json?.label === 'DeepSeek 账号', JSON.stringify(accountUsage.json).slice(0, 180));
check('the account adapter lists both wallets', accountUsage.json?.windows?.length === 2, JSON.stringify(accountUsage.json?.windows));
check('the recharge wallet is primary', accountUsage.json?.primary === 'balance-0' && accountUsage.json?.windows?.[0]?.value === 'CNY 110.00', JSON.stringify(accountUsage.json?.windows?.[0]));
check('the bonus wallet is its own row', accountUsage.json?.windows?.[1]?.label === '赠送余额' && accountUsage.json?.windows?.[1]?.value === 'CNY 5.50', JSON.stringify(accountUsage.json?.windows?.[1]));
check('an account window has no percentage', accountUsage.json?.windows?.[0]?.remaining === null && accountUsage.json?.windows?.[0]?.used === null);
check('an account read needs no credential record', !credentialsAsked.includes('DEEPSEEK_ACCOUNT_KEY'));
check(
  'an account read carries the calling build identity',
  accountClientSeen !== null &&
    accountClientSeen.version === '0.1.0' &&
    accountClientSeen.locale === 'zh-CN' &&
    typeof accountClientSeen.timezoneOffsetSeconds === 'number' &&
    Number.isFinite(accountClientSeen.timezoneOffsetSeconds),
  JSON.stringify(accountClientSeen),
);

const cached = await call(usageRoute, 'GET', `${hostConfig.routePath}?provider=opencode-go`);
check('a second read inside the window is cached', cached.json?.cached === true && cached.json?.fetchedAt === usage.json?.fetchedAt, JSON.stringify({ cached: cached.json?.cached, at: cached.json?.fetchedAt }));

const forced = await call(usageRoute, 'GET', `${hostConfig.routePath}?provider=opencode-go&force=1`);
check('force bypasses the cache', forced.json?.cached === false);

const unsupported = await call(usageRoute, 'GET', `${hostConfig.routePath}?provider=openai`);
check('an unadapted provider answers unsupported', unsupported.json?.ok === false && unsupported.json?.unsupported === true, JSON.stringify(unsupported.json));
check('an unadapted provider is not an error', unsupported.json?.error === undefined);
check('an unadapted provider hits no upstream', upstreamCalls.every((c) => !c.url.includes('openai')));

const missing = await call(usageRoute, 'GET', hostConfig.routePath);
check('a request without a provider is refused', missing.status === 400 && missing.json?.ok === false, JSON.stringify(missing.json));

const wrongMethod = await call(usageRoute, 'POST', `${hostConfig.routePath}?provider=opencode-go`);
check('the usage route refuses other methods', wrongMethod.status === 405, String(wrongMethod.status));
const wrongDiscoveryMethod = await call(providersRoute, 'POST', hostConfig.providersPath);
check('the discovery route refuses other methods', wrongDiscoveryMethod.status === 405, String(wrongDiscoveryMethod.status));

check('answers are uncacheable', usage.headers?.['cache-control'] === 'no-store' && discovery.headers?.['cache-control'] === 'no-store');

// --------------------------------------------------------- failure and adapter units
console.log('host half — failures and adapters');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Unauthorized' } }) });
const failingCtx = { ...hostCtx, webServer: { register() { return () => {}; } } };
const failingRoutes = [];
failingCtx.webServer = { register(route) { failingRoutes.push(route); return () => {}; } };
host.apply(failingCtx, { ...hostConfig, routePath: '/quota-fail/usage', providersPath: '/quota-fail/providers' });
const failedRoute = failingRoutes.find((route) => route.path === '/quota-fail/usage');
const failure = await call(failedRoute, 'GET', '/quota-fail/usage?provider=opencode-go');
check('an upstream failure is reported, not thrown', failure.status === 200 && failure.json?.ok === false, JSON.stringify(failure.json));
check('an upstream failure quotes the upstream status', String(failure.json?.error).includes('401'), String(failure.json?.error));
globalThis.fetch = originalFetch;

// Every answer — success, unsupported, refusal and failure alike — must be free
// of credential material. Checked here because the failure answer exists now.
const allBodies = [usage, balance, accountUsage, discovery, unsupported, cached, forced, missing, failure].map((answer) => String(answer.body));
check(
  'no answer leaks a credential',
  allBodies.every((body) => !body.includes('og-test-key') && !body.includes('ds-test-key') && !body.toLowerCase().includes('bearer')),
  allBodies.filter((body) => body.includes('-test-key') || body.toLowerCase().includes('bearer')).join(' | ').slice(0, 200),
);

const shared = await import(`file:///${projectDir}/lib/providers/shared.js`);
const opencodeAdapter = await import(`file:///${projectDir}/lib/providers/opencode-go.js`);
const deepseekAdapter = await import(`file:///${projectDir}/lib/providers/deepseek.js`);
const accountAdapter = await import(`file:///${projectDir}/lib/providers/deepseek-account.js`);
const registry = await import(`file:///${projectDir}/lib/providers/index.js`);
check('the registry resolves opencode-go', registry.findAdapter('opencode-go') === opencodeAdapter);
check('the registry resolves the live official deepseek id', registry.findAdapter('deepseek-official') === deepseekAdapter);
check('the registry resolves the plain deepseek alias', registry.findAdapter('deepseek') === deepseekAdapter);
check('the registry resolves the account-backed deepseek provider', registry.findAdapter('deepseek-account') === accountAdapter);
check('the registry resolves nothing for an unknown id', registry.findAdapter('openai') === undefined);
check('the registry resolves nothing for an empty id', registry.findAdapter('') === undefined);
check('the registry lists every adapted id', registry.adaptedIds().join(',') === 'opencode-go,deepseek-official,deepseek,deepseek-account');
check('every adapter declares a label', [opencodeAdapter, deepseekAdapter, accountAdapter].every((a) => typeof a.label === 'string'));
check(
  'a credential is a record name or an explicit null',
  [opencodeAdapter, deepseekAdapter, accountAdapter].every((a) => typeof a.credential === 'string' || a.credential === null),
);
check('the account adapter declares no API key', accountAdapter.credential === null);

// DSH keeps two independent DeepSeek systems: `deepseek-official` spends an API
// key against the 开放平台 balance, `deepseek-account` spends a stored login
// grant against the account's own wallets. The adapters must not merge them.
check(
  'the two deepseek providers are served by different adapters',
  registry.findAdapter('deepseek-official') !== registry.findAdapter('deepseek-account'),
);
check('neither deepseek adapter claims the other id', !deepseekAdapter.ids.includes('deepseek-account') && !accountAdapter.ids.includes('deepseek-official'));
check('the two deepseek adapters read different sources', deepseekAdapter.credential !== accountAdapter.credential);
check('the two deepseek adapters carry distinct labels', deepseekAdapter.label !== accountAdapter.label, `${deepseekAdapter.label} / ${accountAdapter.label}`);

// ---------------------------------------------------------- amount formatting
console.log('host half — amount formatting');
check('an amount is read at two decimals', shared.formatAmount(110) === '110.00');
check('an amount keeps its cents', shared.formatAmount('5.50') === '5.50');
check('a whole amount is padded', shared.formatAmount(7) === '7.00');
check('no amount is a dash', shared.formatAmount(null) === '—' && shared.formatAmount('') === '—' && shared.formatAmount('abc') === '—');
check(
  'an amount too long to show is rounded to two decimals',
  shared.formatAmount('-0.0047610200000000') === '0.00' && shared.formatAmount('12.3456') === '12.35',
  `${shared.formatAmount('-0.0047610200000000')} / ${shared.formatAmount('12.3456')}`,
);
check('a negative amount keeps its sign', shared.formatAmount('-12.34') === '-12.34');
check('a large amount is not padded', shared.formatAmount('123456.78') === '123456.78');
check('a value window carries the amount behind its text', shared.valueWindow('b', '账户余额', 'CNY 110.00', null, '110').valueNumber === 110);
check('a value window with no amount has none', shared.valueWindow('b', '账户余额', '—').valueNumber === null);
check(
  'the API-key adapter never reaches the account service',
  (await (async () => {
    const asked = [];
    await deepseekAdapter.read({
      credential: async () => 'k',
      json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }),
      service: (name) => {
        asked.push(name);
        return undefined;
      },
      accountClient: () => ({}),
    });
    return asked.length === 0;
  })()),
);
check(
  'the account adapter never reads a credential',
  (await (async () => {
    let asked = 0;
    await accountAdapter.read({
      credential: async () => {
        asked += 1;
        return 'k';
      },
      json: async () => ({}),
      service: () => ({
        getState: async () => ({ status: 'credential-stored' }),
        getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '1.00' }], bonusWallets: [] }),
      }),
      accountClient: () => ({ version: 'v', locale: 'zh-CN', timezoneOffsetSeconds: 0 }),
    });
    return asked === 0;
  })()),
);

// The account adapter's own failure surface: each condition must be
// distinguishable, because an adapted provider shows its error rather than hiding.
const accountIo = (overrides) =>
  Object.assign(
    {
      service: () => ({
        getState: async () => ({ status: 'credential-stored' }),
        getBalance: async () => ACCOUNT_FIXTURE,
      }),
      accountClient: () => ({ version: '9.9.9', locale: 'en-US', timezoneOffsetSeconds: 0 }),
    },
    overrides,
  );
const accountRead = await accountAdapter.read(accountIo({}));
check('the adapter alone maps both wallets', accountRead.windows.length === 2 && accountRead.primary === 'balance-0');
check('the adapter alone labels the bonus wallet', accountRead.windows[1].label === '赠送余额');
check('the adapter alone formats a long amount', accountRead.windows[0].value === 'CNY 110.00');
const longWallet = await accountAdapter.read(
  accountIo({
    service: () => ({
      getState: async () => ({ status: 'credential-stored' }),
      getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '-0.0047610200000000' }], bonusWallets: [] }),
    }),
  }),
);
check('a long tiny wallet amount is rounded to two decimals', longWallet.windows[0].value === 'CNY 0.00', longWallet.windows[0].value);
check('and it still carries the number for the balance warning', longWallet.windows[0].valueNumber === -0.00476102, String(longWallet.windows[0].valueNumber));
check('the adapter alone formats the currency', accountRead.windows[0].value === 'CNY 110.00');

let noService = '';
try { await accountAdapter.read(accountIo({ service: () => undefined })); } catch (error) { noService = error.message; }
check('a host without the account service says so', noService.includes('账号服务'), noService);

let signedOut = '';
try {
  await accountAdapter.read(accountIo({ service: () => ({ getState: async () => ({ status: 'signed-out' }), getBalance: async () => null }) }));
} catch (error) { signedOut = error.message; }
check('a signed-out account asks for a sign-in', signedOut.includes('登录'), signedOut);

let rejected = '';
try {
  await accountAdapter.read(accountIo({ service: () => ({ getState: async () => ({ status: 'credential-stored' }), getBalance: async () => null }) }));
} catch (error) { rejected = error.message; }
check('a rejected read is distinct from being signed out', rejected.includes('失效') || rejected.includes('重新登录'), rejected);

let failedStatus = '';
try {
  await accountAdapter.read(accountIo({ service: () => ({ getState: async () => ({ status: 'credential-stored' }), getBalance: async () => ({ status: 'failed' }) }) }));
} catch (error) { failedStatus = error.message; }
check('a failed Platform query is not reported as zero', failedStatus.includes('Platform'), failedStatus);

let emptyWallets = '';
try {
  await accountAdapter.read(accountIo({ service: () => ({ getState: async () => ({ status: 'credential-stored' }), getBalance: async () => ({ status: 'ready', value: [], bonusWallets: [] }) }) }));
} catch (error) { emptyWallets = error.message; }
check('a ready balance with no wallets says so', emptyWallets.includes('钱包'), emptyWallets);

const multi = await accountAdapter.read(
  accountIo({ service: () => ({ getState: async () => ({ status: 'credential-stored' }), getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '1.00' }, { currency: 'USD', balance: '2.00' }], bonusWallets: [] }) }) }),
);
check('two wallets of different currencies are named apart', multi.windows[0].label === '账户余额（CNY）' && multi.windows[1].label === '账户余额（USD）', JSON.stringify(multi.windows.map((w) => w.label)));
check('each wallet keeps its own key', multi.windows[0].key === 'balance-0' && multi.windows[1].key === 'balance-1');
check('a balance with no amount is not a zero', (await accountAdapter.read(accountIo({ service: () => ({ getState: async () => ({ status: 'credential-stored' }), getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY' }], bonusWallets: [] }) }) }))).windows[0].value === 'CNY —');

const noKeyIo = { credential: async () => { throw new Error('未配置凭据 TEST_KEY'); }, json: async () => ({}) };
let keyError = '';
try { await opencodeAdapter.read(noKeyIo); } catch (error) { keyError = error.message; }
check('a missing credential fails loudly', keyError.includes('未配置凭据'), keyError);
let shapeError = '';
try {
  await opencodeAdapter.read({ credential: async () => 'k', json: async () => ({}) });
} catch (error) { shapeError = error.message; }
check('a malformed upstream payload fails loudly', shapeError.includes('usage 字段'), shapeError);
let balanceShapeError = '';
try {
  await deepseekAdapter.read({ credential: async () => 'k', json: async () => ({ balance_infos: [] }) });
} catch (error) { balanceShapeError = error.message; }
check('an empty balance fails loudly', balanceShapeError.includes('余额'), balanceShapeError);

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
