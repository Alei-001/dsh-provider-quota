# dsh-provider-quota

A provider-aware quota meter for the DeepSeek Harness composer: a ring to the
left of the web-search option showing the remaining quota of **whichever
provider the current session is using**, opening a panel with the full picture.

Switching the model in the composer switches the meter. If no adapter covers the
newly selected provider, the cell renders **nothing at all** — an empty seat is
better than another vendor's numbers.

## How the provider is chosen

The chip reads the session's durable model selection from `modelDirectories`,
the shared per-session store the composer's model seat and the `/model` popup
both write (`ModelDirectoryState.current`). It takes `current.provider` from
there, asks the host which providers this installation can measure, and renders
only when the two agree:

| Active provider | Adapter? | Chip |
|---|---|---|
| `opencode-go` | yes | ring + panel |
| `deepseek-official` | yes | balance + panel |
| `deepseek-account` | yes | account wallets + panel |
| any other | no | **nothing** |

The panel closes on a provider switch, because the numbers on screen belonged to
the previous provider.

## No secrets in this package

The plugin contains **no credential values**. An adapter declares the *record
name* its key lives under (`'DEEPSEEK_API_KEY'`, `'OPENCODE_GO_API_KEY'`) and the
host resolves the value from DSH's credential store at read time, falling back to
the environment variable of that name. The account adapter declares `null`,
because it has no key at all.

Neither route returns credential material: each answers only windows, labels and
timestamps. Both properties are asserted — the smoke test scans every answer for
key shapes and checks that the two DeepSeek adapters cannot reach each other's
source.

## The two routes

Both are same-origin reads served by the host half. Neither carries credential
material.

```
GET <providersPath>              # default /dsh-provider-quota/providers
{ "ok": true,
  "adapted":   ["opencode-go", "deepseek-official", "deepseek", "deepseek-account"],
  "available": ["opencode-go", "deepseek-official", "deepseek-account", "openai"],
  "matched":   ["opencode-go", "deepseek-official", "deepseek-account"],
  "thresholds": { "warn": 30, "danger": 10, "warnValue": 0, "dangerValue": 0 } }
```

`available` comes from the host's own `llm.listProviders()`. `matched` is
`adapted ∩ available`, and it is what the client gates on: an adapter naming a
provider this host does not serve can never produce a number, so it is not
offered. This route doubles as the diagnostic for exactly that mistake — it is
how the misspelled `deepseek` id was found, and why `deepseek` is still listed
under `adapted` but absent from `matched`.

```
GET <usagePath>?provider=<id>    # default /dsh-provider-quota/usage
{ "ok": true, "provider": "opencode-go", "label": "OpenCode Go",
  "primary": "rolling",
  "windows": [
    { "key": "rolling", "label": "5 小时窗口", "used": 8, "remaining": 92,
      "resetsAt": "2026-10-08T19:06:42.000Z", "value": null, "valueNumber": null,
      "hint": null, "tone": "ok" }
  ],
  "fetchedAt": 1791477599234, "cached": false,
  "thresholds": { "warn": 30, "danger": 10, "warnValue": 0, "dangerValue": 0 } }

{ "ok": false, "unsupported": true, "provider": "openai" }
{ "ok": false, "provider": "…", "error": "…" }
```

`unsupported` is an ordinary answer, not a failure: it is how the host says
"this vendor is not measurable here", and only an **unadapted** provider ever
answers it — `deepseek-account` *is* adapted, so its two real answers are
`ok: true` or an `error` carrying the reason. A provider that *is* adapted but
whose read fails still renders the chip, with the error in the panel — hiding it
would be indistinguishable from "not adapted".

`thresholds` rides every answer that carries numbers, because the four cut points
are editable from the plugin's own page. An error answer carries no cut points,
because it draws no numbers.

`tone` is decided **by the host**, one value per window, and every window carries
one. It sits on the window for a reason: an amount window can be warned about
without the browser parsing `"CNY 110.00"`, and the two pairs never cross — a
percentage answer is coloured from `warn`/`danger` and an amount answer from
`warnValue`/`dangerValue`, so a threshold in yuan cannot colour a quota. A cached
snapshot is re-toned on every answer, because the cut points are live config: an
edit repaints what is on screen without waiting for the read window to elapse.
The browser half only paints: it never decides a tone and never parses an amount.

## Windows: measured or valued

