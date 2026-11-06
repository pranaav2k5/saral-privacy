// jsdom has no Web Crypto digest or UTF-8 encoder. Use Node's, so the notice fingerprint runs under test.
const { webcrypto } = require("node:crypto");
const { TextDecoder, TextEncoder } = require("node:util");

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
