/**
 * Copies the browser bundles into docs/ so GitHub Pages can serve the site as
 * plain static files. Run `npm run build:site` after changing dependencies.
 *
 * docs/uv/uv.config.js is hand written and is not touched by this script.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");

/** @param {string} from @param {string} to @param {string[]} files */
async function vendor(from, to, files) {
	await mkdir(to, { recursive: true });
	for (const file of files) {
		await copyFile(join(from, file), join(to, file));
	}
	console.log(`  ${files.length} file(s) -> ${to.slice(root.length + 1)}`);
}

console.log("Vendoring browser bundles into docs/ ...");

await vendor(uvPath, join(docsDir, "uv"), [
	"sw.js",
	"uv.bundle.js",
	"uv.client.js",
	"uv.handler.js",
	"uv.sw.js",
]);

await vendor(baremuxPath, join(docsDir, "baremux"), ["index.js", "worker.js"]);

// Only the ESM builds are used by the page. Each transport is optional: the
// page only loads one when the user picks it in settings.
await vendor(epoxyPath, join(docsDir, "epoxy"), ["index.mjs"]);

// libcurl bundles its WebAssembly module inside index.mjs, so no separate
// .wasm file is served. docs/transports/libcurl.mjs is hand written and is not
// touched by this script.
await vendor(
	join(root, "node_modules", "@mercuryworkshop", "libcurl-transport", "dist"),
	join(docsDir, "libcurl"),
	["index.mjs"]
);

// Scramjet ships one page bundle, a sync worker, and a WebAssembly rewriter.
// docs/scram/sw.js and docs/keystone/ are hand written and left alone.
await vendor(scramjetPath, join(docsDir, "scram"), [
	"scramjet.all.js",
	"scramjet.sync.js",
	"scramjet.wasm.wasm",
]);

console.log("Done. docs/ is ready to publish.");
