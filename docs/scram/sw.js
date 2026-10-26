/**
 * Scramjet service worker.
 *
 * Scramjet is the successor to Ultraviolet: better site coverage, CAPTCHA
 * support, and an active maintainer. It intercepts in the same way, through a
 * service worker, and reads its configuration from IndexedDB, which the
 * page-side ScramjetController writes during init().
 *
 * Two things here are not in the upstream example, both for good reason.
 */
importScripts("./scramjet.all.js");

var ScramjetServiceWorker = $scramjetLoadWorker().ScramjetServiceWorker;

/* 1. IndexedDB schema repair.
 *
 * ScramjetServiceWorker opens "$scramjet" in its constructor with
 *
 *     openDB("$scramjet", 1)
 *
 * and no upgrade callback, while ScramjetController.openIDB() opens the same
 * database with an upgrade callback that creates the object stores. IndexedDB
 * only runs an upgrade when the version increases, so whichever side opens the
 * database first wins: if the worker gets there first, it creates an empty
 * version 1 database and the controller's upgrade never runs. Every request
 * then fails with
 *
 *     NotFoundError: One of the specified object stores was not found.
 *
 * The worker normally loses that race because the page initialises the
 * controller first, but it is not guaranteed, and a hard reload can invert the
 * order. Creating the stores up front removes the race entirely.
 */
var STORES = [
	"config",
	"cookies",
	"redirectTrackers",
	"referrerPolicies",
	"publicSuffixList",
];

function ensureSchema() {
	return new Promise(function (resolve) {
		var request;

		try {
			request = indexedDB.open("$scramjet", 1);
		} catch (e) {
			resolve();
			return;
		}

		request.onupgradeneeded = function () {
			var db = request.result;
			STORES.forEach(function (name) {
				if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
			});
		};

		request.onsuccess = function () {
			request.result.close();
			resolve();
		};

		request.onerror = function () {
			resolve();
		};
	});
}

/* 2. Deferred construction.
 *
 * The worker must not be constructed until the schema exists, because its
 * constructor is the thing that opens the database. */
var scramjet = null;
var ready = ensureSchema().then(function () {
	scramjet = new ScramjetServiceWorker();
});

self.addEventListener("fetch", function (event) {
	// Never touch requests outside this worker's own prefix. Scramjet's route()
	// reads config.prefix, which is undefined until loadConfig() has run.
	if (!event.request.url.startsWith(self.registration.scope)) return;

	event.respondWith(
		(async function () {
			await ready;
			await scramjet.loadConfig();
			if (scramjet.route(event)) return scramjet.fetch(event);
			return fetch(event.request);
		})()
	);
});
