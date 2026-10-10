/**
 * The adapter registry. Adding a provider is one module in this directory plus
 * one entry in `ADAPTERS`: the module declares the provider ids it answers for,
 * the credential it reads, and how its own upstream payload becomes windows.
 * Nothing else in the plugin changes, because the client half renders whatever
 * windows an adapter returns.
 *
 * Adapters read either an HTTP endpoint (`io.json`) or a host service
 * (`io.service`); the account-backed DeepSeek provider is the latter.
 */
import * as deepseek from './deepseek.js';
import * as deepseekAccount from './deepseek-account.js';
import * as opencodeGo from './opencode-go.js';

const ADAPTERS = [opencodeGo, deepseek, deepseekAccount];

/**
 * The adapter serving one provider id.
 * @param providerId - a provider id as the host's model selection names it.
 * @returns the adapter, or undefined when no adapter covers that provider.
 */
export function findAdapter(providerId) {
	if (typeof providerId !== 'string' || providerId.length === 0) return undefined;
	for (const adapter of ADAPTERS) {
		if (Array.isArray(adapter.ids) && adapter.ids.includes(providerId)) return adapter;
	}
	return undefined;
}

/** Every provider id any adapter answers for. */
export function adaptedIds() {
	const ids = [];
	for (const adapter of ADAPTERS) {
		if (!Array.isArray(adapter.ids)) continue;
		for (const id of adapter.ids) if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}
