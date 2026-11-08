-- Two additions to webhooks.
--
-- 1. Why an endpoint was disabled: its owner did it ('admin'), or Saral did after it failed again and again ('failures').
--    An endpoint disabled before this column existed has no reason recorded and is read as the administrator's doing.
--
-- 2. An administrator can send a failed delivery again. The application role may now write three columns of a delivery,
--    but a trigger lets it do exactly one thing with them: turn a failed delivery back into a pending one with no
--    attempts used, due now. It still cannot mark anything delivered, change what is sent or where, or touch another
--    tenant's rows. The delivery worker, which records outcomes, is not held to that rule.

ALTER TABLE webhook_endpoints ADD COLUMN disabled_reason text CHECK (disabled_reason IN ('admin', 'failures'));
GRANT UPDATE (disabled_reason) ON webhook_endpoints TO saral_app;

GRANT UPDATE (state, attempts, next_attempt_at) ON webhook_deliveries TO saral_app;

CREATE FUNCTION webhook_deliveries_app_update_guard() RETURNS trigger
LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'saral_app' THEN
    IF OLD.state <> 'failed' OR NEW.state <> 'pending' OR NEW.attempts <> 0 OR NEW.next_attempt_at > now() + interval '1 minute' THEN
      RAISE EXCEPTION 'permission denied: the application role may only send a failed webhook delivery again'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER webhook_deliveries_app_update_guard BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_app_update_guard();
