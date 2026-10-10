/**
 * DeepSeek **API**（开放平台）— the pay-as-you-go balance behind an API key.
 *
 * This is one of two independent DeepSeek systems, and the split is DSH's own:
 * `dsh-llm-deepseek-api-key` registers the provider id `deepseek-official` and
 * authenticates with an API key, while `dsh-llm-deepseek-account` registers
 * `deepseek-account` and authenticates with the stored login grant. They bill
 * different wallets, so this adapter reads only the API-key one
 * (`api.deepseek.com/user/balance`) and never the account service.
 *
 * It has no windows, no percentages and no reset times, just an amount, so it
 * maps to value-only windows — the case the client's meter path cannot express
 * and its text path can.
 */
import { formatAmount, valueWindow } from './shared.js';

/**
 * Provider ids this adapter answers for, as the host's `llm` registry names
 * them. `deepseek-official` is the API-key provider this balance endpoint
 * belongs to; `deepseek` is kept as a tolerant alias for a composition that
 * names the same vendor without the suffix. `deepseek-account` is deliberately
 * absent: it is a different system with a different credential, and
 * `deepseek-account.js` serves it.
 */
export const ids = ['deepseek-official', 'deepseek'];

/**
 * Shown in the panel header while this provider is active. Named for the
 * credential it spends, so it can never be mistaken for the account provider's
 * panel.
 */
export const label = 'DeepSeek API';

/** The credential record (or environment variable) holding the API key. */
export const credential = 'DEEPSEEK_API_KEY';

const ENDPOINT = 'https://api.deepseek.com/user/balance';

/**
 * @param io - host-supplied credential resolver and JSON transport.
 * @returns one value window per currency the account reports.
 */
export async function read(io) {
	const key = await io.credential(credential);
	const body = await io.json(ENDPOINT, { authorization: `Bearer ${key}` });
	const infos =
		body !== null && typeof body === 'object' && Array.isArray(body.balance_infos) ? body.balance_infos : [];
	if (infos.length === 0) throw new Error('DeepSeek 余额接口没有返回余额信息');
		const available = body.is_available !== false;
	const windows = infos.map((info, index) => {
		const record = info !== null && typeof info === 'object' ? info : {};
		const currency = typeof record.currency === 'string' ? record.currency : '';
		const text = (currency.length > 0 ? currency + ' ' : '') + formatAmount(record.total_balance);
		const name = currency.length > 0 ? currency : String(index + 1);
		return valueWindow(
			'balance-' + index,
			infos.length > 1 ? '账户余额（' + name + '）' : '账户余额',
			text,
			index === 0 && !available ? '不可用' : null,
			record.total_balance,
		);
	});
	return { label, primary: windows[0].key, windows };
}