An adapter returns windows, and a window is one of two shapes. That is what lets
a windowed subscription and a pay-as-you-go balance share one panel:

- **measured** — has `remaining` (and `used`): drawn as the ring when it is the
  primary window and as a bar otherwise, coloured green above the warn cut point,
  amber at or below it, red at or below the danger cut point, with its reset
  time. The shipped pair is 30% and 10% remaining, and both are editable
  (`warnRemaining`, `dangerRemaining`).
- **valued** — has no percentage, so `value` carries a formatted amount
  (`"CNY 110.00"`), drawn as text with no ring and no bar; `valueNumber` is the
  amount behind it, which is what the balance warning compares against. Amounts
  are rounded to two decimals by `formatAmount` — an upstream's full precision
  has no business in a UI, and what a value window loses in the display it keeps
  in `valueNumber`. With `warnValue` off (`0`, the default) such a window is
  neutral; with it on, the amount at or below `warnValue` reads as a warning and
  at or below `dangerValue` as a danger, and the chip label, the panel's big
  amount and the wallet rows all take that colour.

`primary` names the window the ring shows; the rest are rows.

## Adding an adapter

One module in `lib/providers/` plus one line in `ADAPTERS`:

```js
// lib/providers/example.js
export const ids = ['example-provider'];   // as the host's llm registry names it
export const label = 'Example';
export const credential = 'EXAMPLE_API_KEY';

export async function read(io) {
  const key = await io.credential(credential);       // store first, env second
  const body = await io.json('https://api.example/quota', {
    authorization: `Bearer ${key}`,
  });
  return {
    label,
    primary: 'month',
    windows: [
      { key: 'month', label: '本月', used: 12, remaining: 88,
        resetsAt: null, value: null, hint: null },
    ],
  };
}
```

`io.credential(name)` resolves the credential store record first and the
environment variable of the same name second, and throws a message naming the
missing record. `io.json(url, headers)` applies the configured deadline and
turns a non-2xx answer into an error quoting the upstream's own message.

An adapter whose vendor is reachable through the host instead of over HTTP uses
`io.service(name)` — see `deepseek-account.js`, which reads the `deepseekAccount`
service and needs neither a credential nor a URL. `io.accountClient()` supplies
the calling build's identity (`version`, `locale`, `timezoneOffsetSeconds`),
which the Platform's account reads require for their request headers; an adapter
cannot derive those itself.

Import `percentWindow` / `valueWindow` from `./shared.js` to build the two window
shapes, and make sure the ids match `available` — the discovery route and the
startup log both report a mismatch, which is otherwise a silent absence.

`valueWindow(key, label, text, hint, valueNumber)` is the one to know: the fifth
argument is the amount behind the text, and it is what makes a balance
warnable. `amountOrNull` parses either a decimal string or a number, and a null
value simply leaves that window neutral:

```js
valueWindow('balance-0', '账户余额', 'CNY 110.00', null, record.total_balance)
```

Passing the text alone — `valueWindow(key, label, 'CNY 110.00')` — is still valid
and still renders; it just cannot be warned about, because the host will not
parse a formatted amount to decide a colour.

## Shipped adapters

| Provider id | Source | Status |
|---|---|---|
| `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage` | verified live |
| `deepseek-official` (`deepseek`) | `GET https://api.deepseek.com/user/balance`, API key | verified live |
| `deepseek-account` | host service `deepseekAccount`, stored login | implemented; needs a restart to load |

**Two independent DeepSeek systems.** DSH splits them itself, and this plugin
keeps them split:

| | `deepseek-official` | `deepseek-account` |
|---|---|---|
| DSH package | `dsh-llm-deepseek-api-key` | `dsh-llm-deepseek-account` |
| Authenticates with | an API key (`DEEPSEEK_API_KEY`) | the stored login grant |
| Adapter | `deepseek.js` | `deepseek-account.js` |
| Reads | `api.deepseek.com/user/balance` | the `deepseekAccount` service |
| Panel header | **DeepSeek API** | **DeepSeek 账号** |
| `credential` | `'DEEPSEEK_API_KEY'` | `null` — it has no key |

They bill different wallets, so neither adapter falls back to the other's source:
the API-key adapter never calls `io.service`, and the account adapter never calls
`io.credential`. Both properties are asserted by the smoke test.

