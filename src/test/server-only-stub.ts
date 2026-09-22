/**
 * `server-only` is a build-time guard: importing it outside a server context
 * throws on purpose. Vitest is neither server nor client bundle, so the real
 * package throws and takes the whole suite with it. Tests alias it here.
 */
export {};
