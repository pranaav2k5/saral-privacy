-- A person can change their own password. The application role may now write the password hash and the session version
-- (raising it signs the person out everywhere else). It still cannot change who the person is, their role, which
-- organisation they belong to, or whether they are disabled, and the database still refuses a hash that is not in the pinned shape.
GRANT UPDATE (password_hash, session_version) ON staff_users TO saral_app;
