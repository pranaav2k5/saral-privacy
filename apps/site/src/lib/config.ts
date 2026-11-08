/**
 * Where the Saral API lives, which is where the public signing keys are published. Set `NEXT_PUBLIC_API_BASE_URL` when building the site.
 * The default is the API's local development address.
 */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");
