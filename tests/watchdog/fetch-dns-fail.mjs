// Preload for tests only: every fetch fails the way a DNS failure does (fast rejection).
globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }) }
