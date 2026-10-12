/**
 * Client half of the provider quota plugin.
 *
 * The chip is provider-aware. It reads the session's durable model selection
 * from the shared `modelDirectories` store — the same state the composer's model
 * seat and the `/model` popup write — and asks the host for that provider's
 * quota. A provider the host has no adapter for renders **nothing at all**:
 * the cell stays empty rather than showing another vendor's numbers.
 *
 * The panel draws whatever windows the adapter returned, so one renderer serves
 * a windowed subscription (percentages, reset times, meters) and a
 * pay-as-you-go balance (an amount, no percentage) without knowing which is
 * which beyond whether a window carries `remaining`.
 *
 * Every control is local. Harness Client packages are not loadable modules
 * (`references/practices.md`: `dsh.client.inject` orders activation only), so
 * the button, capsule, status dot, chevron, icons and card here are this
 * package's own markup, and the panel paints the host's popover material
 * instead of borrowing the shared surface. The only shared styling dependency
 * is the theme's own variables.
 *
 * All visible text comes from the dictionaries registered with the Client
 * locale service under `NS`; each component reads the `t` the slot kit hands a
 * registration that declares `locale`. A component rendered without that kit —
 * this package's own test harness — falls back to the shipped Chinese
 * dictionary, which is the same table, not a second copy of the copy.
 */
