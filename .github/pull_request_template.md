## What and why

## Checklist

- [ ] Failing test written first, now passing
- [ ] `pnpm verify` passes (and `uv run pytest` / `terraform test` where relevant)
- [ ] Threat-model checkbox: no new trust boundary, or `docs/threat-model/` updated
- [ ] RoPA impact: no new personal data, purpose, or retention, or RoPA updated
- [ ] Audit event added for every new user-facing action
- [ ] `docs/compliance/traceability.md` updated if a DPDP requirement is touched
- [ ] No secrets, keys, or personal data in the diff
