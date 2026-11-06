/**
 * Where the Saral API lives. Set `NEXT_PUBLIC_API_BASE_URL` when building the dashboard. The default is the API's
 * local development address. The value is public (it is compiled into the page), so it must never carry a secret.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
