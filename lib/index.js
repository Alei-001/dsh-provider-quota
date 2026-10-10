/**
 * Host half of the provider quota plugin.
 *
 * The host owns the adapters and the credentials; the browser half only states
 * which provider is active and draws what comes back. Two same-origin routes
 * carry that:
 *
 *   GET <providersPath>            which providers this host can measure, and
 *                                  which of those the live `llm` registry
 *                                  actually serves.
 *   GET <usagePath>?provider=<id>  one normalised snapshot for one provider.
 *
 * No credential material crosses either route. An unadapted provider answers
 * `unsupported` rather than an error, because "this host cannot measure that
 * vendor" is an ordinary answer the client renders as nothing at all.
 */
import z from '@deepseek-ai/schemastery';
import { adaptedIds, findAdapter } from './providers/index.js';

const DEFAULT_USAGE_ROUTE = '/dsh-provider-quota/usage';
const DEFAULT_PROVIDERS_ROUTE = '/dsh-provider-quota/providers';

export const name = 'provider-quota';

/** The Host service this half needs: the carrier that serves the browser. */
export const inject = ['webServer'];

export const Config = z.object({
	/** Snapshot route, addressed with `?provider=<id>`. */
	routePath: z.string().default(DEFAULT_USAGE_ROUTE),
	/** Discovery route: which providers this host can measure. */
	providersPath: z.string().default(DEFAULT_PROVIDERS_ROUTE),
	/**
	 * Reads closer together than this reuse the snapshot instead of the upstream.
	 * The fields below are declared `volatile`, which is what makes them appear in
	 * DSH's form for this entry: the plugin's own page on the Plugins tab reads and
	 * writes exactly the volatile fields, and an accepted edit lands in the
	 * profile's patch without remounting this half.
	 */
	minIntervalMs: z.number().default(15000).volatile(),
	timeoutMs: z.number().default(10000).volatile(),
	/** Remaining percentage at or below which a window reads as a warning. */
	warnRemaining: z.number().default(30).volatile(),
	/** Remaining percentage at or below which a window reads as a danger. */
	dangerRemaining: z.number().default(10).volatile(),
	/**
	 * Balance at or below which a value window reads as a warning, and the danger
	 * cut point below that. `0` disables both, because a non-positive balance is
	 * ordinary: an amount window then draws without a tone rather than in a colour
	 * no one asked for. Only the amount is compared — the currency stays in the
	 * label, since a threshold in one currency says nothing about another.
	 */
	warnValue: z.number().default(0).volatile(),
	dangerValue: z.number().default(0).volatile(),
	/**
	 * `x-client-version` for account-backed reads: the calling build's version.
	 * The Platform uses it for telemetry, not authorization, but it must be a
	 * plausible build string.
	 */
	accountClientVersion: z.string().default('0.1.0'),
	/** `x-client-locale` source; the Platform helper reduces it to `zh_CN`/`en_US`. */
	accountClientLocale: z.string().default('zh-CN'),
});

/** One JSON response. `no-store` because every reader is a live meter. */
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(text),
	});
	res.end(text);
}

function methodOf(req) {
	return typeof req.method === 'string' ? req.method : 'GET';
}

