/* Keystone Engine runtime shim.
 *
 * The service worker rewrites URLs it can see in the document. This shim covers
 * the ones that only exist at runtime: fetch, XMLHttpRequest, the History API,
 * window.open, and elements injected after load.
 *
 * It is best effort by design. Anything that constructs a URL from a string and
 * hands it to an API not patched here will leave the proxy.
 */
(function () {
	var src = document.currentScript && document.currentScript.src;
	if (!src) return;

	var base = src.slice(0, src.lastIndexOf("/") + 1);
	var prefix = base + "g/";

	var PASSTHROUGH = /^(javascript|mailto|tel|data|blob|about|file|ws|wss):/i;

	function proxied(absolute) {
		var bytes = new TextEncoder().encode(absolute);
		var binary = "";
		for (var i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return (
			prefix +
			btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
		);
	}

	function rewrite(ref, relativeTo) {
		if (typeof ref !== "string") {
			if (ref && typeof ref.url === "string") return rewrite(ref.url, relativeTo);
			return ref;
		}

		var raw = ref.trim();
		if (!raw || raw.charAt(0) === "#") return ref;
		if (PASSTHROUGH.test(raw)) return ref;
		if (raw.indexOf(prefix) === 0) return ref;

		var absolute;
		try {
			absolute = new URL(raw, relativeTo || document.baseURI).href;
		} catch (e) {
			return ref;
		}

		if (!/^https?:/i.test(absolute)) return ref;

		// Already proxied: an absolute URL for one of our own proxied paths must
		// not be wrapped a second time, or the target becomes this origin.
		if (absolute.indexOf(location.origin + prefix) === 0) return ref;

		return proxied(absolute);
	}

	// fetch
	var nativeFetch = window.fetch;
	window.fetch = function (input, init) {
		if (typeof input === "string") {
			input = rewrite(input);
		} else if (input instanceof Request) {
			var next = rewrite(input.url);
			if (next !== input.url) input = new Request(next, input);
		}
		return nativeFetch.call(this, input, init);
	};

	// XMLHttpRequest
	var nativeOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url) {
		var args = Array.prototype.slice.call(arguments);
		args[1] = rewrite(url);
		return nativeOpen.apply(this, args);
	};

	// History API, so pushState does not navigate the frame off-origin
	["pushState", "replaceState"].forEach(function (name) {
		var native = history[name];
		if (!native) return;
		history[name] = function (state, title, url) {
			var args = Array.prototype.slice.call(arguments);
			if (url != null) args[2] = rewrite(url);
			return native.apply(this, args);
		};
	});

	// window.open
	var nativeWindowOpen = window.open;
	window.open = function (url) {
		var args = Array.prototype.slice.call(arguments);
		if (url != null) args[0] = rewrite(url);
		return nativeWindowOpen.apply(this, args);
	};

	// Elements added after load never went through the service worker's rewrite.
	function fixElement(el) {
		if (!el || el.nodeType !== 1) return;
		["src", "href", "poster", "action"].forEach(function (attr) {
			var value = el.getAttribute && el.getAttribute(attr);
			if (!value) return;
			var next = rewrite(value);
			if (next !== value) el.setAttribute(attr, next);
		});
	}

	if (typeof MutationObserver === "function") {
		new MutationObserver(function (records) {
			records.forEach(function (record) {
				Array.prototype.forEach.call(record.addedNodes, fixElement);
			});
		}).observe(document.documentElement, { childList: true, subtree: true });
	}
})();
