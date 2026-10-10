/**
 * Shapes every adapter builds, so the client half never learns which upstream
 * an adapter reads. A window is either **measured** (`used`/`remaining`, drawn
 * as a meter) or **valued** (`value` + `valueNumber`, drawn as text) — that is
 * what lets a windowed subscription and a pay-as-you-go balance share one panel.
 *
 * `valueNumber` is the numeric amount behind `value`, and it is what a balance
 * warning is compared against: the host decides a window's tone from it, so the
 * UI never has to parse a formatted amount. An adapter that can only produce the
 * text may pass null, and that window simply carries no tone.
 */

/** A finite number, or null. */
export function numberOrNull(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A decimal string (or number) from an upstream, as a finite number or null. */
export function amountOrNull(value) {
	if (typeof value === 'number') return numberOrNull(value);
	if (typeof value !== 'string' || value.trim() === '') return null;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One amount as display text, currency excluded — the adapter prefixes that.
 *
 * Two decimals, rounded: an upstream's full precision (`-0.0047610200000000`)
 * has no business in a UI. A sub-cent amount rounds to `0.00`, which is what a
 * currency display should show; the sign and the magnitude survive in
 * `valueNumber`, and that — not this text — is what a balance warning compares.
 * @param value - the amount, as a number or an upstream's decimal string.
 * @returns the text to show, or '—' when there is no amount.
 */
export function formatAmount(value) {
	const amount = amountOrNull(value);
	if (amount === null) return '—';
	return (Math.round(amount * 100) / 100).toFixed(2);
}

/**
 * One percentage window. `percent` is quota **used**, so remaining is its
 * complement; the client draws the meter by remaining.
 * @param key - stable window key.
 * @param label - human label, owned by the adapter.
 * @param raw - the adapter's own payload for this window.
 * @returns a normalised window.
 */
export function percentWindow(key, label, raw) {
	const percent = numberOrNull(raw === null || raw === undefined ? undefined : raw.percent);
	const status = raw !== null && raw !== undefined && typeof raw.status === 'string' ? raw.status : null;
	return {
		key,
		label,
		used: percent === null ? null : Math.round(percent * 10) / 10,
		remaining: percent === null ? null : Math.round((100 - percent) * 10) / 10,
		resetsAt: raw !== null && raw !== undefined && typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
		value: null,
		valueNumber: null,
		hint: status !== null && status !== 'ok' ? status : null,
	};
}

/**
 * One value-only window: a balance, which has no percentage and no reset.
 * @param key - stable window key.
 * @param label - human label, owned by the adapter.
 * @param value - the already-formatted amount, currency included.
 * @param hint - optional note, e.g. an unavailable balance.
 * @param valueNumber - the amount behind the text, for the host's balance
 *   warning; null when the adapter has no number to give.
 * @returns a normalised window.
 */
export function valueWindow(key, label, value, hint = null, valueNumber = null) {
	return { key, label, used: null, remaining: null, resetsAt: null, value, valueNumber: amountOrNull(valueNumber), hint };
}
