/**
 * Turns Logo/logo.png into the raster assets the site serves.
 *
 * The source is a 561x445 RGBA canvas whose artwork only occupies a 317x316
 * square in the middle, so serving it directly would ship ~86% empty pixels
 * and misalign the mark inside every square container. This script crops to
 * the artwork's alpha bounds, pads to a square, downsamples with a
 * premultiplied-alpha box filter (a plain average on straight alpha bleeds
 * dark fringes out of transparent edges), and writes optimised PNGs.
 *
 * Run `npm run build:logo` after replacing Logo/logo.png.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "Logo", "logo.png");
const OUT = join(root, "docs");

/* ------------------------------------------------------------------ decode */

/** Decode a non-interlaced 8-bit RGB/RGBA PNG into { width, height, data }. */
function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	const bitDepth = buf[24];
	const colorType = buf[25];
	const interlace = buf[28];
	if (bitDepth !== 8 || interlace !== 0) {
		throw new Error(`unsupported PNG: depth=${bitDepth} interlace=${interlace}`);
	}
	if (colorType !== 6 && colorType !== 2) {
		throw new Error(`unsupported colour type ${colorType}`);
	}
	const channels = colorType === 6 ? 4 : 3;

	const idat = [];
	for (let o = 8; o < buf.length; ) {
		const len = buf.readUInt32BE(o);
		if (buf.slice(o + 4, o + 8).toString("ascii") === "IDAT") {
			idat.push(buf.slice(o + 8, o + 8 + len));
		}
		o += 12 + len;
	}

	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const data = Buffer.alloc(height * stride);

	const paeth = (a, b, c) => {
		const p = a + b - c;
		const pa = Math.abs(p - a);
		const pb = Math.abs(p - b);
		const pc = Math.abs(p - c);
		return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
	};

	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[pos++];
		const line = raw.slice(pos, pos + stride);
		pos += stride;
		const cur = data.slice(y * stride, (y + 1) * stride);
		const prev =
			y > 0 ? data.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? cur[x - channels] : 0;
			const b = prev[x];
			const c = x >= channels ? prev[x - channels] : 0;
			let v = line[x];
			if (filter === 1) v += a;
			else if (filter === 2) v += b;
			else if (filter === 3) v += (a + b) >> 1;
			else if (filter === 4) v += paeth(a, b, c);
			cur[x] = v & 0xff;
		}
	}

	// Normalise to RGBA so every later step has one layout.
	if (channels === 4) return { width, height, data };
	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
		rgba[j] = data[i];
		rgba[j + 1] = data[i + 1];
		rgba[j + 2] = data[i + 2];
		rgba[j + 3] = 255;
	}
	return { width, height, data: rgba };
}

/* ------------------------------------------------------------------ encode */

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, body) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(body.length);
	const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed));
	return Buffer.concat([len, typed, crc]);
}

/** Encode RGBA pixels as a PNG. */
function encodePng(width, height, rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	/*
	 * Adaptive filtering: try all five predictors on every scanline and keep
	 * whichever produces the smallest sum of absolute signed residuals. A
	 * gradient emblem filtered with None is close to incompressible, while
	 * Paeth/Up turn it into long runs of near-zero bytes.
	 */
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	const zero = Buffer.alloc(stride);
	const candidate = Buffer.alloc(stride);

	const paeth = (a, b, c) => {
		const p = a + b - c;
		const pa = Math.abs(p - a);
		const pb = Math.abs(p - b);
		const pc = Math.abs(p - c);
		return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
	};

	for (let y = 0; y < height; y++) {
		const cur = rgba.slice(y * stride, (y + 1) * stride);
		const prev = y > 0 ? rgba.slice((y - 1) * stride, y * stride) : zero;
		let best = Infinity;
		let bestFilter = 0;
		let bestRow = cur;

		for (let filter = 0; filter < 5; filter++) {
			let score = 0;
			for (let x = 0; x < stride; x++) {
				const a = x >= 4 ? cur[x - 4] : 0;
				const b = prev[x];
				const c = x >= 4 ? prev[x - 4] : 0;
				let predicted = 0;
				if (filter === 1) predicted = a;
				else if (filter === 2) predicted = b;
				else if (filter === 3) predicted = (a + b) >> 1;
				else if (filter === 4) predicted = paeth(a, b, c);
				const v = (cur[x] - predicted) & 0xff;
				candidate[x] = v;
				score += v < 128 ? v : 256 - v;
			}
			if (score < best) {
				best = score;
				bestFilter = filter;
				bestRow = Buffer.from(candidate);
			}
		}

		const at = y * (stride + 1);
		raw[at] = bestFilter;
		bestRow.copy(raw, at + 1);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/* --------------------------------------------------------------- transform */

/** Tight bounds of pixels with any alpha. */
function alphaBounds({ width, height, data }) {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] === 0) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (maxX < 0) throw new Error("source image is fully transparent");
	return { minX, minY, maxX, maxY };
}

