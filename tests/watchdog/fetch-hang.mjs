// Preload for tests only: every fetch hangs and ignores its abort signal, like a wedged network stack.
globalThis.fetch = () => new Promise(() => {})
