"use strict";

/**
 * Keystone client.
 *
 * Wires the landing page to Ultraviolet: registers the service worker, picks a
 * transport (Epoxy over Wisp), and hands the encoded URL to the iframe.
 */
(() => {
	const $ = (selector) => document.querySelector(selector);

	const form = $("#uv-form");
	const address = $("#uv-address");
	const searchEngine = $("#uv-search-engine");
	const errorText = $("#uv-error");
	const errorCode = $("#uv-error-code");
	const goButton = form.querySelector(".go-button");

	const frame = $("#uv-frame");
	const browser = $("#browser");
	const browserUrl = $("#browser-url");

	const themeToggle = $("#theme-toggle");
	const settingsToggle = $("#settings-toggle");
	const settingsPanel = $("#settings");
	const settingsBackdrop = $("#drawer-backdrop");
	const settingsClose = $("#settings-close");
	const settingsSave = $("#settings-save");
	const settingsReset = $("#settings-reset");
	const engineSelect = $("#engine-select");
	const wispInput = $("#wisp-input");

	const STORAGE = {
		engine: "keystone.engine",
		wisp: "keystone.wisp",
		theme: "keystone.theme",
	};

	const DEFAULT_ENGINE = "https://www.google.com/search?q=%s";

	const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

	/** Transport URL that is currently installed in the shared worker. */
	let activeWisp = null;

	/* ---------------------------------------------------------------------
	   Theme
	   --------------------------------------------------------------------- */

	function setTheme(theme) {
		document.documentElement.dataset.theme = theme;
		try {
			localStorage.setItem(STORAGE.theme, theme);
		} catch {
			/* storage can be blocked; the theme still applies for this page */
		}

		const isLight = theme === "light";
		themeToggle.setAttribute(
			"aria-label",
			isLight ? "Switch to dark theme" : "Switch to light theme",
		);

		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute("content", isLight ? "#f5f7fc" : "#07080d");
	}

	themeToggle.addEventListener("click", () => {
		setTheme(
			document.documentElement.dataset.theme === "light" ? "dark" : "light",
		);
	});

	/* ---------------------------------------------------------------------
	   Preferences
	   --------------------------------------------------------------------- */

	function readPreference(key, fallback) {
		try {
			return localStorage.getItem(key) ?? fallback;
		} catch {
			return fallback;
		}
	}

	function writePreference(key, value) {
		try {
			if (value) localStorage.setItem(key, value);
			else localStorage.removeItem(key);
		} catch {
			/* ignore */
		}
	}

	function applyEngine() {
		const engine = readPreference(STORAGE.engine, DEFAULT_ENGINE);
		searchEngine.value = engine;
		engineSelect.value = engine;
		if (!engineSelect.value) {
			// Saved engine is no longer in the list; fall back to the default.
			engineSelect.value = DEFAULT_ENGINE;
			searchEngine.value = DEFAULT_ENGINE;
		}
	}

	/** Resolve the Wisp endpoint, defaulting to this same origin. */
	function getWispUrl() {
		const custom = readPreference(STORAGE.wisp, "");
		if (custom) return custom;

		const scheme = location.protocol === "https:" ? "wss" : "ws";
		return `${scheme}://${location.host}/wisp/`;
	}

	/* ---------------------------------------------------------------------
	   Settings drawer
	   --------------------------------------------------------------------- */

	let lastFocused = null;

	function openSettings() {
		lastFocused = document.activeElement;
		applyEngine();
		wispInput.value = readPreference(STORAGE.wisp, "");

		settingsBackdrop.hidden = false;
		settingsPanel.hidden = false;
		requestAnimationFrame(() => settingsPanel.classList.add("is-open"));

		settingsToggle.setAttribute("aria-expanded", "true");
		settingsClose.focus();
	}

	function closeSettings() {
		settingsPanel.classList.remove("is-open");
		settingsToggle.setAttribute("aria-expanded", "false");

		const done = () => {
			settingsPanel.hidden = true;
			settingsBackdrop.hidden = true;
		};

		// Wait for the slide-out before removing from the layout.
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) done();
		else setTimeout(done, 260);

		if (lastFocused instanceof HTMLElement) lastFocused.focus();
	}

	settingsToggle.addEventListener("click", openSettings);
	settingsClose.addEventListener("click", closeSettings);
	settingsBackdrop.addEventListener("click", closeSettings);

	settingsSave.addEventListener("click", () => {
		writePreference(STORAGE.engine, engineSelect.value);
		writePreference(STORAGE.wisp, wispInput.value.trim());
		applyEngine();
		activeWisp = null; // force a fresh transport next launch
		closeSettings();
	});

	settingsReset.addEventListener("click", () => {
		writePreference(STORAGE.engine, "");
		writePreference(STORAGE.wisp, "");
		engineSelect.value = DEFAULT_ENGINE;
		wispInput.value = "";
		applyEngine();
		activeWisp = null;
	});

	/* ---------------------------------------------------------------------
	   Errors
	   --------------------------------------------------------------------- */

	function clearError() {
		errorText.textContent = "";
		errorCode.hidden = true;
		errorCode.textContent = "";
	}

	function showError(message, error) {
		errorText.textContent = message;
		if (error) {
			errorCode.hidden = false;
			errorCode.textContent = String(error.stack || error);
		}
	}

	/* ---------------------------------------------------------------------
	   Launching a session
	   --------------------------------------------------------------------- */

	function setBusy(busy) {
		goButton.disabled = busy;
		form.setAttribute("aria-busy", String(busy));
		goButton.style.opacity = busy ? "0.65" : "";
	}

	function openBrowser(target) {
		browserUrl.textContent = target;
		browserUrl.title = target;
		browser.hidden = false;
		document.body.classList.add("is-browsing");
	}

	function closeBrowser() {
		browser.hidden = true;
		document.body.classList.remove("is-browsing");
		frame.src = "about:blank";
		address.focus();
		address.select();
	}

	async function launch(rawInput) {
		clearError();

		const input = (rawInput ?? address.value).trim();
		if (!input) {
			address.focus();
			return;
		}

		setBusy(true);
		try {
			try {
				await registerSW();
			} catch (error) {
				showError(
					"Keystone could not start a secure session. The site must be served over HTTPS, and your browser needs service worker support.",
					error,
				);
				return;
			}

			const target = search(input, searchEngine.value);
			const wispUrl = getWispUrl();

			try {
				const current = await connection.getTransport().catch(() => null);
				if (current !== "/epoxy/index.mjs" || activeWisp !== wispUrl) {
					await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
					activeWisp = wispUrl;
				}
			} catch (error) {
				activeWisp = null;
				showError(
					"Keystone could not reach its proxy server. Check that the Wisp endpoint is running and try again.",
					error,
				);
				return;
			}

			openBrowser(target);
			frame.src = __uv$config.prefix + __uv$config.encodeUrl(target);
		} finally {
			setBusy(false);
		}
	}

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		launch();
	});

	/* ---------------------------------------------------------------------
	   Quick links
	   --------------------------------------------------------------------- */

	for (const chip of document.querySelectorAll(".chip[data-href]")) {
		chip.addEventListener("click", () => {
			address.value = chip.dataset.href;
			launch(chip.dataset.href);
		});
	}

	/* ---------------------------------------------------------------------
	   Browser controls
	   --------------------------------------------------------------------- */

	$("#browser-back").addEventListener("click", closeBrowser);

	$("#browser-reload").addEventListener("click", () => {
		try {
			frame.contentWindow.location.reload();
		} catch {
			// Not reachable yet; re-navigating is the next best thing.
			frame.src = frame.src;
		}
	});

	$("#browser-external").addEventListener("click", () => {
		if (frame.src) window.open(frame.src, "_blank", "noopener");
	});

	/** Keep the address bar in sync as the user moves inside the proxied page. */
	frame.addEventListener("load", () => {
		try {
			const href = frame.contentWindow.location.href;
			const index = href.indexOf(__uv$config.prefix);
			if (index === -1) return;

			const encoded = href.slice(index + __uv$config.prefix.length);
			const decoded = __uv$config.decodeUrl(encoded);
			if (decoded) {
				browserUrl.textContent = decoded;
				browserUrl.title = decoded;
			}
		} catch {
			/* cross-document access can fail transiently; ignore */
		}
	});

	/* ---------------------------------------------------------------------
	   Keyboard shortcuts
	   --------------------------------------------------------------------- */

	document.addEventListener("keydown", (event) => {
		const target = event.target;
		const typing =
			target instanceof HTMLElement &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT" ||
				target.isContentEditable);

		if (event.key === "Escape") {
			if (!settingsPanel.hidden) {
				closeSettings();
			} else if (!browser.hidden) {
				closeBrowser();
			}
			return;
		}

		if (event.key === "/" && !typing && browser.hidden) {
			event.preventDefault();
			address.focus();
		}
	});

	/* ---------------------------------------------------------------------
	   Init
	   --------------------------------------------------------------------- */

	applyEngine();

	const savedTheme = readPreference(STORAGE.theme, "");
	setTheme(
		savedTheme === "light" || savedTheme === "dark"
			? savedTheme
			: window.matchMedia("(prefers-color-scheme: light)").matches
				? "light"
				: "dark",
	);
})();
