"use strict";

/**
 * Turns user input into a fully qualified URL.
 *
 * Accepts bare hosts ("example.com"), full URLs, and falls back to a search
 * query for anything else.
 *
 * @param {string} input
 * @param {string} template Search URL containing a "%s" placeholder.
 * @returns {string}
 */
function search(input, template) {
	const query = String(input).trim();
	if (!query) return "";

	// Already a valid absolute URL.
	try {
		return new URL(query).toString();
	} catch {
		/* keep trying */
	}

	// Looks like a host once a scheme is added.
	try {
		const url = new URL(`http://${query}`);
		if (url.hostname.includes(".")) return url.toString();
	} catch {
		/* treat as a search query */
	}

	return template.replace("%s", encodeURIComponent(query));
}