**OpenCode Go** documents no usage endpoint: the docs point at the console, and
both requests for a programmatic surface are still open upstream
([#16017](https://github.com/anomalyco/opencode/issues/16017),
[#31084](https://github.com/anomalyco/opencode/issues/31084)). The console reads
its own windows from that endpoint, and it answers a Go API key directly — no
console session, no `x-opencode-session`. It is **undocumented**, so OpenCode can
change or withdraw it without notice; an upstream error in the panel is the first
thing to re-check.

**DeepSeek API** reads the 开放平台 pay-as-you-go balance, which is a value, not a
window. `is_available: false` is surfaced as the window's `hint` (shown as
`不可用`) rather than being folded into the amount, so an empty wallet still reads
as an empty wallet.

**DeepSeek 账号** is the third shape: no endpoint and no API key at all. The
credential is the login grant DSH already stores, and the amounts are read
through the host's `deepseekAccount` service:

1. `getState()` reports only whether a grant is stored, so `signed-out` becomes
   an ordinary "please sign in" message rather than a failed read.
2. `getBalance(client)` returns `{ status, value, bonusWallets }` when ready,
   `{ status: 'failed' }` when the Platform query fails, and `null` when the
   stored grant was rejected. A failed query never becomes a zero balance, and
   this adapter keeps those three apart.
3. Each wallet is `{ currency, balance }` with the amount as a decimal string, so
   every window is a **value**: recharge wallets first (the spendable ones),
   then granted ones, each labelled and named apart when a currency repeats.

Its client identity comes from `accountClientVersion` / `accountClientLocale`;
the Platform reduces the locale to `zh_CN`/`en_US` and uses both for telemetry
headers only, not for authorization.

## Reloading: refresh for the client, restart for the host

A client bundle reaches the browser through the boot graph and the client-HMR
reload chain, and that chain is driven by a rebuild watcher rewriting bundles —
rewriting a file under `node_modules` is not guaranteed to trigger it. A **page
refresh** always picks up the current bundle.

The host half is an ES module Node has already imported, so changing an adapter or
the plugin itself needs a **DSH restart** — the market's own restart notice exists
for the same reason. The composition is re-applied on every boot, so nothing else
has to be repeated. A restart is also what makes a **schema** change visible: the
live fields below exist because the running host read `Config` at boot, so an
older process keeps serving the older shape until it is restarted.

## The page on the Plugins tab

This package registers one page on the **bundle's own** configuration seat —
DSH's `plugins.bundle.config`, keyed by the package name. That is what puts the
configuration on the bundle's page between its description and its rows, with no
row page and no arrow to click, which is where a single-entry plugin's settings
belong.

The page is a **disclosure**, the same shape as the host's own plugin cards: a
header with the title, a one-line description and the live cut points
(`预警 ≤30% · 危险 ≤10% · 余额预警未启用`), and a body that is mounted only while
the card is open. It starts collapsed, so the page reads as one row until you ask
for the settings; the header carries `aria-expanded` and `aria-controls`, the
chevron turns, and the body's fields do not exist in the DOM while it is closed.
The card shows:

- **what this host can measure** — `adapted` (what this package can read) and
  `available` (what this host serves) from the discovery route, refreshed by hand.
  Their overlap is the set the chip draws, so it needs no row of its own. An
  adapter outside that overlap can never fire — a typo'd provider id, which is
  otherwise a silent absence — so it is **counted** on the `adapted` row
  (`已适配 · 1 个本机不提供`): the count is the one signal of that failure, and a
  count cannot grow into a paragraph the way a long list would.
- **the six live fields** — `warnRemaining`, `dangerRemaining`,
  `minIntervalMs`, `timeoutMs`, `warnValue`, `dangerValue`, with save and
  restore-default actions.

Those six are declared `.volatile()` on the host's `Config`. That is the whole
mechanism: DSH's form for an entry carries exactly the volatile fields, a write is
`form.mutate(operations, expectedRevision)`, and an accepted edit is written into
the active profile's patch and re-applied without remounting the host half. A
non-volatile field is not offered by that form and a path edit outside the
volatile set is refused by the host — which is why `routePath`, `providersPath`,
`accountClientVersion` and `accountClientLocale` stay ordinary config, edited in
the patch file.

A bundle-wide configuration seat carries **no form of its own** — it may hold
several entries, so there is no single one to hand over. The form is therefore
obtained here, from the settings mirror's `configForms` service
(`ctx.inject(['slots', 'configForms'], …)` then `configForms.get('provider-quota')`),
and subscribed to with `useSyncExternalStore` so every field stays live across a
save. Both callbacks call the form's methods **on** the form: `subscribe` and
`getSnapshot` read `this.store` internally, so a detached method throws on the
first render — and the slot system answers a throwing entry by abdicating it,
which leaves the seat silently empty. That dependency is deliberately a second
injection, separate from the chip's: a shell without the settings service loses
the page and nothing else.

The registration is wrapped in `configForms.whileServed(['provider-quota'], …)`,
the idiom every first-party settings page uses, so the page exists exactly while
the Host serves this namespace: a profile whose host half is absent shows no trace
of the page rather than a card whose fields can never be written.

## Install layout

| Path | Role |
|---|---|
| `<profile>/package.json` | the `file:` dependency that installs it, and the `dsh.profile.bundles` entry that composes it |
| `<profile>/node_modules/dsh-provider-quota/` | the installed package DSH actually loads — a real directory |
| `<profile>/cordis.patch.yml` | your own overrides; this package needs none |

The profile is `%USERPROFILE%\.dsh\profiles\desktop` on this machine. It is
installed the way a plugin is installed from a local folder:

```powershell
dsh plugin --profile desktop add "file:C:/path/to/dsh-provider-quota"
```

`file:` is not `link:`: the dependency pins a **real directory** in
`node_modules`, not a junction or symlink — its `LinkType` is empty and the running
plugin survives deleting or moving the source folder. It is **not** a byte-for-byte
copy either. pnpm hard-links each file, so the two trees share inodes; on Windows
both names show up in one list:

```powershell
fsutil hardlink list "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-provider-quota\lib\client.js"
#   \Users\Alei\.dsh\profiles\desktop\node_modules\dsh-provider-quota\lib\client.js
#   \Users\Alei\Documents\deepseek-harness\default-workspace\dsh-provider-quota\lib\client.js
```

That is pnpm's normal materialization for a `file:` **directory** dependency (the
marketplace's packages are hard-linked the same way, with the pnpm store on the
other end instead of a source folder), and `packageImportMethod: copy` does **not**
change it: pnpm applies that setting to store-backed packages, while a directory
dependency is always linked — verified by installing a scratch `file:` package with
`packageImportMethod: copy` in force and watching `fsutil` still report two names.
A byte-independent install would need a packed tarball
(`file:./dsh-provider-quota-0.1.0.tgz`) or a published package, both of which add a
packing step to every change.

Three consequences worth knowing:

- **An edit to the installed copy IS an edit to the source.** Same inode, so there
  is no "installed copy" to patch behind the source's back. This is exactly how a
  source file was corrupted once: the write went through the link.
- **A source edit needs a reinstall.** An editor that replaces a file (write to a
  temp name, then rename — the usual save) gives the source a new inode, so the
  installed name keeps the old content and neither `pnpm install` nor `pnpm add`
  refreshes it. Reinstall with the pair that does:

  ```powershell
  dsh plugin --profile desktop remove dsh-provider-quota
  dsh plugin --profile desktop add "file:C:/path/to/dsh-provider-quota"
  ```

- **It is removable from the Plugins page.** `installed: true` is what puts the
  bundle on that page and what draws its uninstall button; the button removes the
  bundle entry and runs `pnpm remove`. A hand-copied directory instead reports
  `installed: false`, which keeps it off the page entirely.

## Configuration

Optional; the defaults fit this install. The six live fields are normally edited
from the page above; the patch file is the fallback and the only way to set the
rest.

```yaml
- id: provider-quota
  name: dsh-provider-quota
  config:
    routePath: /dsh-provider-quota/usage       # ordinary
    providersPath: /dsh-provider-quota/providers  # ordinary
    minIntervalMs: 15000              # live: cache window between upstream reads
    timeoutMs: 10000                  # live: upstream read deadline
    warnRemaining: 30                 # live: remaining % that reads as a warning
    dangerRemaining: 10               # live: remaining % that reads as a danger
    warnValue: 0                      # live: amount that reads as a warning, 0 = off
    dangerValue: 0                    # live: amount that reads as a danger, 0 = off
    accountClientVersion: 0.1.0       # ordinary: x-client-version for account reads
    accountClientLocale: zh-CN        # ordinary: x-client-locale source
```

`warnRemaining` and `dangerRemaining` are percentages of remaining quota;
`warnValue` and `dangerValue` are amounts, and the two pairs are independent —
a percentage window is coloured only by the first, an amount window only by the
second, so a threshold in one currency can never reach another vendor's numbers.
The amount pair is off while `warnValue` is `0`, because a non-positive balance
is ordinary and an amount window then draws neutral rather than in a colour no
one asked for. Both pairs clamp and repair rather than refuse: percentages to
0–100, `danger` never above its `warn`, `dangerValue` never above `warnValue` —
a live form can hold either order for one keystroke.
`accountClientVersion` and `accountClientLocale` exist only for the
account-backed provider: the Platform's account endpoints require a calling
build's identity in their request headers. Both are telemetry, not
authorization — the stored login grant is what authenticates.

## UI: own controls, the host's material

The client half requires exactly one module — `react`, from the shell's baseline
module table. It loads **no Harness Client package**, because
`references/practices.md` of the packaged `cordis-plugin-development` skill
forbids it: those packages change without notice, a plain-JS plugin has no type
check, and a throwing component blanks the slot entry rather than reporting
anything (console: `slot entry crashed in '<slot>'`). `dsh.client.inject` entries
order activation and stay allowed; they are not a licence to `require` them.

So the controls are this package's own markup, with behavior copied from the host
components they replace:

| Seat | Own control |
|---|---|
| Panel | `<div popover="manual">` — the top layer, so no portal and no `document.body` |
| Header actions | `<button>` + two local stroked SVGs (`dsog-icon-refresh`, `dsog-icon-close`) |
| Provider badge | `<span class="dsog-tag">` |
| Status dot | `<span class="dsog-dot" data-tone>` |
| Card | `<li class="dsog-card">` — a disclosure like the host's plugin cards |
| Ring, bars | SVG arc and a filled bar; only the fill colors come from the theme |

The panel used to be `createPortal(…, document.body)`. It is a **popover** now:
`showPopover()` puts it in the top layer, which escapes the composer row's
overflow exactly as the portal did, while the element stays inside this
component's tree — the practice's "do not write DOM outside your component or
append to `document.body`" is satisfied without giving up the escape. The CSS
undoes the UA's popover box (`inset: auto`, `margin: 0`, no border, transparent
`::backdrop`) before positioning it at the anchor.

