/* Keystone Engine service worker.
 *
 * A small, self-contained proxy engine written for this project. It fetches
 * through the configured Wisp server and rewrites HTML and CSS so a page can be
 * rendered on this origin.
 *
 * Scope is intentionally modest. Rewriting happens at the document level, so
 * static pages work and script-heavy pages largely do not. Ultraviolet and
 * Scramjet are available in settings for those.
 */
importScripts("../baremux/index.js");
importScripts("keystone.config.js");

var config = self.__keystone$config;

/* A BareClient holds one port to the bare-mux worker. If that worker is
 * replaced (a reload tears down and recreates the SharedWorker), the cached
 * port keeps talking to the dead instance, which answers every request with
 * "there are no bare clients". Building the client per request is cheap and
 * always resolves the current worker. */
function bareClient() {
	return new BareMux.BareClient();
}

/** Schemes that must never be routed through the proxy. */
var PASSTHROUGH = /^(javascript|mailto|tel|data|blob|about|file|ws|wss):/i;

var URL_ATTRS =
	/\b(src|href|action|poster|formaction|data-src|data-href|cite|background|longdesc)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

var ERROR_PAGE =
	"<!doctype html><meta charset=utf-8><title>Keystone</title>" +
	'<body style="font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;' +
	'place-items:center;height:100vh;background:#07080d;color:#e6e9f5">' +
	'<div style="max-width:34rem;padding:2rem;text-align:center">' +
	"<h1 style=\"font-size:1.25rem;margin:0 0 .75rem\">Keystone Engine could not load this page</h1>" +
	'<p style="color:#9aa3bf;margin:0 0 1.25rem">%MESSAGE%</p>' +
	'<p style="color:#9aa3bf;margin:0;font-size:.875rem">The built-in engine handles static ' +
	"pages only. Switch to Ultraviolet or Scramjet in settings for sites that rely on " +
	"JavaScript.</p></div>";

function errorPage(message, status) {
	return new Response(ERROR_PAGE.replace("%MESSAGE%", message), {
		status: status || 502,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

/** Turn an absolute target URL into the path this worker serves it from. */
function proxied(target) {
	return config.prefix + config.encode(target);
}

/* Attribute values are HTML-escaped in the source, so `?a=1&amp;b=2` reaches
 * this regex as literal text. Resolving that with new URL() keeps the "amp;"
 * as part of the parameter name, which silently corrupts every query string
 * (stylesheets and images with cache-busting parameters are the usual
 * casualties). Decode on the way in, re-encode on the way out. */
function decodeAttr(value) {
	return String(value)
		.replace(/&amp;/gi, "&")
		.replace(/&#0*38;/g, "&")
		.replace(/&#x0*26;/gi, "&");
}

function encodeAttr(value) {
	return String(value).replace(/&/g, "&amp;");
}

/** Resolve a possibly relative reference and wrap it for the proxy. */
function rewriteRef(ref, base) {
	var raw = decodeAttr(String(ref).trim());
	if (!raw || raw.charAt(0) === "#") return ref;
	if (PASSTHROUGH.test(raw)) return ref;
	if (raw.indexOf(config.prefix) === 0) return ref;

	var absolute;
	try {
		absolute = new URL(raw, base).href;
	} catch (e) {
		return ref;
	}

	if (!/^https?:/i.test(absolute)) return ref;

	// Already ours. Without this an absolute same-origin proxied URL is proxied
	// a second time, and the target becomes a 127.0.0.1 address the Wisp server
	// refuses to reach.
	if (absolute.indexOf(location.origin + config.prefix) === 0) return ref;

	return encodeAttr(proxied(absolute));
}

function rewriteCss(css, base) {
	var out = css.replace(
		/url\(\s*("([^"]*)"|'([^']*)'|([^'")]+))\s*\)/gi,
		function (match, _quoted, dq, sq, bare) {
			var ref = dq != null ? dq : sq != null ? sq : bare;
			var next = rewriteRef(ref, base);
			if (next === ref) return match;
			return 'url("' + next + '")';
		}
	);

	// `@import "sheet.css"` has no url() wrapper and would otherwise be missed.
	out = out.replace(
		/@import\s+("([^"]*)"|'([^']*)')/gi,
		function (match, _quoted, dq, sq) {
			var ref = dq != null ? dq : sq;
			var next = rewriteRef(ref, base);
			if (next === ref) return match;
			return '@import "' + next + '"';
		}
	);

	return out;
}

function rewriteSrcset(value, base) {
	return value
		.split(",")
		.map(function (part) {
			var bits = part.trim().split(/\s+/);
			if (!bits[0]) return part;
			bits[0] = rewriteRef(bits[0], base);
			return bits.join(" ");
		})
		.join(", ");
}

