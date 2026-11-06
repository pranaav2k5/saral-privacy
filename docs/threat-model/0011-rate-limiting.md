# Threat model 0011: rate limiting

Status: draft, covers `apps/api/src/ratelimit`, the two global guards, and `TRUST_PROXY`. Contract: the rate-limit paragraph in `docs/design/openapi.yaml`.

## Scope

Limits on how fast one address, one API key or one staff session can call the API. Out of scope: per-account lockout after failed sign-ins (threat model 0008), limits that are shared between instances, limits that tenants can configure, and a web application firewall.

## Assets

The availability of the API for tenants and their users, the CPU spent on password hashing, and the database connection pool.

## Trust boundaries

Internet to load balancer to API. The only address the API can trust is the one the load balancer forwards, and only if the deployment says how many proxies there are.

## Threats

| STRIDE | Threat | Mitigation | Proof |
|---|---|---|---|
| Denial of service | A flood of sign-in attempts spends the CPU on password hashing and locks real people out. | The three sign-in routes are limited to 10 a minute per address, and the limit is applied before the account or the password is looked at. | `ratelimit.e2e.test.ts` (sign-in routes) |
| Denial of service | A flood of requests with made-up keys exhausts the database pool. | The address limit runs before the key is looked up. After the limit, requests do not reach the database. | `ratelimit.e2e.test.ts` (a flood of made-up keys never reaches the database) |
| Denial of service | One publishable key, public in a web page, is used to flood a tenant's consent endpoint. | 1200 requests a minute per key, from any number of addresses. Other keys are not affected. | `ratelimit.e2e.test.ts` (a key) |
| Spoofing | A caller claims to be another address with `X-Forwarded-For` to get a fresh limit each time. | The header is ignored unless `TRUST_PROXY` states how many proxies to believe. A value that is not a number from 0 to 10 stops the app from starting. | `ratelimit.e2e.test.ts` (no proxy in front), `config.test.ts` |
| Denial of service | A caller with an IPv6 /64 rotates through billions of addresses. | An IPv6 address is counted by its /64. | `client-key.test.ts` |
| Denial of service | A flood of different addresses grows the counters without end. | At most 100000 counters. When full, expired ones go first and then the oldest. | `limiter.test.ts` |
| Denial of service | The load balancer's health check is refused and a healthy instance is taken out of service. | `/healthz` is never limited. | `ratelimit.e2e.test.ts` |
| Denial of service (self-inflicted) | Behind a load balancer with `TRUST_PROXY` unset, every caller has the balancer's address and the whole service is limited together. | The failure is safe (nobody can exceed the limits) and visible. The deployment must set `TRUST_PROXY`. | LLD section 6.1 |
| Information disclosure | A refusal reveals which keys exist. | The key limit applies only after authentication, so it says nothing about unknown keys. Refusals by address say nothing about the account. | `ratelimit.e2e.test.ts` (a wrong key is not counted) |

## Residual risk

- Counters are in each instance's memory. With N instances a caller can make up to N times the limit, and a restart clears them. A shared store would fix it. It is planned work and needs a decision about the dependency.
- A determined attacker with many addresses is slowed, not stopped. The limits are a first layer; a web application firewall is the second.
- The numbers (600, 10, 1200 a minute) are a first estimate. A busy tenant may need more for its key, and there is no per-tenant setting yet.
- A consent can still be submitted for someone else's identifier through a publishable key (threat model 0004). The limit bounds how fast, not whether.
