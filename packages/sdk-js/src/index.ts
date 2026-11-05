import { version as packageVersion } from "../package.json";

/** SDK version, inlined from package.json at build time. */
export const version: string = packageVersion;
