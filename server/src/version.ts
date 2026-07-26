/**
 * Injected at image build time (docker build --build-arg AMBER_VERSION). Falls
 * back to the workspace version for local runs.
 */
export const APP_VERSION = process.env.AMBER_VERSION ?? "0.1.0";
