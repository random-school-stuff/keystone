"use strict";

/**
 * Registers the Ultraviolet service worker.
 * Shared by the landing page and the error page.
 */

/** Stock Ultraviolet service worker. */
const stockSW = "/uv/sw.js";

/** Hostnames that browsers allow service workers on over plain HTTP. */
const swAllowedHostnames = ["localhost", "127.0.0.1"];

async function registerSW() {
	if (!navigator.serviceWorker) {
		if (
			location.protocol !== "https:" &&
			!swAllowedHostnames.includes(location.hostname)
		) {
			throw new Error("Service workers require HTTPS.");
		}

		throw new Error("This browser does not support service workers.");
	}

	await navigator.serviceWorker.register(stockSW);
}