function rewriteHtml(html, base) {
	var out = html;

	// Subresource integrity hashes no longer match once URLs are rewritten, and
	// a stale hash makes the browser drop the asset entirely.
	out = out.replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

	// A target page's own CSP would block the injected client and any rewritten
	// asset, so the meta form is removed. Header CSP is stripped below.
	out = out.replace(
		/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
		""
	);

	out = out.replace(URL_ATTRS, function (match, attr, _q, dq, sq, bare) {
		var ref = dq != null ? dq : sq != null ? sq : bare;
		var next = rewriteRef(ref, base);
		if (next === ref) return match;
		return attr + '="' + next + '"';
	});

	out = out.replace(
		/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi,
		function (match, _q, dq, sq) {
			var value = dq != null ? dq : sq;
			return 'srcset="' + rewriteSrcset(value, base) + '"';
		}
	);

	out = out.replace(
		/<style\b[^>]*>([\s\S]*?)<\/style>/gi,
		function (match, body) {
			return match.replace(body, rewriteCss(body, base));
		}
	);

	out = out.replace(
		/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi,
		function (match, _q, dq, sq) {
			var value = dq != null ? dq : sq;
			var next = rewriteCss(value, base);
			return next === value ? match : 'style="' + next + '"';
		}
	);

	// Inject the runtime shim before the first script so patches land first.
	var shim = '<script src="' + config.client + '"></script>';
	var head = out.search(/<head\b[^>]*>/i);
	if (head !== -1) {
		var end = head + out.slice(head).indexOf(">") + 1;
		out = out.slice(0, end) + shim + out.slice(end);
	} else {
		out = shim + out;
	}

	return out;
}

/** Headers that would break rendering on this origin or leak the real origin. */
var DROP_HEADERS = [
	"content-security-policy",
	"content-security-policy-report-only",
	"content-encoding",
	"content-length",
	"x-frame-options",
	"cross-origin-opener-policy",
	"cross-origin-embedder-policy",
	"cross-origin-resource-policy",
	"strict-transport-security",
	"set-cookie",
];

function cleanHeaders(source) {
	var headers = new Headers(source);
	DROP_HEADERS.forEach(function (name) {
		headers.delete(name);
	});
	return headers;
}

async function handle(event) {
	var request = event.request;
	var prefix = location.origin + config.prefix;

	var rest = request.url.slice(prefix.length);
	var cut = rest.search(/[?#]/);
	if (cut !== -1) rest = rest.slice(0, cut);

	var target;
	try {
		target = new URL(config.decode(decodeURIComponent(rest)));
	} catch (e) {
		return errorPage("The address in this link could not be read.", 400);
	}

	if (!/^https?:$/i.test(target.protocol)) {
		return errorPage("Only http and https addresses can be proxied.", 400);
	}

	// Loop guard. A request for one of our own proxied URLs must be served
	// directly, never handed to the Wisp server, which cannot reach this origin.
	if (target.origin === location.origin && target.pathname.indexOf(config.prefix) === 0) {
		var inner = target.pathname.slice(config.prefix.length).split(/[?#]/)[0];
		try {
			target = new URL(config.decode(decodeURIComponent(inner)));
		} catch (e) {
			return errorPage("The address in this link could not be read.", 400);
		}
	}

	var headers = new Headers(request.headers);
	headers.delete("host");
	headers.delete("origin");
	headers.delete("referer");
	headers.delete("sec-fetch-site");
	headers.delete("accept-encoding");
	headers.set("referer", target.origin + "/");

	var init = {
		method: request.method,
		headers: headers,
		redirect: "manual",
	};

	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = await request.arrayBuffer();
	}

	var response;
	try {
		response = await bareClient().fetch(target.href, init);
	} catch (e) {
		// Surfacing the underlying reason beats a generic message: it is the
		// difference between "the server is down" and "this request shape is
		// unsupported", and the user can act on it.
		var reason = e && e.message ? e.message : String(e);
		console.error("keystone: fetch failed", target.href, reason);
		return errorPage(
			"The proxy server did not answer for this address. " + reason,
			502
		);
	}

	// A redirect has to be expressed as a proxied URL or the browser would leave
	// this origin and hit the target directly.
	if (response.status >= 300 && response.status < 400) {
		var location_ = response.headers.get("location");
		if (location_) {
			var next;
			try {
				next = new URL(location_, target).href;
			} catch (e) {
				next = null;
			}
			if (next) {
				// Already ours: re-wrapping would make the target this origin.
				var already = next.indexOf(location.origin + config.prefix) === 0;
				return new Response(null, {
					status: response.status,
					headers: { location: already ? next : proxied(next) },
				});
			}
		}
	}

	var outHeaders = cleanHeaders(response.headers);
	var type = (response.headers.get("content-type") || "").toLowerCase();

	if (type.indexOf("text/html") !== -1) {
		var html = await response.text();
		outHeaders.set("content-type", "text/html; charset=utf-8");
		return new Response(rewriteHtml(html, target.href), {
			status: response.status,
			headers: outHeaders,
		});
	}

	if (type.indexOf("text/css") !== -1) {
		var css = await response.text();
		outHeaders.set("content-type", "text/css; charset=utf-8");
		return new Response(rewriteCss(css, target.href), {
			status: response.status,
			headers: outHeaders,
		});
	}

	// Everything else is passed through untouched. This keeps the worker honest:
	// it never claims to rewrite what it cannot.
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: outHeaders,
	});
}

self.addEventListener("fetch", function (event) {
	if (!event.request.url.startsWith(location.origin + config.prefix)) return;
	event.respondWith(handle(event));
});