window.__ModuleLoader__.load({
	id: "dsh-provider-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");

		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useCallback = React.useCallback;
		var useSyncExternalStore = React.useSyncExternalStore;

		/** The locale namespace this package registers and renders under. */
		var NS = "provider-quota";
		var USAGE_ROUTE = "dsh-provider-quota/usage";
		var PROVIDERS_ROUTE = "dsh-provider-quota/providers";
		var POLL_MS = 300000;
		/**
		 * The version check's own clocks. Nothing about a release is a user
		 * action, so the card asks on mount, again whenever the reader comes back
		 * to the tab, and on a slow beat while the tab stays open.
		 *
		 * GitHub answers sixty unauthenticated requests an hour per address, and a
		 * check spends two or three of them, so the cadence is budgeted rather
		 * than merely slow: a return inside `RECHECK_MIN_MS` costs nothing, and
		 * `CHECKS_PER_HOUR` bounds an hour of flipping between windows — a reader
		 * who alt-tabs every minute must not turn that into a rate limit. The
		 * retry is one extra attempt after a check that could not answer, because
		 * an answer that never came is the one worth asking twice for.
		 */
		var RECHECK_MS = 900000;
		var RECHECK_MIN_MS = 300000;
		var RETRY_MS = 60000;
		var CHECKS_PER_HOUR = 6;

		/**
		 * Where this package updates itself from. The check reads the GitHub REST
		 * API without credentials, so the repository stays public; the install
		 * itself goes through the profile's package manager, never through us.
		 */
		var REPO = "Alei-001/dsh-provider-quota";
		var BRANCH = "main";
		var GITHUB_API = "https://api.github.com/repos/" + REPO;
		/** The finished-update notice a client reload must survive; one tab, one message. */
		var UPDATE_NOTICE_KEY = "dsh-provider-quota/updated";

		/**
		 * The spec the plugin manager is asked to install: the **alias** form
		 * (`name@github:owner/repo#commit`), for two measured reasons. `pnpm add`
		 * only re-resolves when the specifier changes, so the commit in the
		 * fragment is what turns a reinstall into an update — the same spec twice
		 * answers "Already up to date" in half a second. And the alias form keeps
		 * the manager's GitHub connection pre-check out of the path, which a bare
		 * `github:` spec trips over with a five-second timeout.
		 */
		function installSpecFor(sha) {
			return "dsh-provider-quota@github:" + REPO + "#" + sha;
		}

		/**
		 * The English dictionary. Every key is also in `ZH`; a key missing from
		 * the active dictionary renders as the key itself, which is why the smoke
		 * suite asserts the two tables have the same keys.
		 */
		var EN = {
			badgePlan: "Plan quota",
			refresh: "Refresh",
			close: "Close",
			quotaAria: "{name} quota",
			remainingQuota: "Remaining quota",
			usedPercent: "Used {percent}%",
			remainingPercent: "{percent}% left",
			barLabel: "{label}: {percent}% left",
			loading: "Reading quota…",
			updatedAt: "Updated {time}",
			neverFetched: "Not fetched yet",
			waitingData: "Waiting for data",
			autoRefresh: "Refreshes every {n} minutes",
			resetUnknown: "Reset time unknown",
			resetSoon: "Resets shortly",
			resetMinutes: "Resets in {n} min",
			resetHours: "Resets in {n} h",
			resetDays: "Resets in {n} d",
			resetAt: "{phrase} ({absolute})",
			dateAt: "{month}/{day} {time}",
			chipTitleMeasured: "{name} {window}: {remaining}% left (used {used}%) · {reset}",
			chipTitleValued: "{name} {window} {value}",
			chipTitlePending: "{name} quota",
			cardTitle: "Provider quota",
			cardDescription: "Thresholds, balance warnings, and the providers this host can measure.",
			expand: "Expand",
			collapse: "Collapse",
			summary: "Warn ≤{warn}% · Danger ≤{danger}%",
			summaryValue: " · Balance ≤{value}",
			summaryNoValue: " · Balance warning off",
			sectionProviders: "Providers this host can measure",
			none: "None",
			reading: "Reading…",
			readFailed: "Read failed",
			readFailedDetail: "Read failed: {error}",
			sectionFields: "Thresholds and reads",
			updateAvailable: "Version {version} is available",
			updateInstalled: "Installed {version}",
			update: "Update",
			updating: "Updating…",
			updatedTitle: "Updated to {version}",
			updateApplied: "The client half reloads by itself",
			updateRestart: "The client half reloads by itself; a host-half change needs a DSH restart",
			updateFailed: "Update failed: {error}",
			checkUnreadable: "Cannot read the installed or the published version",
			checkFailed: "Version check failed: {error}",
			dismiss: "Dismiss",
			fieldWarn: "Warning threshold",
			fieldWarnHint: "Turns amber at or below this remaining percentage",
			fieldDanger: "Danger threshold",
			fieldDangerHint: "Turns red at or below this remaining percentage",
			fieldInterval: "Read interval",
			fieldIntervalHint: "Shortest gap between two upstream reads, in milliseconds",
			fieldTimeout: "Read timeout",
			fieldTimeoutHint: "Deadline for one upstream read, in milliseconds",
			fieldWarnValue: "Balance warning amount",
			fieldWarnValueHint: "An amount window such as an API balance warns below this amount; 0 disables it",
			fieldDangerValue: "Balance danger amount",
			fieldDangerValueHint: "An amount window turns red below this amount; 0 disables it",
			save: "Save",
			saving: "Saving…",
			restore: "Restore defaults",
			saved: "Saved and applied",
			restored: "Defaults restored",
			noChanges: "Nothing to save",
			writeRefused: "The Host refused this write; reopen this page and try again",
			noForm:
				"This entry has no writable form right now (the Host offered none): the thresholds come from the Host's own configuration, the interval and timeout have no source to show, and the profile's cordis.patch.yml can be edited directly.",
			errRequired: "Enter a number",
			errNumber: "Not a valid number",
			errInteger: "Must be a whole number",
			errRange: "Must be between {min} and {max}",
			errDangerAboveWarn: "The danger threshold cannot be above the warning threshold",
			errValueInverted: "The danger amount cannot be above the warning amount",
			errField: "{field}: {error}",
		};

		/** The Chinese dictionary — the same keys, and the fallback table. */
		var ZH = {
			badgePlan: "套餐余量",
			refresh: "刷新",
			close: "关闭",
			quotaAria: "{name} 余量",
			remainingQuota: "剩余配额",
			usedPercent: "已用 {percent}%",
			remainingPercent: "剩余 {percent}%",
			barLabel: "{label}剩余 {percent}%",
			loading: "正在读取余量…",
			updatedAt: "更新于 {time}",
			neverFetched: "尚未获取",
			waitingData: "等待数据",
			autoRefresh: "每 {n} 分钟自动刷新",
			resetUnknown: "重置时间未知",
			resetSoon: "即将重置",
			resetMinutes: "{n} 分钟后重置",
			resetHours: "{n} 小时后重置",
			resetDays: "{n} 天后重置",
			resetAt: "{phrase}（{absolute}）",
			dateAt: "{month}月{day}日 {time}",
			chipTitleMeasured: "{name} {window}剩余 {remaining}%（已用 {used}%）· {reset}",
			chipTitleValued: "{name} {window} {value}",
			chipTitlePending: "{name} 余量",
			cardTitle: "供应商额度",
			cardDescription: "阈值、余额预警与本机可测量的供应商。",
			expand: "展开",
			collapse: "收起",
			summary: "预警 ≤{warn}% · 危险 ≤{danger}%",
			summaryValue: " · 余额 ≤{value}",
			summaryNoValue: " · 余额预警未启用",
			sectionProviders: "本机可测量的供应商",
			none: "无",
			reading: "读取中…",
			readFailed: "读取失败",
			readFailedDetail: "读取失败：{error}",
			sectionFields: "阈值与读取",
			updateAvailable: "有新版本 v{version}",
			updateInstalled: "当前 v{version}",
			update: "更新",
			updating: "更新中…",
			updatedTitle: "已更新到 v{version}",
			updateApplied: "客户端半会自动重载",
			updateRestart: "客户端半会自动重载；宿主半的改动要重启 DSH 才生效",
			updateFailed: "更新失败：{error}",
			checkUnreadable: "读不到已安装版本或仓库版本",
			checkFailed: "版本检查失败：{error}",
			dismiss: "知道了",
			fieldWarn: "预警阈值",
			fieldWarnHint: "剩余等于或低于该百分比时显示提醒色",
			fieldDanger: "危险阈值",
			fieldDangerHint: "剩余等于或低于该百分比时显示危险色",
			fieldInterval: "读取间隔",
			fieldIntervalHint: "两次上游读取之间的最短间隔（毫秒）",
			fieldTimeout: "读取超时",
			fieldTimeoutHint: "单次上游读取的截止时间（毫秒）",
			fieldWarnValue: "余额预警值",
			fieldWarnValueHint: "金额型窗口（如 API 余额）低于该金额就提醒；填 0 表示不启用",
			fieldDangerValue: "余额危险值",
			fieldDangerValueHint: "金额型窗口低于该金额就危险；填 0 表示不启用",
			save: "保存",
			saving: "保存中…",
			restore: "恢复默认",
			saved: "已保存并立即生效",
			restored: "已恢复默认值",
			noChanges: "没有需要保存的改动",
			writeRefused: "Host 拒绝了这次写入，请重新打开本页再试",
			noForm:
				"该条目当前没有可写的表单（Host 未提供）：阈值取自 Host 实际配置，间隔与超时没有可显示的来源；也可以直接编辑 profile 的 cordis.patch.yml。",
			errRequired: "请填写数值",
			errNumber: "不是有效数值",
			errInteger: "必须是整数",
			errRange: "需在 {min}–{max} 之间",
			errDangerAboveWarn: "危险阈值不能高于预警阈值",
			errValueInverted: "余额危险值不能高于余额预警值",
			errField: "{field}：{error}",
		};

		var DICTS = { en: EN, zh: ZH };

		/** `{name}` substitution, the Client locale service's own template syntax. */
		function fill(template, params) {
			if (params === undefined || params === null) return template;
			return template.replace(/\{(\w+)\}/g, function (match, name) {
				return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
			});
		}

		/**
		 * The `t` a component renders with. A registration that declares `locale`
		 * is handed the service's own translator; anything else — a server render,
		 * this package's test harness — reads the shipped Chinese table, so the
		 * copy still lives in exactly one place.
		 */
		function tOf(props) {
			if (props !== null && props !== undefined && typeof props.t === "function") return props.t;
			return function (key, params) {
				var template = Object.prototype.hasOwnProperty.call(ZH, key) ? ZH[key] : key;
				return fill(template, params);
			};
		}

		/*
		 * Only variables the live theme defines are used. The panel paints the
		 * host's popover material (`--dsw-menu-surface-fill` over
		 * `--dsw-menu-backdrop-filter`), which is what the shared menu surface
		 * paints; both are published by the theme package, and each falls back to
		 * an alias token so a rename degrades the surface instead of erasing it.
		 */
		var CSS = [
			".dsog-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 7px;border:0;",
			"border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);",
			"font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,color .12s ease}",
			// The translucent wash DSH's own controls and the web-search chip use;
			// a solid layer fill disappears into the composer's own background.
			".dsog-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			'.dsog-chip[data-open="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
			".dsog-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:1px}",
			".dsog-chip-label{font-variant-numeric:tabular-nums;min-width:2.1em;text-align:left}",
			// A balance chip carries no ring, so its label takes the tone instead.
			'.dsog-chip-label[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
			'.dsog-chip-label[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
			".dsog-ring{display:block;flex:none}",
			".dsog-ring-track{stroke:var(--dsw-alias-border-l2)}",
			'.dsog-ring-value[data-tone="ok"]{stroke:var(--dsw-alias-state-success-primary)}',
			'.dsog-ring-value[data-tone="warn"]{stroke:var(--dsw-alias-state-warn-primary)}',
			'.dsog-ring-value[data-tone="danger"]{stroke:var(--dsw-alias-state-error-primary)}',
			'.dsog-ring-value[data-tone="unknown"]{stroke:var(--dsw-alias-state-idle-primary)}',
			".dsog-ring-value{transition:stroke-dashoffset .35s ease}",
			// The panel is a popover, so it sits in the top layer and escapes the
			// composer row's overflow without a portal. These declarations undo the
			// UA's own popover box (inset:0, margin:auto, border, padding, backdrop)
			// and then paint the host's material.
			".dsog-panel{position:fixed;inset:auto;margin:0;border:.5px solid var(--dsw-alias-border-l3);",
			"border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-1));",
			"backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));",
			"box-shadow:var(--dsw-elevation-panel,0 12px 32px rgba(0,0,0,.28));",
			"z-index:100;width:296px;max-height:min(70vh,520px);overflow:auto;box-sizing:border-box;padding:14px 14px 12px;",
			"color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}",
			".dsog-panel::backdrop{background:transparent}",
			".dsog-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}",
			".dsog-header-text{display:flex;align-items:center;gap:6px;min-width:0}",
			".dsog-title{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsog-actions{display:flex;align-items:center;gap:2px;flex:none}",
			".dsog-icon-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;",
			"border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);",
			"cursor:pointer;font:inherit;font-size:12px}",
			".dsog-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsog-icon-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:1px}",
			".dsog-icon{display:block;flex:none}",
			".dsog-dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--dsw-alias-state-idle-primary)}",
			'.dsog-dot[data-tone="ok"]{background:var(--dsw-alias-state-success-primary)}',
			'.dsog-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}',
			'.dsog-dot[data-tone="danger"]{background:var(--dsw-alias-state-error-primary)}',
			".dsog-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;",
			"border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}",
			".dsog-hero{display:flex;align-items:center;gap:14px;padding:2px 0 12px}",
			".dsog-hero-ring{position:relative;flex:none;width:76px;height:76px}",
			".dsog-hero-percent{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;",
			"font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}",
			'.dsog-hero-percent[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
			'.dsog-hero-percent[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
			'.dsog-hero-percent[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
			".dsog-hero-text{min-width:0}",
			".dsog-hero-title{font-weight:600}",
			".dsog-hero-sub{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsog-hero-meta{font-size:12px;font-variant-numeric:tabular-nums;margin-top:2px}",
			".dsog-hero-value{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}",
			'.dsog-hero-value[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
			'.dsog-hero-value[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
			".dsog-muted{color:var(--dsw-alias-label-secondary)}",
			".dsog-row{padding:9px 0 0;border-top:1px solid var(--dsw-alias-border-l1);margin-top:9px}",
			".dsog-row:first-of-type{border-top:0;margin-top:0}",
			".dsog-row-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}",
			".dsog-row-label{font-weight:500}",
			".dsog-row-figures{display:flex;align-items:baseline;gap:6px;font-size:12px;font-variant-numeric:tabular-nums}",
			'.dsog-row-remaining[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
			'.dsog-row-remaining[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
			'.dsog-row-remaining[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
			".dsog-row-used{color:var(--dsw-alias-label-secondary)}",
			".dsog-row-value{font-variant-numeric:tabular-nums}",
			'.dsog-row-value[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
			'.dsog-row-value[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
			".dsog-bar{position:relative;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
			".dsog-bar-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;transition:width .35s ease}",
			'.dsog-bar-fill[data-tone="ok"]{background:var(--dsw-alias-state-success-primary)}',
			'.dsog-bar-fill[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}',
			'.dsog-bar-fill[data-tone="danger"]{background:var(--dsw-alias-state-error-primary)}',
			'.dsog-bar-fill[data-tone="unknown"]{background:var(--dsw-alias-state-idle-primary)}',
			".dsog-row-foot{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:5px}",
			".dsog-notice{margin-top:10px;padding:7px 9px;border-radius:8px;font-size:12px;",
			"background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
			'.dsog-notice[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
			'.dsog-notice[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
			".dsog-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;",
			"padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px}",
			// The card the Plugins tab renders on this bundle's page: a disclosure
			// like the host's own plugin cards, in the host's card material, so the
			// page starts collapsed and expands on click.
			".dsog-card{list-style:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);",
			"background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);",
			"transition:border-color .16s ease;overflow:hidden}",
			".dsog-card:hover{border-color:var(--dsw-alias-border-l3)}",
			'.dsog-card[data-open="true"]{border-color:var(--dsw-alias-border-l3)}',
			".dsog-card-head{width:100%;box-sizing:border-box;appearance:none;border:0;background:none;font:inherit;",
			"color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:12px 14px}",
			".dsog-card-head:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsog-card-head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
			".dsog-card-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
			".dsog-card-title{font-size:14px;font-weight:500;line-height:20px}",
			".dsog-card-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px}",
			".dsog-card-meta{flex:none;display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsog-chevron{display:block;flex:none;transition:transform .16s ease}",
			'.dsog-card[data-open="true"] .dsog-chevron{transform:rotate(180deg)}',
			".dsog-card-body{display:flex;flex-direction:column;gap:16px;padding:0 14px 14px;font-size:13px;",
			"color:var(--dsw-alias-label-primary)}",
			".dsog-page-section{display:flex;flex-direction:column;gap:8px}",
			".dsog-page-title{font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;",
			"color:var(--dsw-alias-label-secondary)}",
			".dsog-diag-list{display:inline-flex;flex-wrap:wrap;gap:4px;min-width:0}",
			".dsog-pill{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;",
			"border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;",
			"font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dsog-field{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0}",
			".dsog-field-text{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dsog-field-name{font-weight:500}",
			".dsog-input{width:122px;box-sizing:border-box;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);",
			"border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;",
			"font-size:12px;font-variant-numeric:tabular-nums;text-align:right;flex:none}",
			".dsog-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:1px}",
			'.dsog-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}',
			".dsog-page-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsog-page-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0;",
			"border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover);color:inherit;",
			"font:inherit;font-size:12px;cursor:pointer}",
			".dsog-page-button:hover{background:var(--dsw-alias-interactive-bg-active)}",
			".dsog-page-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:1px}",
			".dsog-page-button[disabled]{opacity:.55;cursor:default}",
			".dsog-hint{color:var(--dsw-alias-label-secondary);font-size:11px}",
			'.dsog-hint[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}',
			'.dsog-hint[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
			// The update row exists only while the remote carries a newer release, and
			// it is the one place this card acts on the package itself. It rides the
			// card, not the body: a release is not something to go looking for behind
			// a disclosure, so the row is on screen whether or not the card is open.
			".dsog-update{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;",
			"border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);",
			"background:var(--dsw-alias-bg-layer-2)}",
			".dsog-card > .dsog-update{margin:0 14px 12px}",
			".dsog-update-text{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dsog-update-title{font-weight:500}",
			".dsog-update .dsog-page-button{flex:none}",
		].join("");

		/**
		 * The stylesheet, rendered into the tree rather than injected once from
		 * `apply`. A tag created at apply time belongs to no lifecycle: if it is
		 * dropped (an HMR swap removes style tags around a plugin's teardown, and
		 * nothing re-creates it afterwards) every class below silently stops
		 * applying, which leaves an unstyled `<button>` and an SVG ring whose
		 * strokes come only from those classes. Riding the React tree means the
		 * styles are present exactly while something they style is on screen.
		 */
		function StyleSheet() {
			// Raw injection, not a text child: React escapes `"` to `&quot;`, and a
			// `<style>` is a raw-text element whose entities are NOT decoded, so
			// every attribute selector (`[data-tone="ok"]`, `[data-open="true"]`)
			// would be silently dead.
			return h("style", {
				"data-provider-quota": "panel",
				dangerouslySetInnerHTML: { __html: CSS },
			});
		}

		/** Candidate absolute paths for one route, nearest first. A sub-path mount
		 * resolves a relative route beneath it, so the root stays as a fallback.
		 */
		function routePaths(relative, baseURI) {
			var root = "/" + relative;
			var primary = root;
			try {
				primary = new URL(relative, baseURI).pathname;
			} catch (error) {
				primary = root;
			}
			return primary === root ? [root] : [primary, root];
		}

		/** One JSON read of a host route, walking the candidate paths on a 404. */
		function readRoute(relative, query) {
			var base = typeof document === "undefined" ? "/" : document.baseURI;
			var paths = routePaths(relative, base);
			var suffix = typeof query === "string" ? query : "";
			function read(index) {
				return fetch(paths[index] + suffix, {
					cache: "no-store",
					credentials: "same-origin",
					headers: { accept: "application/json" },
				}).then(function (response) {
					if (response.status === 404 && index + 1 < paths.length) return read(index + 1);
					return response.json();
				});
			}
			return read(0);
		}

		/** The provider ids this host can measure, cached for the page's lifetime. */
		var adaptedCache = { ids: null, pending: null };

		function loadAdapted() {
			if (adaptedCache.ids !== null) return Promise.resolve(adaptedCache.ids);
			if (adaptedCache.pending !== null) return adaptedCache.pending;
			adaptedCache.pending = readRoute(PROVIDERS_ROUTE, null)
				.then(function (body) {
					var list =
						body !== null && typeof body === "object" && body.ok === true && Array.isArray(body.matched)
							? body.matched.filter(function (id) {
									return typeof id === "string";
								})
							: null;
					if (list !== null) adaptedCache.ids = list;
					return list;
				})
				.catch(function () {
					return null;
				})
				.then(function (list) {
					adaptedCache.pending = null;
					return list;
				});
			return adaptedCache.pending;
		}

		/** Per-provider snapshots, so switching back to a provider is instant. */
		var snapshotCache = {};

		function loadSnapshot(providerId, force) {
			var query = "?provider=" + encodeURIComponent(providerId) + (force === true ? "&force=1" : "");
			return readRoute(USAGE_ROUTE, query)
				.then(function (body) {
					if (body !== null && typeof body === "object" && body.ok === true) {
						snapshotCache[providerId] = {
							snapshot: body,
							fetchedAt: typeof body.fetchedAt === "number" ? body.fetchedAt : Date.now(),
							error: null,
							warning: typeof body.warning === "string" ? body.warning : null,
						};
						return snapshotCache[providerId];
					}
					var message =
						body !== null && typeof body === "object" && typeof body.error === "string"
							? body.error
							: "读取余量失败";
					return failed(providerId, message);
				})
				.catch(function (error) {
					return failed(
						providerId,
						error !== null && error !== undefined && typeof error.message === "string"
							? error.message
							: String(error),
					);
				});
		}

		/** Record a failure while keeping the last good snapshot, if there was one. */
		function failed(providerId, message) {
			var previous = snapshotCache[providerId];
			snapshotCache[providerId] = {
				snapshot: previous === undefined ? null : previous.snapshot,
				fetchedAt: previous === undefined ? 0 : previous.fetchedAt,
				error: message,
				warning: null,
			};
			return snapshotCache[providerId];
		}

		/** The provider id of a directory snapshot, or null while it is unresolved. */
		function providerOf(state) {
			var current = state !== null && state !== undefined ? state.current : null;
			if (current === null || current === undefined || typeof current !== "object") return null;
			return typeof current.provider === "string" && current.provider.length > 0 ? current.provider : null;
		}

		/**
		 * The store the chip subscribes to when the slot injected none. Its
		 * `getSnapshot` returns a constant so `useSyncExternalStore` never sees a
		 * fresh value and re-renders forever, and the hook call stays
		 * unconditional — a conditional hook would break the moment the slot
		 * supplied a face on one render and not the next.
		 */
		var EMPTY_SELECTION_STORE = {
			subscribe: function () {
				return function () {};
			},
			getSnapshot: function () {
				return null;
			},
		};

		/** Subscribe to a session's model directory — the shared model-selection
		 * store. The third argument is only ever used by a server renderer; the
		 * browser mount never calls it, and it is what lets the chip be rendered
		 * under test.
		 */
		function useSelection(store) {
			var subscribe = useCallback(
				function (notify) {
					return store.subscribe(notify);
				},
				[store],
			);
			var getSnapshot = useCallback(
				function () {
					return store.getSnapshot();
				},
				[store],
			);
			return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
		}

		/** The host's adapted-provider list, or null while unknown. */
		function useAdaptedProviders() {
			var pair = useState(adaptedCache.ids);
			var ids = pair[0];
			var setIds = pair[1];
			useEffect(
				function () {
					if (ids !== null) return undefined;
					var cancelled = false;
					void loadAdapted().then(function (list) {
						if (!cancelled && list !== null) setIds(list);
					});
					return function () {
						cancelled = true;
					};
				},
				[ids],
			);
			return ids;
		}

		/** The active provider's snapshot, keyed by provider so a switch never
		 * renders one vendor's numbers under another vendor's name.
		 */
		function useProviderQuota(providerId) {
			var pair = useState({ provider: null, entry: null });
			var state = pair[0];
			var setState = pair[1];
			var refresh = useCallback(
				function (force) {
					if (providerId === null) return Promise.resolve(null);
					return loadSnapshot(providerId, force).then(
						function (next) {
							setState({ provider: providerId, entry: next });
							return next;
						},
						function () {
							return null;
						},
					);
				},
				[providerId],
			);
			useEffect(
				function () {
					if (providerId === null) {
						setState({ provider: null, entry: null });
						return undefined;
					}
					setState({ provider: providerId, entry: snapshotCache[providerId] ?? null });
					var cancelled = false;
					void loadSnapshot(providerId, false).then(function (next) {
						if (!cancelled) setState({ provider: providerId, entry: next });
					}, function () {});
					return function () {
						cancelled = true;
					};
				},
				[providerId],
			);
			return { entry: state.provider === providerId ? state.entry : null, refresh: refresh };
		}

		/** The window the ring shows: the adapter's primary, else the first one. */
		function heroOf(snapshot) {
			var windows = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.windows) ? snapshot.windows : null;
			if (windows === null || windows.length === 0) return null;
			for (var index = 0; index < windows.length; index++) {
				if (windows[index].key === snapshot.primary) return windows[index];
			}
			return windows[0];
		}

		/** Every window except the hero, in the adapter's order. */
		function restOf(snapshot) {
			var windows = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.windows) ? snapshot.windows : null;
			if (windows === null || windows.length === 0) return [];
			var hero = heroOf(snapshot);
			var rest = [];
			for (var index = 0; index < windows.length; index++) {
				if (windows[index] !== hero) rest.push(windows[index]);
			}
			return rest;
		}

		/** Whether a window carries a percentage, and so can be drawn as a meter. */
		function isMeasured(window) {
			return (
				window !== null &&
				window !== undefined &&
				typeof window.remaining === "number" &&
				isFinite(window.remaining)
			);
		}

		/** The cut points the host last published, for the card that shows them. The
		 * shipped pair stands in only for the moment before the first answer lands. */
		function thresholdsOf(value) {
			var number = function (name, fallback) {
				return value !== null && typeof value === "object" && typeof value[name] === "number" && isFinite(value[name])
					? value[name]
					: fallback;
			};
			return {
				warn: number("warn", 30),
				danger: number("danger", 10),
				warnValue: number("warnValue", 0),
				dangerValue: number("dangerValue", 0),
			};
		}

		/**
		 * One window's tone, as the host decided it. The host owns the decision —
		 * the cut points are its config and the amounts are its data — and it puts
		 * the answer on the window, which is what lets an amount window be warned
		 * about without the browser parsing "CNY 110.00". A window that somehow
		 * carries no tone draws neutral rather than being re-decided here.
		 */
		function toneOfWindow(window) {
			var tone = window !== null && window !== undefined && typeof window.tone === "string" ? window.tone : null;
			return tone === "ok" || tone === "warn" || tone === "danger" || tone === "unknown" ? tone : "unknown";
		}

		/** A thrown value's message, or its text when it is not an Error. */
		function textOf(error) {
			return error !== null && error !== undefined && typeof error.message === "string"
				? error.message
				: String(error);
		}

		/** The version of this package in a `listBundles()` answer, or null. */
		function installedVersion(bundles) {
			if (!Array.isArray(bundles)) return null;
			for (var index = 0; index < bundles.length; index++) {
				var bundle = bundles[index];
				if (
					bundle !== null &&
					typeof bundle === "object" &&
					bundle.name === "dsh-provider-quota" &&
					typeof bundle.version === "string"
				) {
					return bundle.version;
				}
			}
			return null;
		}

		/** A dotted version's numeric parts; a prerelease suffix and junk count as 0. */
		function versionParts(value) {
			var text = typeof value === "string" ? value.trim().replace(/^v/, "") : "";
			return text
				.split("-")[0]
				.split(".")
				.map(function (part) {
					var number = parseInt(part, 10);
					return isFinite(number) && number >= 0 ? number : 0;
				});
		}

		/** Whether `remote` names a strictly newer release than `installed`. */
		function isNewer(remote, installed) {
			if (typeof remote !== "string" || typeof installed !== "string") return false;
			var left = versionParts(remote);
			var right = versionParts(installed);
			var length = Math.max(left.length, right.length);
			for (var index = 0; index < length; index++) {
				var candidate = left[index] ?? 0;
				var current = right[index] ?? 0;
				if (candidate !== current) return candidate > current;
			}
			return false;
		}

		/** What the check decided, as the plain object the row renders from. */
		function updateDecision(installed, remote, sha) {
			if (!isNewer(remote, installed)) {
				return { status: "current", installed: installed, remote: remote, sha: null };
			}
			return {
				status: "available",
				installed: installed,
				remote: remote,
				sha: typeof sha === "string" ? sha : null,
			};
		}

		/** GitHub answers with base64; this is the UTF-8 text it stands for. */
		function decodeBase64(text) {
			var binary = atob(String(text).replace(/\s+/g, ""));
			var bytes = new Uint8Array(binary.length);
			for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
			return new TextDecoder().decode(bytes);
		}

		/** One GitHub REST read; a non-2xx becomes a rejection carrying its status. */
		function readGithub(path) {
			return fetch(GITHUB_API + path, {
				cache: "no-store",
				headers: { accept: "application/vnd.github+json" },
			}).then(function (response) {
				if (response.ok !== true) throw new Error("GitHub " + response.status);
				return response.json();
			});
		}

		/** The `version` field of a GitHub contents answer, or null. */
		function remoteVersion(file) {
			if (file === null || typeof file !== "object" || typeof file.content !== "string") return null;
			try {
				var parsed = JSON.parse(decodeBase64(file.content));
				return parsed !== null && typeof parsed === "object" && typeof parsed.version === "string"
					? parsed.version
					: null;
			} catch (error) {
				return null;
			}
		}

		/**
		 * One `ctx.remote` answer, unwrapped to the value it carries. Every unary
		 * remote call resolves to `RemoteResult` — `{ ok: true, value }` or
		 * `{ ok: false, error }` — and never rejects for a carrier problem, so a
		 * consumer that reads the answer itself reads an object where an array or a
		 * `ChangeResult` belongs. That is how this card once asked for the bundle
		 * list and got "installed version unknown" out of every answer: the check
		 * bailed silently and no update row ever appeared.
		 *
		 * An unwrapped value passes straight through, so the same code serves a
		 * deployment whose remote face answers plainly.
		 */
		function remoteResult(answer) {
			if (answer === null || answer === undefined || typeof answer !== "object" || typeof answer.ok !== "boolean") {
				return answer;
			}
			if (answer.ok === true) return answer.value;
			throw new Error(remoteErrorText(answer.error));
		}

		/** A remote failure's own words: its code and message, never "[object Object]". */
		function remoteErrorText(error) {
			if (error === null || error === undefined) return "unknown";
			if (typeof error !== "object") return String(error);
			var code = typeof error.code === "string" && error.code.length > 0 ? error.code : null;
			var message = typeof error.message === "string" && error.message.length > 0 ? error.message : null;
			if (code === null) return message === null ? String(error) : message;
			return message === null ? code : code + ": " + message;
		}

		/** Why an install result failed, or null when it did not. */
		function updateFailure(answer) {
			if (answer === null || answer === undefined || typeof answer !== "object") return "no result";
			// The answer first, then the install's own result inside it: a refused
			// call is a failed update before any `ChangeResult` exists.
			if (typeof answer.ok === "boolean") {
				if (answer.ok !== true) return remoteErrorText(answer.error);
				return updateFailure(answer.value);
			}
			if (answer.application === "failed" || answer.application === "cancelled") {
				var diagnostic = answer.error === null || answer.error === undefined ? null : answer.error.diagnostic;
				return typeof diagnostic === "string" && diagnostic.length > 0 ? diagnostic : answer.application;
			}
			var run = answer.packageResult;
			if (run !== null && run !== undefined && run.exitCode !== 0) {
				return typeof run.output === "string" && run.output.length > 0 ? run.output : "exit " + run.exitCode;
			}
			return null;
		}

		/** The finished-update notice this tab is still holding, or null. */
		function readUpdateNotice() {
			try {
				var raw = window.sessionStorage.getItem(UPDATE_NOTICE_KEY);
				if (raw === null) return null;
				var parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" && typeof parsed.version === "string" ? parsed : null;
			} catch (error) {
				return null;
			}
		}

		/** Remember a finished update so the automatic client reload still shows it. */
		function writeUpdateNotice(notice) {
			try {
				window.sessionStorage.setItem(UPDATE_NOTICE_KEY, JSON.stringify(notice));
			} catch (error) {
				// A browser that refuses storage loses the notice, not the update.
			}
		}

		/** Forget the notice once the reader has acknowledged it. */
		function clearUpdateNotice() {
			try {
				window.sessionStorage.removeItem(UPDATE_NOTICE_KEY);
			} catch (error) {
				// Nothing to clear when storage is unavailable.
			}
		}

		function pad2(value) {
			return value < 10 ? "0" + value : String(value);
		}

		/** Local wall-clock time, for the absolute half of a reset label. */
		function clockText(at) {
			var date = new Date(at);
			if (isNaN(date.getTime())) return "";
			return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
		}

		function absoluteText(at, t) {
			var date = new Date(at);
			if (isNaN(date.getTime())) return "";
			return t("dateAt", {
				month: String(date.getMonth() + 1),
				day: String(date.getDate()),
				time: clockText(at),
			});
		}

		/**
		 * "2 小时后重置（10月12日 08:00）" — the magnitude and the absolute stamp,
		 * both through the dictionary, so an English shell reads
		 * "Resets in 2 h (10/12 08:00)".
		 */
		function resetText(iso, t) {
			var translate = typeof t === "function" ? t : tOf(null);
			if (typeof iso !== "string") return translate("resetUnknown");
			var at = Date.parse(iso);
			if (!isFinite(at)) return translate("resetUnknown");
			var delta = at - Date.now();
			if (delta <= 0) return translate("resetSoon");
			var minutes = Math.round(delta / 60000);
			var phrase;
			if (minutes < 1) phrase = translate("resetSoon");
			else if (minutes < 60) phrase = translate("resetMinutes", { n: String(minutes) });
			else if (minutes < 60 * 48) phrase = translate("resetHours", { n: String(Math.round(minutes / 60)) });
			else phrase = translate("resetDays", { n: String(Math.round(minutes / (60 * 24))) });
			var absolute = absoluteText(at, translate);
			return absolute.length > 0 ? translate("resetAt", { phrase: phrase, absolute: absolute }) : phrase;
		}

		/**
		 * The ring. `fraction` is remaining quota, so a full ring means the whole
		 * window is still available and it depletes as the window is spent.
		 */
		function Ring(props) {
			var size = props.size || 20;
			var stroke = props.stroke || 2.5;
			var radius = (size - stroke) / 2;
			var circumference = 2 * Math.PI * radius;
			var raw = typeof props.fraction === "number" && isFinite(props.fraction) ? props.fraction : 0;
			var fraction = Math.min(1, Math.max(0, raw));
			return h(
				"svg",
				{
					className: "dsog-ring",
					width: size,
					height: size,
					viewBox: "0 0 " + size + " " + size,
					"aria-hidden": "true",
				},
				h("circle", {
					className: "dsog-ring-track",
					cx: size / 2,
					cy: size / 2,
					r: radius,
					fill: "none",
					strokeWidth: stroke,
					// A presentation attribute is the render-time fallback: CSS below
					// overrides it with the theme's own colors, and if the stylesheet is
					// ever absent the ring still draws in the inherited text color
					// instead of vanishing (`stroke` defaults to `none`).
					stroke: "currentColor",
					opacity: 0.25,
				}),
				h("circle", {
					className: "dsog-ring-value",
					"data-tone": props.tone || "ok",
					cx: size / 2,
					cy: size / 2,
					r: radius,
					fill: "none",
					strokeWidth: stroke,
					stroke: "currentColor",
					strokeLinecap: "round",
					strokeDasharray: circumference,
					strokeDashoffset: circumference * (1 - fraction),
					transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")",
				}),
			);
		}

		/** The bar: only the fill colors come from the theme — green, amber, red. */
		function Bar(props) {
			var raw = typeof props.fraction === "number" && isFinite(props.fraction) ? props.fraction : 0;
			var percent = Math.min(100, Math.max(0, raw * 100));
			return h(
				"div",
				{
					className: "dsog-bar",
					role: "progressbar",
					"aria-valuemin": 0,
					"aria-valuemax": 100,
					"aria-valuenow": Math.round(percent),
					"aria-label": props.label,
				},
				h("div", { className: "dsog-bar-fill", "data-tone": props.tone || "ok", style: { width: percent + "%" } }),
			);
		}

		/** A stroked glyph at the size the call site asks for. */
		function glyph(name, size, paths) {
			return h(
				"svg",
				{
					className: "dsog-icon dsog-icon-" + name,
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.7,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				paths.map(function (d, index) {
					return h("path", { key: index, d: d });
				}),
			);
		}

		function IconRefresh(props) {
			return glyph("refresh", props.size || 16, ["M20 12a8 8 0 1 1-2.35-5.65", "M20 4v4h-4"]);
		}

		function IconClose(props) {
			return glyph("close", props.size || 16, ["M6 6l12 12", "M18 6L6 18"]);
		}

		/** The balance indicator: a wallet, drawn when no percentage exists. */
		function IconWallet(props) {
			return glyph("wallet", props.size || 16, ["M3 7.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M3 7.5V6a2 2 0 0 1 2-2h11", "M16 12.5h2"]);
		}

		/** The disclosure chevron, rotated by the card's own CSS when it opens. */
		function IconChevron(props) {
			return glyph("chevron", props.size || 16, ["M6 9l6 6 6-6"]);
		}

		/** One icon action in the panel header. */
		function ActionButton(props) {
			var glyphNode = props.icon === undefined || props.icon === null ? null : h(props.icon, { size: 16 });
			return h(
				"button",
				{
					type: "button",
					className: "dsog-icon-button",
					onClick: props.onClick,
					title: props.label,
					"aria-label": props.label,
				},
				glyphNode,
			);
		}

		/** Read-only capsule badge. */
		function badge(text) {
			return h("span", { className: "dsog-tag" }, text);
		}

		/** The status mark beside the panel title. */
		function statusDot(tone) {
			return h("span", { className: "dsog-dot", "data-tone": tone, "aria-hidden": "true" });
		}

		/**
		 * Anchor a panel above its button, clamped to the viewport, re-measured on
		 * scroll and resize. The panel starts hidden because a popover is
		 * `display:none` until it is shown, so the measurement runs again on the
		 * next frame — by then the popover is in the top layer and has a size.
		 */
		function useAnchoredPosition(options) {
			var open = options.open;
			var anchorRef = options.anchorRef;
			var panelRef = options.panelRef;
			var gap = options.gap === undefined ? 8 : options.gap;
			var margin = options.margin === undefined ? 8 : options.margin;
			var pair = useState(null);
			var position = pair[0];
			var setPosition = pair[1];
			useEffect(
				function () {
					if (open !== true) {
						setPosition(null);
						return undefined;
					}
					function update() {
						var anchor = anchorRef.current;
						if (anchor === null || anchor === undefined) return;
						var rect = anchor.getBoundingClientRect();
						var panel = panelRef.current;
						var width = panel !== null && panel !== undefined ? panel.offsetWidth : 0;
						var height = panel !== null && panel !== undefined ? panel.offsetHeight : 0;
						var left = rect.left;
						var top = rect.top - gap - height;
						if (width > 0) {
							left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin));
						}
						if (height > 0) {
							top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - height - margin));
						}
						setPosition({ left: left, top: top });
					}
					update();
					var frame = window.requestAnimationFrame(update);
					window.addEventListener("scroll", update, true);
					window.addEventListener("resize", update);
					return function () {
						window.cancelAnimationFrame(frame);
						window.removeEventListener("scroll", update, true);
						window.removeEventListener("resize", update);
					};
				},
				[anchorRef, gap, margin, open, panelRef],
			);
			return position;
		}

		/** Close the panel when a pointer lands outside both the chip and it. */
		function useDismissOnOutsidePointer(anchorRef, open, setOpen, panelRef) {
			useEffect(
				function () {
					if (open !== true) return undefined;
					function onPointerDown(event) {
						var target = event.target;
						if (!(target instanceof Node)) return;
						var anchor = anchorRef.current;
						var panel = panelRef.current;
						if (anchor !== null && anchor !== undefined && anchor.contains(target)) return;
						if (panel !== null && panel !== undefined && panel.contains(target)) return;
						setOpen(false);
					}
					document.addEventListener("pointerdown", onPointerDown);
					return function () {
						document.removeEventListener("pointerdown", onPointerDown);
					};
				},
				[anchorRef, open, panelRef, setOpen],
			);
		}

		/** One measured window as a labelled row with a bar. */
		function MeasuredRow(props) {
			var item = props.item;
			var t = tOf(props);
			var tone = toneOfWindow(item);
			return h(
				"div",
				{ className: "dsog-row" },
				h(
					"div",
					{ className: "dsog-row-head" },
					h("span", { className: "dsog-row-label" }, item.label),
					h(
						"span",
						{ className: "dsog-row-figures" },
						h("span", { className: "dsog-row-remaining", "data-tone": tone }, t("remainingPercent", { percent: item.remaining })),
						h("span", { className: "dsog-row-used" }, t("usedPercent", { percent: item.used })),
					),
				),
				h(Bar, {
					fraction: item.remaining / 100,
					tone: tone,
					label: t("barLabel", { label: item.label, percent: item.remaining }),
				}),
				h("div", { className: "dsog-row-foot" }, resetText(item.resetsAt, t)),
			);
		}

		/** One value-only window — a balance — as a labelled row. */
		function ValuedRow(props) {
			var item = props.item;
			var tone = toneOfWindow(item);
			return h(
				"div",
				{ className: "dsog-row" },
				h(
					"div",
					{ className: "dsog-row-head" },
					h("span", { className: "dsog-row-label" }, item.label),
					h(
						"span",
						{ className: "dsog-row-figures" },
						h("span", { className: "dsog-row-value", "data-tone": tone }, item.value === null || item.value === undefined ? "—" : item.value),
					),
				),
				item.hint === null || item.hint === undefined
					? null
					: h("div", { className: "dsog-row-foot" }, item.hint),
			);
		}

		function WindowRow(props) {
			return isMeasured(props.item) ? h(MeasuredRow, props) : h(ValuedRow, props);
		}

		function Panel(props) {
			var t = tOf(props);
			var entry = props.entry;
			var position = props.position;
			var onRefresh = props.onRefresh;
			var onClose = props.onClose;
			var busyPair = useState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];

			var snapshot = entry === null || entry === undefined ? null : entry.snapshot;
			var hero = heroOf(snapshot);
			var rest = restOf(snapshot);
			var heroTone = hero === null ? "unknown" : toneOfWindow(hero);

			var style = { visibility: position === null || position === undefined ? "hidden" : "visible" };
			if (position !== null && position !== undefined) {
				style.left = position.left + "px";
				style.top = position.top + "px";
			}

			var title = snapshot !== null && typeof snapshot.label === "string" ? snapshot.label : props.provider;

			var children = [];
			children.push(
				h(
					"div",
					{ className: "dsog-header", key: "header" },
					h(
						"div",
						{ className: "dsog-header-text" },
						statusDot(heroTone),
						h("span", { className: "dsog-title" }, title),
						badge(t("badgePlan")),
					),
					h(
						"div",
						{ className: "dsog-actions" },
						h(ActionButton, {
							key: "refresh",
							label: t("refresh"),
							icon: IconRefresh,
							onClick: function () {
								if (busy) return;
								setBusy(true);
								Promise.resolve(onRefresh(true)).then(
									function () {
										setBusy(false);
									},
									function () {
										setBusy(false);
									},
								);
							},
						}),
						h(ActionButton, { key: "close", label: t("close"), icon: IconClose, onClick: onClose }),
					),
				),
			);

			if (hero !== null && isMeasured(hero)) {
				children.push(
					h(
						"div",
						{ className: "dsog-hero", key: "hero" },
						h(
							"div",
							{ className: "dsog-hero-ring" },
							h(Ring, { size: 76, stroke: 7, fraction: hero.remaining / 100, tone: heroTone }),
							h("span", { className: "dsog-hero-percent", "data-tone": heroTone }, hero.remaining + "%"),
						),
						h(
							"div",
							{ className: "dsog-hero-text" },
							h("div", { className: "dsog-hero-title" }, hero.label),
							h("div", { className: "dsog-hero-sub" }, t("remainingQuota")),
							h("div", { className: "dsog-hero-meta" }, t("usedPercent", { percent: hero.used })),
							h("div", { className: "dsog-hero-meta dsog-muted" }, resetText(hero.resetsAt, t)),
						),
					),
				);
			} else if (hero !== null) {
				children.push(
					h(
						"div",
						{ className: "dsog-hero", key: "hero" },
						h(
							"div",
							{ className: "dsog-hero-text" },
							h("div", { className: "dsog-hero-sub" }, hero.label),
							h("div", { className: "dsog-hero-value", "data-tone": heroTone }, hero.value === null || hero.value === undefined ? "—" : hero.value),
							hero.hint === null || hero.hint === undefined
								? null
								: h("div", { className: "dsog-hero-meta dsog-muted" }, hero.hint),
						),
					),
				);
			} else if (entry === null || entry === undefined || entry.error === null) {
				children.push(h("div", { className: "dsog-notice", key: "loading" }, t("loading")));
			}

			for (var index = 0; index < rest.length; index++) {
				children.push(h(WindowRow, { key: rest[index].key, item: rest[index], t: props.t }));
			}

			if (entry !== null && entry !== undefined && entry.error !== null) {
				children.push(h("div", { className: "dsog-notice", key: "error", "data-tone": "danger" }, entry.error));
			} else if (entry !== null && entry !== undefined && entry.warning !== null) {
				children.push(h("div", { className: "dsog-notice", key: "warning", "data-tone": "warn" }, entry.warning));
			}

			var fetchedAt = entry === null || entry === undefined ? 0 : entry.fetchedAt;
			children.push(
				h(
					"div",
					{ className: "dsog-footer", key: "footer" },
					h("span", null, fetchedAt > 0 ? t("updatedAt", { time: clockText(fetchedAt) }) : t("neverFetched")),
					h("span", null, snapshot === null ? t("waitingData") : t("autoRefresh", { n: String(POLL_MS / 60000) })),
				),
			);

			// A manual popover: the top layer lifts it out of the composer row's
			// clipping without a portal, and this component keeps owning Escape and
			// outside-pointer dismissal.
			return h(
				"div",
				{
					ref: props.panelRef,
					className: "dsog-panel",
					popover: "manual",
					role: "dialog",
					"aria-label": t("quotaAria", { name: title }),
					style: style,
				},
				children,
			);
		}

		/**
		 * The composer chip. It renders only while the session's active provider is
		 * one this host can measure: an unadapted provider leaves the cell empty
		 * rather than showing another vendor's numbers.
		 */
		function ProviderQuotaChip(props) {
			var t = tOf(props);
			var store = props.directory;
			var load = props.load;
			// Unconditional, so the hook order never depends on what the slot injected.
			var selection = useSelection(store === undefined || store === null ? EMPTY_SELECTION_STORE : store);
			var providerId = providerOf(selection);
			var adapted = useAdaptedProviders();
			var supported = providerId !== null && adapted !== null && adapted.includes(providerId);
			var quota = useProviderQuota(supported ? providerId : null);
			var entry = quota.entry;
			var refresh = quota.refresh;

			var openPair = useState(false);
			var open = openPair[0];
			var setOpen = openPair[1];
			var anchorRef = useRef(null);
			var panelRef = useRef(null);
			var position = useAnchoredPosition({ open: open, anchorRef: anchorRef, panelRef: panelRef, gap: 8, margin: 8 });
			useDismissOnOutsidePointer(anchorRef, open, setOpen, panelRef);

			// Show the popover once it is mounted; unmounting it (open -> false) takes
			// it out of the top layer again, so no hidePopover call is needed.
			useEffect(
				function () {
					if (open !== true) return undefined;
					var node = panelRef.current;
					if (node === null || node === undefined || typeof node.showPopover !== "function") return undefined;
					try {
						if (node.matches(":popover-open") !== true) node.showPopover();
					} catch (error) {
						// An older shell keeps the panel in flow, where the CSS box above
						// still paints it; only the clipping escape is lost.
					}
					return undefined;
				},
				[open],
			);

			// The directory resolves lazily; ask once so `current` becomes populated.
			useEffect(
				function () {
					if (providerId === null && typeof load === "function") load();
				},
				[providerId, load],
			);

			useEffect(
				function () {
					if (!supported) return undefined;
					var timer = window.setInterval(function () {
						refresh(false);
					}, POLL_MS);
					return function () {
						window.clearInterval(timer);
					};
				},
				[supported, refresh],
			);

			// A switch closes the panel: its numbers belong to the previous provider.
			useEffect(
				function () {
					setOpen(false);
				},
				[providerId],
			);

			useEffect(
				function () {
					if (open !== true) return undefined;
					refresh(false);
					function onKeyDown(event) {
						if (event.key === "Escape") setOpen(false);
					}
					document.addEventListener("keydown", onKeyDown);
					return function () {
						document.removeEventListener("keydown", onKeyDown);
					};
				},
				[open, refresh],
			);

			if (!supported) return null;

			var snapshot = entry === null || entry === undefined ? null : entry.snapshot;
			var hero = heroOf(snapshot);
			var measured = isMeasured(hero);
			var tone = hero === null ? "unknown" : toneOfWindow(hero);
			var label = measured ? Math.round(hero.remaining) + "%" : hero !== null && hero.value ? String(hero.value) : "—";
			var name = snapshot === null ? (providerId ?? "") : (snapshot.label ?? providerId);
			var title;
			if (snapshot === null) {
				title = t("chipTitlePending", { name: name });
			} else if (measured) {
				title = t("chipTitleMeasured", {
					name: name,
					window: hero.label,
					remaining: hero.remaining,
					used: hero.used,
					reset: resetText(hero.resetsAt, t),
				});
			} else {
				title = t("chipTitleValued", { name: name, window: hero.label, value: label });
			}

			var indicator = measured
				? h(Ring, { size: 16, stroke: 2.5, fraction: hero.remaining / 100, tone: tone })
				: h(IconWallet, { size: 16 });

			var chip = h(
				"button",
				{
					ref: anchorRef,
					type: "button",
					className: "dsog-chip",
					"data-open": open ? "true" : "false",
					"aria-haspopup": "dialog",
					"aria-expanded": open ? "true" : "false",
					"aria-label": title,
					title: title,
					onClick: function () {
						setOpen(function (prev) {
							return !prev;
						});
					},
				},
				indicator,
				h("span", { className: "dsog-chip-label", "data-tone": tone }, label),
			);

			var panel = open
				? h(Panel, {
						panelRef: panelRef,
						position: position,
						entry: entry,
						provider: providerId,
						onRefresh: refresh,
						onClose: function () {
							setOpen(false);
						},
						t: props.t,
					})
				: null;

			return h(React.Fragment, null, h(StyleSheet, { key: "style" }), chip, panel);
		}

		/**
		 * The fields this card edits, in the order it shows them. Every one is a
		 * `volatile` field of the host's Config: DSH's form for an entry carries
		 * exactly the volatile fields, and it refuses a path edit outside them.
		 *
		 * The first four are percentage cut points, the last two are amounts: only a
		 * value window — a balance — reads the amount pair, and `0` leaves it off.
		 * `label` and `hint` are dictionary keys, so the copy stays in the tables
		 * above.
		 */
		var PAGE_FIELDS = [
			{ path: "warnRemaining", label: "fieldWarn", hint: "fieldWarnHint", min: 0, max: 100 },
			{ path: "dangerRemaining", label: "fieldDanger", hint: "fieldDangerHint", min: 0, max: 100 },
			{ path: "minIntervalMs", label: "fieldInterval", hint: "fieldIntervalHint", min: 1000, max: 3600000 },
			{ path: "timeoutMs", label: "fieldTimeout", hint: "fieldTimeoutHint", min: 1000, max: 300000 },
			{ path: "warnValue", label: "fieldWarnValue", hint: "fieldWarnValueHint", min: 0, max: 1000000000 },
			{ path: "dangerValue", label: "fieldDangerValue", hint: "fieldDangerValueHint", min: 0, max: 1000000000 },
		];

		/** Where a field's value comes from when the card has no form: the host's own
		 * thresholds, keyed by the field they belong to. */
		function fallbackValue(field, limits) {
			if (field.path === "warnRemaining") return limits.warn;
			if (field.path === "dangerRemaining") return limits.danger;
			if (field.path === "warnValue" || field.path === "dangerValue") {
				var value = field.path === "warnValue" ? limits.warnValue : limits.dangerValue;
				return value > 0 ? value : null;
			}
			return null;
		}

		/** One field's draft text, parsed into the value the Host accepts, or why
		 * not — the reason is a dictionary key plus its own parameters. */
		function parseField(field, raw) {
			var text = typeof raw === "string" ? raw.trim() : raw;
			if (text === "" || text === null || text === undefined) return { value: undefined, error: "errRequired", params: null };
			var value = Number(text);
			if (!isFinite(value)) return { value: undefined, error: "errNumber", params: null };
			if (Math.round(value) !== value) return { value: undefined, error: "errInteger", params: null };
			if (value < field.min || value > field.max) {
				return { value: undefined, error: "errRange", params: { min: field.min, max: field.max } };
			}
			return { value: value, error: null, params: null };
		}

		/** The card header's one-liner: the cut points the host last published. */
		function summaryText(limits, t) {
			return (
				t("summary", { warn: limits.warn, danger: limits.danger }) +
				(limits.warnValue > 0 ? t("summaryValue", { value: limits.warnValue }) : t("summaryNoValue"))
			);
		}

		/** Card body ids stay unique across the cards a page may render. */
		var cardSeq = 0;

		/**
		 * The plugin manager's remote face, wired by `apply` when the deployment
		 * composes one. Null means the update row never appears — the card is
		 * otherwise complete, so the dependency stays optional.
		 */
		var updaterFace = null;

		/** The update state before the first check, and the smoke test's seam into it. */
		var IDLE_UPDATE = {
			status: "idle",
			installed: null,
			remote: null,
			sha: null,
			busy: false,
			error: null,
			checkError: null,
			checkUnreadable: false,
			notice: null,
		};
		var updateSeam = null;

		/** One delayed call, when this shell keeps timers at all. */
		function later(callback, delayMs) {
			if (typeof window.setTimeout !== "function") return null;
			return window.setTimeout(callback, delayMs);
		}

		/** One repeated call, on the same terms as `later`. */
		function every(callback, delayMs) {
			if (typeof window.setInterval !== "function") return null;
			return window.setInterval(callback, delayMs);
		}

		/** Listen for one event, when the shell emits events at all. */
		function listen(target, name, handler) {
			if (target === null || target === undefined || typeof target.addEventListener !== "function") return;
			target.addEventListener(name, handler);
		}

		/** The other half of `listen`. */
		function unlisten(target, name, handler) {
			if (target === null || target === undefined || typeof target.removeEventListener !== "function") return;
			target.removeEventListener(name, handler);
		}

		/**
		 * One version check, as the state fields it produces. The installed version
		 * comes from the profile's own bundle list and the published version from
		 * the repository's `package.json`; only a newer release costs the third
		 * read, the commit that makes the install an update.
		 *
		 * A remote face answers `RemoteResult`, so the bundle list is the value
		 * inside the answer. Reading the answer itself is how this check once
		 * decided "installed version unknown" in every deployment and drew no row
		 * at all, and why neither half of the comparison is optional here: a
		 * comparison that cannot be made is an error, never "no update".
		 *
		 * It resolves with the verdict either way — a carrier failure and an
		 * unreadable answer are both `status: "error"` — so the card's effect is
		 * the only place that decides what to do about one.
		 *
		 * @param manager - the plugin manager remote face, or null.
		 * @returns a promise of the fields to merge, or null with no manager.
		 */
		function runUpdateCheck(manager) {
			if (manager === null || manager === undefined) return Promise.resolve(null);
			return Promise.all([
				Promise.resolve(manager.listBundles()).then(remoteResult),
				readGithub("/contents/package.json?ref=" + BRANCH),
			])
				.then(function (results) {
					var installed = installedVersion(results[0]);
					var remote = remoteVersion(results[1]);
					if (installed === null || remote === null) {
						return { status: "error", error: null, unreadable: true };
					}
					if (!isNewer(remote, installed)) {
						return Object.assign(updateDecision(installed, remote, null), { status: "current" });
					}
					return readGithub("/commits/" + BRANCH).then(function (commit) {
						var sha = commit !== null && typeof commit.sha === "string" ? commit.sha : null;
						return updateDecision(installed, remote, sha);
					});
				})
				.catch(function (error) {
					return { status: "error", error: textOf(error), unreadable: false };
				});
		}

		/**
		 * The update check. It reads the installed version from the profile's own
		 * bundle list and the published version from GitHub, and it offers the
		 * install only when the second is newer. Nothing here is a user action: the
		 * card asks on mount, again when the reader comes back to the tab, and on a
		 * slow beat while the tab stays open, so a release shows up on its own.
		 *
		 * Two answers are worth showing, and one is not. A newer release draws the
		 * row; an install that is already up to date draws nothing. An answer
		 * neither side could give — offline, rate limited, a private repository, a
		 * bundle list without a version — draws a muted line in the body instead of
		 * passing for "no update", which is the difference this card got wrong.
		 *
		 * @param manager - the plugin manager remote face, or null.
		 * @returns the state the row renders from, plus `install` and `dismiss`.
		 */
		function useUpdateCheck(manager) {
			var pair = useState(updateSeam === null ? IDLE_UPDATE : updateSeam);
			var state = pair[0];
			var setState = pair[1];
			var retryRef = useRef(null);
			var retriedRef = useRef(false);
			var update = useCallback(function (fields) {
				setState(function (previous) {
					return Object.assign({}, previous, fields);
				});
			}, []);

			/**
			 * A check is starting. The last check's complaint goes; its verdict
			 * stays. Only the first check of a mount has nothing to keep — a
			 * re-check must not blink the row off the card, or a reader clicking
			 * in that window clicks nothing.
			 */
			var begin = useCallback(function () {
				setState(function (previous) {
					var next = Object.assign({}, previous, { checkError: null, checkUnreadable: false });
					if (previous.status === "idle" || previous.status === "checking") next.status = "checking";
					return next;
				});
			}, []);

			/**
			 * One check's verdict. A verdict that could not be reached does not get
			 * to withdraw what the card already knows: a row on screen is a fact,
			 * and this is a check nobody asked for. Its complaint is kept for the
			 * body line instead, and only a card with nothing to show says so in
			 * the open — never in the header.
			 */
			var settle = useCallback(function (next) {
				if (next === null) return;
				setState(function (previous) {
					if (next.status === "error") {
						var kept = Object.assign({}, previous, {
							checkError: next.error,
							checkUnreadable: next.unreadable === true,
						});
						if (previous.status === "available" || previous.status === "updated") return kept;
						return Object.assign(kept, { status: "error" });
					}
					return Object.assign({}, previous, next, { checkError: null, checkUnreadable: false });
				});
			}, []);

			var check = useCallback(
				function () {
					if (manager === null || manager === undefined) return Promise.resolve(null);
					begin();
					return runUpdateCheck(manager).then(function (next) {
						settle(next);
						return next === null ? null : next.status;
					});
				},
				[begin, manager, settle],
			);

			useEffect(
				function () {
					// Only this effect's own attempt is live: a promise that lands
					// after unmount must not arm a timer nothing will ever clear.
					var live = true;
					var stamps = [];
					var last = 0;
					/** Whether the hour's budget has room for one more check. */
					function affordable(now) {
						var recent = 0;
						for (var index = 0; index < stamps.length; index++) {
							if (now - stamps[index] < 3600000) recent += 1;
						}
						return recent < CHECKS_PER_HOUR;
					}
					function run() {
						last = Date.now();
						stamps.push(last);
						return check().then(function (status) {
							if (live !== true) return status;
							// One retry, and only the first time a check comes back
							// empty-handed: after that the tab-visit and interval
							// answers are the cadence. A retry that chained into
							// another retry would be a request a minute for as long as
							// the page stayed open — the wrong way to treat a rate
							// limit. A check that answers re-arms the allowance.
							if (status === "error" && retriedRef.current === false && affordable(Date.now())) {
								retriedRef.current = true;
								retryRef.current = later(function () {
									retryRef.current = null;
									if (live === true) run();
								}, RETRY_MS);
							} else if (status !== "error") {
								retriedRef.current = false;
							}
							return status;
						});
					}
					/** A check nobody asked for: it waits its turn and its budget. */
					function maybe() {
						var now = Date.now();
						if (now - last < RECHECK_MIN_MS) return;
						if (!affordable(now)) return;
						run();
					}
					function onReturn() {
						if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
						maybe();
					}
					run();
					var beat = every(maybe, RECHECK_MS);
					listen(document, "visibilitychange", onReturn);
					listen(window, "focus", onReturn);
					return function () {
						live = false;
						if (beat !== null && typeof window.clearInterval === "function") window.clearInterval(beat);
						if (retryRef.current !== null && typeof window.clearTimeout === "function") {
							window.clearTimeout(retryRef.current);
						}
						retryRef.current = null;
						// A fresh effect gets a fresh allowance.
						retriedRef.current = false;
						unlisten(document, "visibilitychange", onReturn);
						unlisten(window, "focus", onReturn);
					};
				},
				[check],
			);

			var install = useCallback(
				function () {
					if (manager === null || manager === undefined || typeof state.sha !== "string" || state.busy === true) {
						return Promise.resolve(null);
					}
					update({ busy: true, error: null });
					return Promise.resolve(manager.installBundle(installSpecFor(state.sha), { enabled: true })).then(
						function (answer) {
							var failure = updateFailure(answer);
							if (failure !== null) {
								update({ busy: false, error: failure });
								return answer;
							}
							// The result the notice reads is the one inside the answer.
							var result = remoteResult(answer);
							// The client half reloads by itself a moment after the files
							// change, so the notice has to outlive this component.
							var notice = {
								version: state.remote,
								application:
									result !== null && typeof result.application === "string" ? result.application : "applied",
							};
							writeUpdateNotice(notice);
							update({
								busy: false,
								status: "updated",
								sha: null,
								error: null,
								checkError: null,
								checkUnreadable: false,
								notice: notice,
							});
							return answer;
						},
						function (error) {
							update({ busy: false, error: textOf(error) });
							return null;
						},
					);
				},
				[manager, state.busy, state.remote, state.sha, update],
			);

			var dismiss = useCallback(function () {
				clearUpdateNotice();
				update({ notice: null });
			}, [update]);

			return {
				status: state.status,
				installed: state.installed,
				remote: state.remote,
				sha: state.sha,
				busy: state.busy,
				error: state.error,
				checkError: state.checkError === undefined ? null : state.checkError,
				checkUnreadable: state.checkUnreadable === true,
				notice: state.notice === undefined ? null : state.notice,
				install: install,
				dismiss: dismiss,
			};
		}

		/**
		 * The row that appears whenever a newer release exists — open or collapsed.
		 * One line: what is published, which commit carries it, what is installed
		 * here. The button beside it is the only step left, because everything else
		 * about a release already happened on its own.
		 */
		function UpdateRow(props) {
			var t = tOf(props);
			var state = props.state;
			var lines = [
				h(
					"div",
					{ className: "dsog-update-title", key: "title" },
					t("updateAvailable", { version: state.remote }) +
						(state.sha === null ? "" : " → " + state.sha.slice(0, 7)) +
						" · " +
						t("updateInstalled", { version: state.installed }),
				),
			];
			if (state.error !== null) {
				lines.push(
					h(
						"div",
						{ className: "dsog-hint", "data-tone": "danger", key: "error" },
						t("updateFailed", { error: state.error }),
					),
				);
			}
			return h(
				"div",
				{ className: "dsog-update" },
				h("div", { className: "dsog-update-text" }, lines),
				h(
					"button",
					{
						type: "button",
						className: "dsog-page-button",
						disabled: state.busy === true,
						onClick: props.onInstall,
					},
					state.busy === true ? t("updating") : t("update"),
				),
			);
		}

		/** What a finished update leaves behind for the reload it triggers. */
		function UpdateNotice(props) {
			var t = tOf(props);
			return h(
				"div",
				{ className: "dsog-update" },
				h(
					"div",
					{ className: "dsog-update-text" },
					h("div", { className: "dsog-update-title" }, t("updatedTitle", { version: props.notice.version })),
					h(
						"div",
						{ className: "dsog-hint" },
						t(props.notice.application === "restart-required" ? "updateRestart" : "updateApplied"),
					),
				),
				h("button", { type: "button", className: "dsog-page-button", onClick: props.onDismiss }, t("dismiss")),
			);
		}

		/**
		 * The card the Plugins tab renders on this bundle's page. It answers the two
		 * questions the chip cannot: which providers this host can actually measure —
		 * an adapter for a provider the host does not serve is a silent absence — and
		 * the six live fields. The Host supplies `form.state` and `form.mutate` for
		 * those fields because they are volatile; without that form the card stays a
		 * truthful diagnostic instead of a dead form.
		 *
		 * It is a disclosure, like the host's own plugin cards: collapsed by
		 * default, with the live cut points on the header and the body mounted only
		 * while it is open. `defaultOpen` exists for the smoke test, which drives the
		 * fields through a dispatcher rig.
		 */
		function ProviderQuotaSettings(props) {
			var t = tOf(props);
			var view = props.view;
			var form = props.form === undefined ? null : props.form;
			var openPair = useState(props.defaultOpen === true);
			var open = openPair[0];
			var setOpen = openPair[1];
			var bodyIdRef = useRef(null);
			if (bodyIdRef.current === null) {
				cardSeq += 1;
				bodyIdRef.current = "dsog-quota-body-" + cardSeq;
			}
			// The update row rides the card rather than the body: a release is not
			// something to find by expanding a disclosure, and an up-to-date install
			// still shows a card with exactly the sections it always had.
			var update = useUpdateCheck(updaterFace);
			// Two notices live in this card and they are not the same one: this pair
			// is what a finished update left for the automatic reload, and `savePair`
			// below is what a write answers. They once shared a name, and the second
			// declaration silently took the first one's setter — so "dismiss" wrote
			// the save notice and the update notice could not be closed at all.
			var noticePair = useState(readUpdateNotice());
			var storedNotice = noticePair[0];
			var setStoredNotice = noticePair[1];
			// The hook's notice is the one this mount just produced; the stored one is
			// what an earlier page left behind for the reload an update triggers.
			var shownNotice = update.notice !== null ? update.notice : storedNotice;
			function dismissNotice() {
				update.dismiss();
				setStoredNotice(null);
			}
			var updateRow =
				update.status === "available"
					? h(UpdateRow, { key: "update", state: update, onInstall: update.install, t: props.t })
					: shownNotice === null
						? null
						: h(UpdateNotice, { key: "update", notice: shownNotice, onDismiss: dismissNotice, t: props.t });
			var diagPair = useState({ status: "loading", body: null, error: null });
			var diag = diagPair[0];
			var setDiag = diagPair[1];
			var draftPair = useState({});
			var draft = draftPair[0];
			var setDraft = draftPair[1];
			var savePair = useState(null);
			var saveNotice = savePair[0];
			var setSaveNotice = savePair[1];
			var busyPair = useState(false);
			var busy = busyPair[0];
			var setBusy = busyPair[1];
			var diagReadAtRef = useRef(0);

			var readDiagnostics = useCallback(function () {
				diagReadAtRef.current = Date.now();
				setDiag(function (previous) {
					return { status: "loading", body: previous.body, error: null };
				});
				return Promise.resolve(readRoute(PROVIDERS_ROUTE, null)).then(
					function (body) {
						setDiag({ status: "ready", body: body, error: null });
					},
					function (error) {
						setDiag({ status: "error", body: null, error: textOf(error) });
					},
				);
			}, []);

			// The provider list is read on mount and again whenever the reader comes
			// back to the tab: this route is the Host's own, so a refresh costs
			// nothing and the reader never has to ask for one. The gap keeps a reader
			// who flips between windows from watching the rows blink through
			// "reading" on every flip.
			useEffect(
				function () {
					readDiagnostics();
					function onReturn() {
						if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
						if (Date.now() - diagReadAtRef.current < RECHECK_MIN_MS) return;
						readDiagnostics();
					}
					listen(document, "visibilitychange", onReturn);
					listen(window, "focus", onReturn);
					return function () {
						unlisten(document, "visibilitychange", onReturn);
						unlisten(window, "focus", onReturn);
					};
				},
				[readDiagnostics],
			);

			var body = diag.body;
			var limits = thresholdsOf(body === null || body === undefined ? undefined : body.thresholds);
			var listOf = function (name) {
				var value = body !== null && typeof body === "object" ? body[name] : null;
				return Array.isArray(value) ? value : null;
			};
			// What this page will actually draw: the adapters this package has,
			// narrowed by the host to the routes it serves. `matched` is the host's
			// own answer, so an adapter for a provider this host does not route — or
			// a route with no adapter — is not something the reader is asked to
			// reason about; both simply do not name a cell that will ever light up.
			var measured = listOf("matched");
			if (measured === null) measured = listOf("adapted");
			// `state` is documented to be an object; this guard keeps a Host that
			// sends a bare form from taking the whole card down — the card
			// degrades to its read-only diagnostic, as with no form at all.
			var state =
				form !== null && form.state !== null && form.state !== undefined && typeof form.state === "object"
					? form.state
					: null;
			var values =
				state !== null && state.value !== null && state.value !== undefined && typeof state.value === "object" && !Array.isArray(state.value)
					? state.value
					: {};
			var writable = state !== null && state.writable === true && typeof form.mutate === "function";

			if (view === "summary") {
				return h("span", null, summaryText(limits, t));
			}

			var bound = PAGE_FIELDS.map(function (field) {
				// Without a form every field whose value the host publishes still shows
				// it — the cut points ride the discovery answer — rather than a
				// blank box; the timing fields have no such answer and stay empty.
				var fallback = fallbackValue(field, limits);
				var current = values[field.path];
				if ((current === undefined || current === null) && fallback !== null && fallback !== undefined) {
					current = fallback;
				}
				var raw =
					draft[field.path] !== undefined
						? draft[field.path]
						: current === undefined || current === null
							? ""
							: String(current);
				return { field: field, raw: raw, parsed: parseField(field, raw), changed: draft[field.path] !== undefined };
			});

			var effective = {};
			for (var boundIndex = 0; boundIndex < bound.length; boundIndex++) {
				var boundItem = bound[boundIndex];
				effective[boundItem.field.path] =
					boundItem.parsed.error === null ? boundItem.parsed.value : values[boundItem.field.path];
			}

			var saveError = null;
			if (
				typeof effective.warnRemaining === "number" &&
				typeof effective.dangerRemaining === "number" &&
				effective.dangerRemaining > effective.warnRemaining
			) {
				saveError = t("errDangerAboveWarn");
			}
			if (
				saveError === null &&
				typeof effective.warnValue === "number" &&
				typeof effective.dangerValue === "number" &&
				effective.warnValue > 0 &&
				effective.dangerValue > effective.warnValue
			) {
				saveError = t("errValueInverted");
			}
			if (saveError === null) {
				for (var errorIndex = 0; errorIndex < bound.length; errorIndex++) {
					if (bound[errorIndex].changed && bound[errorIndex].parsed.error !== null) {
						saveError = t("errField", {
							field: t(bound[errorIndex].field.label),
							error: t(bound[errorIndex].parsed.error, bound[errorIndex].parsed.params),
						});
						break;
					}
				}
			}

			function write(ops, done) {
				setBusy(true);
				Promise.resolve(form.mutate(ops, state === null ? undefined : state.revision)).then(
					function (accepted) {
						setBusy(false);
						// A refusal keeps what the user typed: only an accepted write
						// may discard the draft, or a stale-revision failure would
						// silently delete the edit that the notice then asks them to
						// retry — the same rule the rejection branch below follows.
						if (accepted !== true) {
							setSaveNotice({ tone: "danger", text: t("writeRefused") });
							return;
						}
						setDraft({});
						setSaveNotice({ tone: "ok", text: done });
						readDiagnostics();
					},
					function (error) {
						setBusy(false);
						setSaveNotice({ tone: "danger", text: textOf(error) });
					},
				);
			}

			function save() {
				if (!writable || saveError !== null) {
					if (saveError !== null) setSaveNotice({ tone: "danger", text: saveError });
					return;
				}
				var ops = [];
				for (var index = 0; index < bound.length; index++) {
					var item = bound[index];
					if (!item.changed || item.parsed.error !== null) continue;
					if (item.parsed.value === values[item.field.path]) continue;
					ops.push({ op: "set", path: [item.field.path], value: item.parsed.value });
				}
				if (ops.length === 0) {
					setSaveNotice({ tone: "muted", text: t("noChanges") });
					return;
				}
				write(ops, t("saved"));
			}

			function restoreDefaults() {
				if (!writable) return;
				write(
					PAGE_FIELDS.map(function (field) {
						return { op: "unset", path: [field.path] };
					}),
					t("restored"),
				);
			}

			function fieldRow(item) {
				var field = item.field;
				var invalid = item.changed && item.parsed.error !== null;
				return h(
					"label",
					{ className: "dsog-field", key: field.path },
					h(
						"span",
						{ className: "dsog-field-text" },
						h("span", { className: "dsog-field-name" }, t(field.label)),
						h(
							"span",
							{ className: "dsog-hint", "data-tone": invalid ? "danger" : undefined },
							invalid ? t(item.parsed.error, item.parsed.params) : t(field.hint),
						),
					),
					h("input", {
						className: "dsog-input",
						type: "number",
						inputMode: "numeric",
						step: "1",
						min: String(field.min),
						max: String(field.max),
						value: item.raw,
						"aria-invalid": invalid ? "true" : "false",
						disabled: !writable || busy,
						onChange: function (event) {
							var next = event.target.value;
							setDraft(function (previous) {
								var copy = Object.assign({}, previous);
								copy[field.path] = next;
								return copy;
							});
							setSaveNotice(null);
						},
					}),
				);
			}

			// One list answers what this card exists for: the providers whose quota
			// this page will draw. Anything else — an adapter with no route here, a
			// route no adapter covers — names a cell that stays empty, and asking the
			// reader to hold that in their head is the whole cost of showing it.
			var measuredList =
				measured === null
					? h("span", { className: "dsog-hint" }, diag.status === "error" ? t("readFailed") : t("reading"))
					: measured.length === 0
						? h("span", { className: "dsog-hint" }, t("none"))
						: h(
								"span",
								{ className: "dsog-diag-list" },
								measured.map(function (id) {
									return h("span", { className: "dsog-pill", key: id }, id);
								}),
							);

			// A blocking reason outranks the last notice: a disabled 保存 button has to
			// say why it is disabled instead of waiting for a click it refuses.
			var shown = saveError !== null ? { tone: "danger", text: saveError } : saveNotice;

			// The one thing a row cannot say: the check could not answer at all. It
			// belongs to the body — the page is otherwise fine, and the retry is
			// already scheduled — but it is said, because "no row" is how a broken
			// check once passed for an up-to-date install.
			var checkLine =
				update.checkError !== null || update.checkUnreadable === true
					? h(
							"div",
							{ className: "dsog-hint", key: "check" },
							update.checkUnreadable === true
								? t("checkUnreadable")
								: t("checkFailed", { error: update.checkError === null ? "" : update.checkError }),
						)
					: null;

			var bodyNode = h(
				"div",
				{ className: "dsog-card-body", id: bodyIdRef.current, key: "body" },
				checkLine,
				// No control here on purpose: this list is read on mount and again
				// whenever the reader comes back to the tab, so a button would only ask
				// for something that already happened.
				h(
					"div",
					{ className: "dsog-page-section", key: "diagnostics" },
					h("div", { className: "dsog-page-title" }, t("sectionProviders")),
					measuredList,
					diag.status === "error"
						? h("div", { className: "dsog-hint", "data-tone": "danger" }, t("readFailedDetail", { error: diag.error }))
						: null,
				),
				h(
					"div",
					{ className: "dsog-page-section", key: "fields" },
					h("div", { className: "dsog-page-title" }, t("sectionFields")),
					bound.map(fieldRow),
					h(
						"div",
						{ className: "dsog-page-actions" },
						h(
							"button",
							{
								type: "button",
								className: "dsog-page-button",
								disabled: !writable || busy || saveError !== null,
								onClick: save,
							},
							busy ? t("saving") : t("save"),
						),
						h(
							"button",
							{ type: "button", className: "dsog-page-button", disabled: !writable || busy, onClick: restoreDefaults },
							t("restore"),
						),
						shown === null
							? null
							: h(
									"span",
									{ className: "dsog-hint", "data-tone": shown.tone === "danger" ? "danger" : undefined },
									shown.text,
								),
					),
					state === null ? h("div", { className: "dsog-hint" }, t("noForm")) : null,
				),
			);

			return h(
				"li",
				{
					className: "dsog-card",
					"data-open": open ? "true" : "false",
					"data-plugin-key": "dsh-provider-quota",
				},
				h(StyleSheet, { key: "style" }),
				h(
					"button",
					{
						key: "head",
						type: "button",
						className: "dsog-card-head",
						"aria-expanded": open ? "true" : "false",
						"aria-controls": bodyIdRef.current,
						"aria-label": t(open ? "collapse" : "expand") + ": " + t("cardTitle"),
						onClick: function () {
							setOpen(!open);
						},
					},
					h(
						"span",
						{ className: "dsog-card-text" },
						h("span", { className: "dsog-card-title" }, t("cardTitle")),
						h("span", { className: "dsog-card-desc" }, t("cardDescription")),
					),
					h(
						"span",
						{ className: "dsog-card-meta" },
						h("span", { className: "dsog-pill" }, summaryText(limits, t)),
						h(IconChevron, { size: 16 }),
					),
				),
				// Between the header and the body on purpose: the row is on screen
				// whether the card is open or not, and the reader who never expands
				// the card is the one this row is for.
				updateRow,
				open ? bodyNode : null,
			);
		}

		/**
		 * The bundle-config seat renders the card, but the form behind the fields is
		 * ours to supply. `configForms` is the settings mirror's entry form — the
		 * very object a row page would be handed — so subscribing to it keeps every
		 * value live across a save, and a write still leaves as
		 * `form.mutate(operations, expectedRevision)`.
		 * @param form - the entry's form from the `configForms` service.
		 * @returns the component to register for the bundle's configuration seat.
		 */
		function bundleConfigOf(form) {
			return function QuotaBundleConfig(props) {
				// Both callbacks call the form's methods ON the form: `subscribe` and
				// `getSnapshot` read `this.store` internally, so a detached method
				// throws on the first render — and the slot system answers a throwing
				// entry by abdicating it, which leaves the page silently empty.
				var state = useSyncExternalStore(
					function (listener) {
						return form.subscribe(listener);
					},
					function () {
						return form.getSnapshot();
					},
				);
				return h(ProviderQuotaSettings, {
					view: props.view,
					defaultOpen: props.defaultOpen,
					t: props.t,
					form: {
						state: state,
						mutate: function (operations, revision) {
							return form.mutate(operations, revision);
						},
					},
				});
			};
		}

		async function apply(ctx) {
			// The dictionaries first: the slot kit resolves `t` from the namespace a
			// registration declares, and the entries below declare it.
			ctx.effect(
				function () {
					return ctx.locale.register(NS, DICTS);
				},
				"provider quota dictionaries",
			);

			// The update row's one dependency: the plugin manager's remote face. It is
			// optional — a deployment without the manager loses the row and nothing
			// else — and `ctx.inject` is what keeps this plugin active when the face
			// is absent. Installing is the manager's job, never ours: this only names
			// the spec, and the spec carries the commit that makes it an update.
			ctx.inject(["remote.pluginManager"], function (scope) {
				var remote = scope.remote === null || scope.remote === undefined ? null : scope.remote.pluginManager;
				if (remote === null || remote === undefined) return;
				updaterFace = {
					listBundles: function () {
						return remote.listBundles();
					},
					installBundle: function (spec, options) {
						return remote.installBundle(spec, options);
					},
				};
				scope.effect(
					function () {
						return function () {
							updaterFace = null;
						};
					},
					"provider quota updater",
				);
			});

			// The model-selection service is the only source of "which provider is
			// this session on", so the cell is registered under the same wait.
			ctx.inject(["slots", "modelDirectories"], function (scope) {
				var models = scope.modelDirectories;
				scope.effect(
					function () {
						return scope.slots.inject("conversation.input.right", function () {
							return scope.slots.register(
								{
									name: "conversation.input.right",
									id: "provider-quota",
									order: 10,
									locale: NS,
									inject: function (sessionId) {
										var directory = models.directoryFor(sessionId);
										return {
											directory: directory.store,
											load: function () {
												Promise.resolve(directory.load()).catch(function () {});
											},
										};
									},
								},
								ProviderQuotaChip,
							);
						});
					},
					"provider quota chip",
				);
			});

			// The card on the Plugins tab: keyed by the package name, which is what
			// puts the configuration on the bundle's own page between its description
			// and its rows — no row page, no arrow to click. That seat carries no form
			// of its own (a bundle-wide page may hold several entries, so there is no
			// single one to hand over), so the form is obtained here from the settings
			// mirror and subscribed to, which keeps the field values live across a
			// save. `whileServed` keeps the registration alive exactly while the Host
			// serves this namespace, so a profile without this plugin's host half
			// shows no trace of its page.
			ctx.inject(["slots", "configForms"], function (scope) {
				var form = scope.configForms.get(NS);
				scope.effect(
					function () {
						return scope.configForms.whileServed([NS], function () {
							return scope.slots.inject("plugins.bundle.config", function () {
								return scope.slots.register(
									{ name: "plugins.bundle.config", key: "dsh-provider-quota", locale: NS },
									bundleConfigOf(form),
								);
							});
						});
					},
					"provider quota settings page",
				);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		// Exposed for this package's own smoke test: the panel only exists while
		// the chip is open, and the chip states are unreachable without a live
		// session, so this is the only way to render them under test.
		exports.__internal = {
			Bar: Bar,
			bundleConfigOf: bundleConfigOf,
			MeasuredRow: MeasuredRow,
			Panel: Panel,
			ProviderQuotaChip: ProviderQuotaChip,
			ProviderQuotaSettings: ProviderQuotaSettings,
			Ring: Ring,
			UpdateNotice: UpdateNotice,
			UpdateRow: UpdateRow,
			ValuedRow: ValuedRow,
			WindowRow: WindowRow,
			decodeBase64: decodeBase64,
			fallbackValue: fallbackValue,
			heroOf: heroOf,
			installSpecFor: installSpecFor,
			installedVersion: installedVersion,
			isMeasured: isMeasured,
			isNewer: isNewer,
			parseField: parseField,
			PAGE_FIELDS: PAGE_FIELDS,
			providerOf: providerOf,
			remoteErrorText: remoteErrorText,
			remoteResult: remoteResult,
			remoteVersion: remoteVersion,
			resetText: resetText,
			restOf: restOf,
			routePaths: routePaths,
			runUpdateCheck: runUpdateCheck,
			thresholdsOf: thresholdsOf,
			toneOfWindow: toneOfWindow,
			updateDecision: updateDecision,
			updateFailure: updateFailure,
			DICTS: DICTS,
			NS: NS,
			REPO: REPO,
			tOf: tOf,
			// Seams for the smoke test: the adapted list and the per-provider
			// snapshots are fetched inside effects, which no server render runs, and
			// the update check is one more such effect.
			__primeAdapted: function (ids) {
				adaptedCache.ids = ids;
			},
			__primeSnapshot: function (providerId, entry) {
				snapshotCache[providerId] = entry;
			},
			__primeUpdate: function (state) {
				updateSeam = state;
			},
		};
		return module.exports;
	},
});
