/**
 * OpenCode Go — a subscription with three rolling dollar windows.
 *
 * Go documents no usage endpoint: the docs point at the console, and both
 * requests for a programmatic surface are still open upstream
 * (anomalyco/opencode#16017 and #31084). The console reads its own windows from
 * this endpoint, and it answers a Go API key directly — no console session and
 * no `x-opencode-session` header. Limits are per-model monthly dollar caps, of
 * which the 5-hour window is 20% and the week 50%; the endpoint reports the
 * aggregate percentage already, so nothing is recomputed here.
 */
import { percentWindow } from './shared.js';

/** Provider ids this adapter answers for, as the host's `llm` registry names them. */
export const ids = ['opencode-go'];

/** Shown in the panel header while this provider is active. */
export const label = 'OpenCode Go';

/** The credential record (or environment variable) holding the API key. */
export const credential = 'OPENCODE_GO_API_KEY';

const ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';

const WINDOWS = [
	{ key: 'rolling', label: '5 小时窗口' },
	{ key: 'weekly', label: '本周' },
	{ key: 'monthly', label: '本月' },
];

/**
 * @param io - host-supplied credential resolver and JSON transport.
 * @returns the provider's windows, largest horizon last.
 */
export async function read(io) {
	const key = await io.credential(credential);
	const body = await io.json(ENDPOINT, { authorization: `Bearer ${key}` });
	const usage = body !== null && typeof body === 'object' ? body.usage : null;
	if (usage === null || usage === undefined || typeof usage !== 'object') {
		throw new Error('OpenCode Go 用量接口的响应缺少 usage 字段');
	}
	const windows = [];
	for (const window of WINDOWS) {
		const raw = usage[window.key];
		if (raw === null || raw === undefined || typeof raw !== 'object') continue;
		windows.push(percentWindow(window.key, window.label, raw));
	}
	if (windows.length === 0) throw new Error('OpenCode Go 用量接口没有返回任何窗口');
	return { label, primary: windows[0].key, windows };
}
