import { version as packageVersion } from "../package.json";

export { init } from "./ui";
export type { ConsentState, InitOptions, Locale, PurposeConfig, SaralPrivacyInstance } from "./ui";

/** SDK version, inlined from package.json at build time. */
export const version: string = packageVersion;
