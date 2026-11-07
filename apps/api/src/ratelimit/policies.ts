export interface Policy {
  limit: number;
  windowMs: number;
}

export interface Limits {
  /** Every request from one address (or one IPv6 /64). */
  ip: Policy;
  /** Sign-in, authenticator set-up and code checks, from one address, on top of `ip`. */
  auth: Policy;
  /** Every request made with one API key or one staff session, from anywhere. */
  principal: Policy;
}

export const DEFAULT_LIMITS: Limits = {
  ip: { limit: 600, windowMs: 60_000 },
  auth: { limit: 10, windowMs: 60_000 },
  principal: { limit: 1200, windowMs: 60_000 },
};

export const RATE_LIMITS = Symbol("RATE_LIMITS");
export const RATE_LIMIT_CLOCK = Symbol("RATE_LIMIT_CLOCK");