The surface is the theme's own popover material, not an approximation:
`--dsw-menu-surface-fill` over `--dsw-menu-backdrop-filter`. A hand-picked fill
reads as a mismatched card — `--dsw-alias-bg-overlay` is an opaque mid grey in the
dark palette, far lighter than DSH's own dark surfaces, whereas DSH's popovers are
translucent (`#43454a73` in dark) over a 40px backdrop blur. Both variables are
published by the theme package and each is referenced with an alias fallback, so a
rename degrades the surface instead of erasing it.

The chip hovers with `--dsw-alias-interactive-bg-hover` and holds its open state
with `--dsw-alias-interactive-bg-active` — the same translucent washes DSH's own
controls use. A solid layer fill is the wrong token here: `--dsw-alias-bg-layer-2`
is `neutral-bluish-850` in dark, close enough to the composer's own surface that
the hover reads as a text-only change.

### Visible text comes from the locale service

Every string the user can read is a key in two dictionaries registered with the
Client locale service under the `provider-quota` namespace, and both slot
registrations declare `locale: 'provider-quota'` — which is what makes the slot
kit hand the component a `t` bound to that namespace. Nothing else is hardcoded:
the smoke suite renders the card with an English translator and fails if a single
CJK character survives.

A component rendered without that kit (a server render, the smoke harness) falls
back to the shipped Chinese table — the same table, not a second copy of the copy.
That is also why `tOf(props)` exists instead of a required prop: the fallback
keeps the component renderable, and the suite asserts both tables carry identical
keys so the fallback can never drift.

