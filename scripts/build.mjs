/**
 * Copies the browser bundles that Ultraviolet needs out of node_modules and
 * into public/, so the site can be served as plain static files.
 *
 * public/uv/uv.config.js is hand written and is intentionally NOT copied from
 * the package, which lets us keep the upstream bundle unmodified.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");

/** @param {string} from @param {string} to @param {string[]} files */
async function vendor(from, to, files) {
	await mkdir(to, { recursive: true });
	for (const file of files) {
		await copyFile(join(from, file), join(to, file));
	}
	console.log(`  ${files.length} file(s) -> ${to.slice(root.length + 1)}`);
}

console.log("Vendoring browser bundles...");

await vendor(uvPath, join(publicDir, "uv"), [
	"sw.js",
	"uv.bundle.js",
	"uv.client.js",
	"uv.handler.js",
	"uv.sw.js",
]);

await vendor(baremuxPath, join(publicDir, "baremux"), [
	"worker.js",
	"index.js",
	"index.mjs",
]);

// Only the ESM build is used; the 1.7 MB legacy bundle is left out on purpose.
await vendor(epoxyPath, join(publicDir, "epoxy"), ["index.mjs"]);

console.log("Done.");
