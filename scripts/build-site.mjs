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

// Only the ESM build is used by the page.
await vendor(epoxyPath, join(docsDir, "epoxy"), ["index.mjs"]);

console.log("Done. docs/ is ready to publish.");
