/**
 * Module loader registration.
 * Preloaded via --import to make "loopx" importable in scripts.
 *
 * Uses Node.js module.register() (requires Node >= 20.6).
 */
import { register } from "node:module";

register(new URL("./loader-hook.js", import.meta.url).href);
