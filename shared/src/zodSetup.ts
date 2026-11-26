import { z } from "zod";

/**
 * Zod compiles object parsers with `new Function` when it can, and finds out
 * whether it can by trying. The web app is served with a
 * Content-Security-Policy that forbids evaluated script, so in a browser that
 * probe is refused and reported as a policy violation on every page load.
 * Turning the compiler off skips the probe; the interpreted parser gives the
 * same answers, on both sides.
 *
 * A schema decides this when it is created, so every module here that builds
 * one imports this file, and an import always runs before the module that
 * asked for it. Setting it from the web app's entry point is too late: the
 * bundler puts these schemas in a chunk that loads before the entry's body.
 */
z.config({ jitless: true });