/**
 * Crop to the artwork and pad it to a centred square, leaving `pad` of the
 * square's side as breathing room around the mark.
 */
function squareCrop(img, pad) {
	const { minX, minY, maxX, maxY } = alphaBounds(img);
	const w = maxX - minX + 1;
	const h = maxY - minY + 1;
	const inner = Math.max(w, h);
	const side = Math.round(inner / (1 - pad * 2));
	const out = Buffer.alloc(side * side * 4);
	const offX = Math.round((side - w) / 2);
	const offY = Math.round((side - h) / 2);
	for (let y = 0; y < h; y++) {
		const from = ((minY + y) * img.width + minX) * 4;
		img.data.copy(
			out,
			((offY + y) * side + offX) * 4,
			from,
			from + w * 4
		);
	}
	return { width: side, height: side, data: out };
}

/** Box-filter downsample in premultiplied alpha, then un-premultiply. */
function resize(img, size) {
	const { width: sw, height: sh, data: src } = img;
	const dst = Buffer.alloc(size * size * 4);
	const scaleX = sw / size;
	const scaleY = sh / size;

	for (let y = 0; y < size; y++) {
		const y0 = Math.floor(y * scaleY);
		const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
		for (let x = 0; x < size; x++) {
			const x0 = Math.floor(x * scaleX);
			const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const i = (sy * sw + sx) * 4;
					const alpha = src[i + 3] / 255;
					r += src[i] * alpha;
					g += src[i + 1] * alpha;
					b += src[i + 2] * alpha;
					a += alpha;
					n++;
				}
			}
			const o = (y * size + x) * 4;
			if (a > 0) {
				dst[o] = Math.round(r / a);
				dst[o + 1] = Math.round(g / a);
				dst[o + 2] = Math.round(b / a);
			}
			dst[o + 3] = Math.round((a / n) * 255);
		}
	}
	return { width: size, height: size, data: dst };
}

/** Flatten transparency onto a solid colour (iOS ignores alpha for icons). */
function flatten(img, hex) {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	const out = Buffer.from(img.data);
	for (let i = 0; i < out.length; i += 4) {
		const a = out[i + 3] / 255;
		out[i] = Math.round(out[i] * a + r * (1 - a));
		out[i + 1] = Math.round(out[i + 1] * a + g * (1 - a));
		out[i + 2] = Math.round(out[i + 2] * a + b * (1 - a));
		out[i + 3] = 255;
	}
	return { width: img.width, height: img.height, data: out };
}

/* -------------------------------------------------------------------- main */

const source = decodePng(await readFile(SOURCE));
const bounds = alphaBounds(source);
const cropped = squareCrop(source, 0.055);

console.log(
	`source ${source.width}x${source.height}, artwork ${bounds.maxX - bounds.minX + 1}x${bounds.maxY - bounds.minY + 1}, square ${cropped.width}px`
);

await mkdir(OUT, { recursive: true });

/** @type {[string, {width:number,height:number,data:Buffer}, string][]} */
const targets = [
	// The header mark renders at 34 CSS px, so 128 covers a 3x display without
	// shipping a 256px gradient nobody sees.
	["logo.png", resize(cropped, 128), "header mark"],
	["favicon.png", resize(cropped, 64), "favicon"],
	["apple-touch-icon.png", flatten(resize(cropped, 180), "#05060b"), "iOS home screen"],
];

for (const [name, img, note] of targets) {
	const png = encodePng(img.width, img.height, img.data);
	await writeFile(join(OUT, name), png);
	console.log(
		`  docs/${name.padEnd(22)} ${img.width}x${img.height}  ${(png.length / 1024).toFixed(1)} KB  (${note})`
	);
}
