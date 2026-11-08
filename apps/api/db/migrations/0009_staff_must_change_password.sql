-- An account made or reset by an operator starts with a password the operator knows. This flag marks such an account: until
-- the person changes the password, their sessions can do nothing else. Accounts that already exist are not marked.
-- The application role may write the flag, because changing a password clears it; it can still not create or reassign people.
ALTER TABLE staff_users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
GRANT UPDATE (must_change_password) ON staff_users TO saral_app;
