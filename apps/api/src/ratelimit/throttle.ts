import { SetMetadata } from "@nestjs/common";

export const THROTTLE_KEY = "saral:throttle";
export const SKIP_THROTTLE_KEY = "saral:skip-throttle";

/** Counts the route in the sign-in bucket too, which is much tighter than the general one. */
export const Throttle = (bucket: "auth") => SetMetadata(THROTTLE_KEY, bucket);

/** Not limited at all. Only for the health check: a load balancer that is refused would take a healthy instance out of service. */
export const SkipThrottle = () => SetMetadata(SKIP_THROTTLE_KEY, true);