export function apply(ctx, config) {
	/** One entry per provider: the last good snapshot, when it was taken, and any read in flight. */
	const cache = new Map();

	/**
	 * One live number out of the config. DSH resolves a `volatile` field to a
	 * cosmokit reference (`{ get() }`) instead of to the value itself — that is
	 * what lets an accepted edit reach this half without remounting it — while an
	 * ordinary field arrives as the value already. Reading through one helper
	 * keeps both shapes working, and keeps a hand-written config (this package's
	 * own tests pass a resolved object) on the same path.
	 */
	const live = (value, fallback) => {
		const raw = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
		return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
	};

	/** One percentage cut point, clamped to 0–100 with the shipped default. */
	const percent = (value, fallback) =>
		typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;

	/**
	 * The tone cut points the browser draws with, sent with every answer because
	 * they are editable from the plugin's own page. `warn` is the first cut point
	 * and `danger` the second; an inverted pair is repaired instead of rejected,
	 * because a live form can hold either order for one keystroke. `warnValue` and
	 * `dangerValue` are amounts and `0` means disabled, so an account balance with
	 * no configured warning draws without a tone rather than an arbitrary one.
	 */
	const thresholds = () => {
		const warn = percent(live(config.warnRemaining, 30), 30);
		const warnValue = Math.max(0, live(config.warnValue, 0));
		return {
			warn,
			danger: Math.min(percent(live(config.dangerRemaining, 10), 10), warn),
			warnValue,
			dangerValue: warnValue <= 0 ? 0 : Math.min(Math.max(0, live(config.dangerValue, 0)), warnValue),
		};
	};

	/**
	 * One window's tone, decided here rather than in the browser. The two cut
	 * points are self-contained by design: a percentage answer never reaches for a
	 * balance threshold and an amount answer never reaches for a percentage, so
	 * the thresholds never mix currencies or dimensions.
	 */
	const windowTone = (window) => {
		if (window === null || window === undefined) return 'unknown';
		if (typeof window.remaining === 'number' && Number.isFinite(window.remaining)) {
			const limits = thresholds();
			if (window.remaining <= limits.danger) return 'danger';
			if (window.remaining <= limits.warn) return 'warn';
			return 'ok';
		}
		if (typeof window.valueNumber === 'number' && Number.isFinite(window.valueNumber)) {
			const limits = thresholds();
			if (limits.warnValue <= 0) return 'unknown';
			if (window.valueNumber <= limits.dangerValue) return 'danger';
			if (window.valueNumber <= limits.warnValue) return 'warn';
			return 'ok';
		}
		return 'unknown';
	};

	/** The upstream deadline in force right now. */
	const deadlineMs = () => live(config.timeoutMs, 10000);

	/** The shortest gap between two upstream reads. */
	const minInterval = () => live(config.minIntervalMs, 15000);

	const logger = ctx.logger;
	const log = (level, message) => {
		const sink = logger?.[level];
		if (typeof sink === 'function') sink.call(logger, `[provider-quota] ${message}`);
	};

	/**
	 * `credentialRef` only brands and validates its argument, and the record key
	 * is that same string. It is imported lazily so a composition without the
	 * credentials package still reaches the environment fallback.
	 */
	let brandRef;
	const toRef = async (value) => {
		if (brandRef === undefined) {
			try {
				const mod = await import('@deepseek-ai/dsh-credentials');
				brandRef = typeof mod.credentialRef === 'function' ? mod.credentialRef : null;
			} catch {
				brandRef = null;
			}
		}
		if (brandRef === null) return value;
		try {
			return brandRef(value);
		} catch {
			return value;
		}
	};

	/** One credential, from the store first and the environment second. */
	async function credential(name) {
		const credentials = ctx.get('credentials');
		if (credentials !== undefined && typeof credentials.resolve === 'function') {
			try {
				const resolved = await credentials.resolve(await toRef(name));
				const value = resolved !== null && typeof resolved === 'object' ? resolved.value : resolved;
				if (typeof value === 'string' && value.length > 0) return value;
			} catch {
				// A missing or unreadable record falls through to the environment.
			}
		}
		const fromEnv = process.env[name];
		if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
		throw new Error(`未配置凭据 ${name}：请在 DSH 凭据中为该名称设置记录，或设置同名环境变量`);
	}

	/** One upstream read as JSON, carrying the deadline and the error surface adapters rely on. */
	async function json(url, headers) {
		const controller = new AbortController();
		const limit = deadlineMs();
		const timer = setTimeout(() => controller.abort(), limit);
		try {
			const response = await fetch(url, {
				headers: {
					accept: 'application/json',
					'user-agent': 'dsh-provider-quota/0.1.0',
					...(headers ?? {}),
				},
				signal: controller.signal,
			});
			if (!response.ok) {
				let detail = '';
				try {
					const body = await response.json();
					detail = body?.error?.message ?? '';
				} catch {
					// A non-JSON error body carries no extra detail worth reporting.
				}
				const suffix = typeof detail === 'string' && detail.length > 0 ? ` ${detail}` : '';
				throw new Error(`上游返回 ${response.status}${suffix}`);
			}
			return await response.json();
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error(`上游在 ${limit}ms 内没有响应`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * A host service by name, so an adapter can read a service instead of an
	 * endpoint. The account-backed DeepSeek provider needs no API key and no
	 * URL: its credential is the stored login grant, which only the
	 * `deepseekAccount` service can use.
	 */
	const service = (name) => ctx.get(name);

	/**
	 * The calling build's client identity. The Platform's account reads require
	 * it for their request headers, and it is the one piece of context an adapter
	 * cannot derive on its own.
	 */
	const accountClient = () => ({
		version: config.accountClientVersion,
		locale: config.accountClientLocale,
		timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
	});

	const io = { credential, json, service, accountClient };

	/**
	 * The stored snapshot as an answer, with every tone re-derived now. The cache
	 * holds only what an adapter returned: the cut points are live config, so a
	 * reused snapshot is re-toned rather than remembered — otherwise a threshold
	 * edit would wait for the read window to elapse.
	 */
	const answered = (snapshot) => ({
		ok: true,
		...snapshot,
		windows: Array.isArray(snapshot.windows)
			? snapshot.windows.map((window) =>
					window === null || window === undefined ? window : { ...window, tone: windowTone(window) },
				)
			: snapshot.windows,
		thresholds: thresholds(),
	});

	/** One provider's snapshot, reusing the cache and de-duplicating concurrent reads. */
	async function snapshotFor(providerId, adapter, force) {
		const entry = cache.get(providerId) ?? { snapshot: null, at: 0, pending: null };
		cache.set(providerId, entry);
		if (force !== true && entry.snapshot !== null && Date.now() - entry.at < minInterval()) {
			return { ...answered(entry.snapshot), fetchedAt: entry.at, cached: true };
		}
		if (entry.pending !== null) return entry.pending;
		entry.pending = (async () => {
			try {
				const read = await adapter.read(io);
				const snapshot = {
					provider: providerId,
					label: typeof read.label === 'string' ? read.label : providerId,
					primary: typeof read.primary === 'string' ? read.primary : null,
					windows: Array.isArray(read.windows) ? read.windows : [],
				};
				entry.snapshot = snapshot;
				entry.at = Date.now();
				return { ...answered(snapshot), fetchedAt: entry.at, cached: false };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// A good snapshot outlives a failed refresh: blanks are worse than stale numbers.
				if (entry.snapshot !== null) {
					return {
						...answered(entry.snapshot),
						fetchedAt: entry.at,
						cached: true,
						warning: message,
					};
				}
				return { ok: false, provider: providerId, error: message };
			} finally {
				entry.pending = null;
			}
		})();
		return entry.pending;
	}

	/** Provider ids the host's own `llm` registry serves, or null when unavailable. */
	async function liveProviderIds() {
		const llm = ctx.get('llm');
		if (llm === undefined || typeof llm.listProviders !== 'function') return null;
		try {
			const list = await llm.listProviders();
			if (!Array.isArray(list)) return null;
			const ids = [];
			for (const entry of list) {
				const id =
					entry !== null && typeof entry === 'object' ? entry.provider ?? entry.id ?? entry.name : entry;
				if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
			}
			return ids;
		} catch {
			return null;
		}
	}

	async function providersHandler(req, res) {
		if (methodOf(req) !== 'GET' && methodOf(req) !== 'HEAD') {
			sendJson(res, 405, { ok: false, error: 'method not allowed' });
			return;
		}
		const adapted = adaptedIds();
		const available = await liveProviderIds();
		// `matched` is what the client gates on: an adapter for a provider this
		// host does not serve can never produce a number, so it is not offered.
		const matched = available === null ? adapted : adapted.filter((id) => available.includes(id));
		if (methodOf(req) === 'HEAD') {
			res.writeHead(200, { 'cache-control': 'no-store' });
			res.end();
			return;
		}
		sendJson(res, 200, { ok: true, adapted, available, matched, thresholds: thresholds() });
	}

	async function usageHandler(req, res) {
		if (methodOf(req) !== 'GET' && methodOf(req) !== 'HEAD') {
			sendJson(res, 405, { ok: false, error: 'method not allowed' });
			return;
		}
		let url;
		try {
			url = new URL(req.url ?? '/', 'http://localhost');
		} catch {
			sendJson(res, 400, { ok: false, error: 'bad request url' });
			return;
		}
		const providerId = url.searchParams.get('provider');
		if (providerId === null || providerId.length === 0) {
			sendJson(res, 400, { ok: false, error: 'missing provider' });
			return;
		}
		const adapter = findAdapter(providerId);
		if (adapter === undefined) {
			// An ordinary answer, not a failure: the client shows no meter for it.
			sendJson(res, 200, { ok: false, unsupported: true, provider: providerId });
			return;
		}
		try {
			const payload = await snapshotFor(providerId, adapter, url.searchParams.get('force') === '1');
			if (methodOf(req) === 'HEAD') {
				res.writeHead(200, { 'cache-control': 'no-store' });
				res.end();
				return;
			}
			sendJson(res, 200, payload);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log('warn', `usage snapshot for ${providerId} failed: ${message}`);
			sendJson(res, 200, { ok: false, provider: providerId, error: message });
		}
	}

	ctx.effect(
		() => ctx.webServer.register({ kind: 'exact', path: config.providersPath, handler: providersHandler }),
		'provider quota discovery route',
	);
	ctx.effect(
		() => ctx.webServer.register({ kind: 'exact', path: config.routePath, handler: usageHandler }),
		'provider quota usage route',
	);

	const adapted = adaptedIds();
	const limits = thresholds();
	log(
		'info',
		`adapters: ${adapted.join(', ')} — usage on ${config.routePath}, discovery on ${config.providersPath}, ` +
			`warn at ≤${limits.warn}% remaining, danger at ≤${limits.danger}%` +
			(limits.warnValue > 0 ? `, balance warn at ≤${limits.warnValue}` : ', balance warnings off'),
	);
	// An adapter for a provider this host does not serve can never display
	// anything. Saying so at startup is the difference between a silent absence
	// and a one-line fix in the adapter's `ids`.
	void liveProviderIds().then((available) => {
		if (available === null) {
			log('info', 'the llm registry is unavailable, so adapted ids cannot be checked against it');
			return;
		}
		const unserved = adapted.filter((id) => !available.includes(id));
		if (unserved.length > 0) {
			log('warn', `adapted ids not served by this host, so they will never show: ${unserved.join(', ')}`);
		}
	});
}
