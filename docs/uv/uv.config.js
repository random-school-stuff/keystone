/**
 * Ultraviolet configuration.
 *
 * This file is loaded in two different contexts:
 *   - the page, via <script src="uv/uv.config.js">
 *   - the service worker, via importScripts("uv.config.js")
 *
 * The base path is derived from whichever one is loading it, so the site works
 * at a domain root and under a GitHub Pages project path such as /keystone/.
 *
 * NOTE: Ultraviolet matches requests with `location.origin + config.prefix`,
 * so every value here must be a root-relative PATH, not a full URL.
 */
(function () {
	var source =
		(typeof document !== "undefined" &&
			document.currentScript &&
			document.currentScript.src) ||
		(typeof self !== "undefined" && self.location && self.location.href) ||
		"";

	// Path only, no origin: e.g. /keystone/uv/
	var base = new URL(source, self.location.href).pathname;
	base = base.slice(0, base.lastIndexOf("/") + 1);

	self.__uv$config = {
		prefix: base + "service/",
		encodeUrl: Ultraviolet.codec.xor.encode,
		decodeUrl: Ultraviolet.codec.xor.decode,
		handler: base + "uv.handler.js",
		client: base + "uv.client.js",
		bundle: base + "uv.bundle.js",
		config: base + "uv.config.js",
		sw: base + "uv.sw.js",
	};
})();
