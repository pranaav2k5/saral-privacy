-- A webhook secret can be rotated with the previous secret left working for a while, so a receiver can be switched over
-- without a gap. Secrets are derived from the endpoint and a version number and are never stored, so all that has to be kept
-- is when the last rotation that left the old secret working happened. While it is recent (the service decides how recent),
-- deliveries are signed with the current secret and the one before it. A rotation that cuts the old secret off at once,
-- and an endpoint never rotated, have no time here.
--
-- It means something only after a rotation, so it cannot be set while the secret is still the first one.

ALTER TABLE webhook_endpoints ADD COLUMN rotated_at timestamptz CHECK (rotated_at IS NULL OR secret_version > 1);
GRANT UPDATE (rotated_at) ON webhook_endpoints TO saral_app;
