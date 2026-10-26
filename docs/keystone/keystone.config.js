/**
 * Keystone Engine configuration.
 *
 * Keystone is the hand-written engine in this repository: a small
 * service-worker proxy that rewrites HTML and CSS so a page can be fetched
 * through a Wisp server and rendered on this origin.
 *
 * It is deliberately simple. It handles static documents well and does not
 * attempt to emulate JavaScript-heavy sites. Ultraviolet and Scramjet do, and
 * both remain available in settings.
 *
 * Loaded in two contexts, like uv.config.js:
 *   - the page, via <script src="keystone/keystone.config.js">
 *   - the service worker, via importScripts("keystone.config.js")
 *
 * The base path comes from whichever context loads it, so the site works at a
 * domain root and under a GitHub Pages project path such as /keystone/.
 */
(function () {
	var source =
		(typeof document !== "undefined" &&
			document.currentScript &&
			document.currentScript.src) ||
		(typeof self !== "undefined" && self.location && self.location.href) ||
		"";

	var base = new URL(source, self.location.href).pathname;
	base = base.slice(0, base.lastIndexOf("/") + 1);

	/** Percent-free, URL-safe base64 so proxied paths stay readable in a path segment. */
	function encode(target) {
		var bytes = new TextEncoder().encode(String(target));
		var binary = "";
		for (var i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}

	function decode(code) {
		var b64 = String(code).replace(/-/g, "+").replace(/_/g, "/");
		while (b64.length % 4) b64 += "=";
		var binary = atob(b64);
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new TextDecoder().decode(bytes);
	}

	self.__keystone$config = {
		// Root-relative PATH, never a full URL: the worker matches requests with
		// location.origin + prefix.
		prefix: base + "g/",
		client: base + "client.js",
		encode: encode,
		decode: decode,
	};
})();
