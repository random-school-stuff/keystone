// Keystone overrides the stock Ultraviolet config.
// Paths are absolute because Keystone is served from the domain root.
self.__uv$config = {
	prefix: "/uv/service/",
	encodeUrl: Ultraviolet.codec.xor.encode,
	decodeUrl: Ultraviolet.codec.xor.decode,
	handler: "/uv/uv.handler.js",
	client: "/uv/uv.client.js",
	bundle: "/uv/uv.bundle.js",
	config: "/uv/uv.config.js",
	sw: "/uv/uv.sw.js",
};