The Plugin Manager reads a card's title and description from the manifest without
activating the plugin, so those two live in `locale/en.json` and `locale/zh.json`
under `meta` (exported as `./locale/*.json`, listed in `files`); `package.json`
keeps its `description` as the fallback.

### The stylesheet rides the render tree

The styles are rendered as a `<style data-provider-quota="panel">` element inside
the component's own tree, not injected once from `apply()`. A tag created at apply
time belongs to no lifecycle: if it is dropped — an HMR swap removes style tags
around a plugin's teardown, and nothing re-creates it afterwards — every class
silently stops applying. The chip then degrades to an unstyled `<button>` (the
browser's own grey chrome) with an invisible SVG ring, and the panel loses the box
that positions it. Riding the React tree means the styles exist exactly while
something they style is on screen.

Two details make that safe:

- The CSS is injected **raw** (`dangerouslySetInnerHTML`). React escapes a
  `<style>`'s text children, turning `"` into `&quot;`, and a `<style>` is a
  raw-text element whose entities are *not* decoded — so every attribute selector
  (`[data-tone="ok"]`, `[data-open="true"]`) would be silently dead.
- The ring's circles carry `stroke="currentColor"` as a presentation attribute.
  CSS overrides it with the theme's colors, and with no stylesheet at all the ring
  still draws in the inherited text color instead of vanishing, because SVG's
  default `stroke` is `none`.

Every variable the stylesheet names is one the live theme defines — the
`--dsw-alias-*` tokens plus the `--dsw-radius-*`, `--dsw-focus-ring-*`,
`--dsw-elevation-*` and `--dsw-menu-*` scales. The suite keeps the full token list
and fails on anything outside it, which is how `--dsw-alias-label-tertiary` was
caught (it is defined, but only by the plugin-manager stylesheet, not by the
theme) and how the panel's material was confirmed.

## Verifying it live

```powershell
curl.exe http://127.0.0.1:19387/dsh-provider-quota/providers
curl.exe "http://127.0.0.1:19387/dsh-provider-quota/usage?provider=opencode-go"
curl.exe "http://127.0.0.1:19387/dsh-provider-quota/usage?provider=deepseek-account"   # wallets
curl.exe "http://127.0.0.1:19387/dsh-provider-quota/usage?provider=openai"             # unsupported

# 258 assertions: bundle, slot placement (the composer cell and the bundle's own
# configuration seat, including the locale namespace both declare and the
# served-namespace gate), provider gating, panel rendering for both window shapes,
# the card's fields, diagnostics, disclosure behaviour (collapsed by default, no
# body in the DOM, chevron and aria wiring) and write path — a dispatcher rig types
# a value, clicks 保存, and reads back the operations the Host was handed
# (accept, refuse, reject, restore-defaults) — the dictionaries (identical keys,
# no Chinese left when an English translator is injected), stylesheet rules against
# the live token list, the volatile Config contract, tone cut points on both routes
# (both pairs), the account adapter's three distinguishable failure conditions,
# host routes end to end against fixtures including a second composition with a
# threshold override, and the separation of the two DeepSeek systems
$env:DSPQ_PLUGIN_DIR = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-provider-quota"
node scripts/smoke.mjs
```

Both payloads above carry `thresholds`, which is how you confirm the running host
is the current build: a restart is what re-reads `Config`, so a host still serving
an answer without that field is the older module. The bundle page's configuration
card is the client-side counterpart — it appears because this package occupies
`plugins.bundle.config`, which needs a page refresh rather than a restart.

The smoke test needs React, which it resolves from `DSPQ_HARNESS_DIR` (default:
`%TEMP%\dspq-harness`, a directory holding a `react` install); the plugin itself
takes React from the shell's baseline module table and never from disk. It refuses
every other module id, so a stray `require` of a Harness Client package fails the
run, and it drives the host routes with a fixture upstream, so a mistyped provider
id or a leaked credential fails it too. That harness is one install of its own:

```powershell
mkdir "$env:TEMP\dspq-harness"
cd "$env:TEMP\dspq-harness"
npm init -y; npm install react@18 react-dom@18
```

To prove the tests themselves still bite, mutate a **copy** of the package and
watch the suite go red — never the installed tree, whose files are hard-linked to
the source:

```powershell
# stages four mutations under %TEMP% and reports which assertions each one trips:
# an always-mounted card body, one hardcoded label, unregistered dictionaries,
# and a page that ignores the served namespace
node scripts/neg-proof.mjs "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-provider-quota"
```

## Known limitations

- **The OpenCode Go endpoint is internal.** See above.
- **Percentages, not dollars.** The Go plan's limits are per-model monthly dollar
  caps, but its endpoint surfaces one aggregate percentage per window.
- **It reports what the console reports.** Upstream has a known disagreement
  between the itemised usage log and the meter
  ([#44531](https://github.com/anomalyco/opencode/issues/44531)).
- **Host changes need a restart**, as described above.
- **Only one member per workspace** can hold a Go subscription, so the meter
  describes the subscription, not the reader.
