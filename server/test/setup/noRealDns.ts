import { setDefaultResolver } from "../../src/security/egress.ts";
import { refuseAllDns } from "../helpers/egress.ts";

/**
 * No server test may depend on real DNS. The egress guard resolves every
 * restricted forge's host, so the default resolver is replaced with one that
 * refuses loudly. A test that means to exercise the guard injects its own
 * resolver (helpers/egress.ts), and fixtures that sync from local origins
 * mark their forges unrestricted.
 */
setDefaultResolver(refuseAllDns);
