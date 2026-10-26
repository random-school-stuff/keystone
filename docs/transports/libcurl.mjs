/**
 * Adapter around @mercuryworkshop/libcurl-transport.
 *
 * Why this exists: bare-mux 2.1.9 hands the transport a plain object of
 * request headers (`Object.fromEntries(...)`), but LibcurlClient.request()
 * iterates its `headers` argument with `for (const [k, v] of headers)`. A
 * plain object is not iterable, so every request threw
 *
 *     TypeError: headers is not iterable
 *
 * and Ultraviolet turned that into a 500 page. libcurl-transport 2.0.6 is the
 * latest published release, so there is no upstream fix to wait for. This
 * subclass only normalizes the header shape and otherwise delegates untouched.
 *
 * BareMux loads transports with `await import(url)` and takes the default
 * export, so this module must export a class as `default`.
 */
import LibcurlClient from "../libcurl/index.mjs";

/** Accept a Headers instance, an entries iterable, an array, or a plain object. */
function toPairs(headers) {
	if (!headers) return [];
	if (Array.isArray(headers)) return headers;
	if (typeof headers.entries === "function") return [...headers.entries()];
	return Object.entries(headers);
}

export default class KeystoneLibcurlClient extends LibcurlClient {
	request(remote, method, body, headers, signal) {
		return super.request(remote, method, body, toPairs(headers), signal);
	}
}

export { KeystoneLibcurlClient };
