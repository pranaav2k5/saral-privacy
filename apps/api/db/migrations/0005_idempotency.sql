-- A client-chosen random key lets a caller retry a consent request safely after a lost response, without the API ever
-- recognising a person by their identifier alone. Only someone who holds the key gets the earlier consent back.
ALTER TABLE consent_records ADD COLUMN idempotency_key text
  CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$');

CREATE UNIQUE INDEX consent_records_idempotency ON consent_records (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
