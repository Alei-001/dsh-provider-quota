/**
 * DeepSeek **账号** — the account-backed DeepSeek provider.
 *
 * The other half of a split DSH makes itself: `dsh-llm-deepseek-api-key`
 * registers `deepseek-official` (an API key billing the 开放平台 balance) and
 * `dsh-llm-deepseek-account` registers `deepseek-account` (a stored login
 * grant). They are independent systems spending independent wallets, so this
 * adapter never touches the API-key path: no endpoint, no `DEEPSEEK_API_KEY`,
 * and `credential` below is explicitly null.
 *
 * The amounts come from the host's own `deepseekAccount` service. Its
 * `getState()` reports only whether a grant is stored. The balances come from
 * `getBalance(client)`, which needs the calling build's client identity
 * (version, UI locale, timezone offset) for the Platform's request headers;
 * deployment headers belong to the platform plugin and are merged in there.
 *
 * A wallet is `{ currency, balance }` with the amount as a decimal string, so
 * every window here is a *value*, never a percentage: an account has no quota
 * to divide by.
 */
import { formatAmount, valueWindow } from './shared.js';

/** Provider ids this adapter answers for, as the host's `llm` registry names them. */
export const ids = ['deepseek-account'];

/** Shown in the panel header while this provider is active. */
export const label = 'DeepSeek 账号';

/** No API key: the stored account grant is the credential, and the service holds it. */
export const credential = null;

/** Recharge wallets first (spendable), then granted ones, each row labelled. */
function windowsOf(wallets, base, prefix) {
	const out = [];
	if (!Array.isArray(wallets)) return out;
	for (let index = 0; index < wallets.length; index++) {
		const wallet = wallets[index] !== null && typeof wallets[index] === 'object' ? wallets[index] : {};
		const currency = typeof wallet.currency === 'string' ? wallet.currency : '';
		const text = (currency.length > 0 ? currency + ' ' : '') + formatAmount(wallet.balance);
		const name = wallets.length > 1 && currency.length > 0 ? base + '（' + currency + '）' : base;
		out.push(valueWindow(prefix + index, name, text, null, wallet.balance));
	}
	return out;
}

/**
 * @param io - host-supplied service accessor and client identity.
 * @returns the account's wallets, recharge first.
 */
export async function read(io) {
	const account = io.service('deepseekAccount');
	if (account === undefined || account === null || typeof account.getBalance !== 'function') {
		throw new Error('此 DSH 未启用账号服务（deepseekAccount），无法读取账号额度');
	}
	if (typeof account.getState === 'function') {
		const state = await account.getState();
		// `credential-stored` is the only state that can answer; `signed-out` is an
		// ordinary condition worth its own message rather than a failed read.
		if (state === null || state === undefined || state.status !== 'credential-stored') {
			throw new Error('尚未登录 DeepSeek 账号：请先在「设置 → 账号」中登录，再查看额度');
		}
	}
	const balance = await account.getBalance(io.accountClient());
	if (balance === null || balance === undefined) {
		throw new Error('DeepSeek 账号额度读取被拒绝：登录可能已失效，请重新登录');
	}
	// A failed query never becomes a zero balance; say so instead of showing one.
	if (balance.status !== 'ready') {
		throw new Error('DeepSeek 账号额度查询失败：Platform 未返回余额');
	}
	const windows = [
		...windowsOf(balance.value, '账户余额', 'balance-'),
		...windowsOf(balance.bonusWallets, '赠送余额', 'bonus-'),
	];
	if (windows.length === 0) throw new Error('DeepSeek 账号额度查询成功，但没有返回任何钱包');
	return { label, primary: windows[0].key, windows };
}
