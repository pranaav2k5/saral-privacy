import { ConflictException, Controller, Get, NotFoundException, Query } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { AuditService } from "./audit.service.js";

@Controller("v1/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Recomputes the tenant's hash chain (all of it, or one UTC day) and reports the first entry that does not match. */
  @Get("verify")
  @Scopes("auditor")
  verify(@Auth() auth: AuthContext, @Query("date") date?: string) {
    return this.audit.verify(auth.tenantId, date);
  }

  /** One UTC day of the tenant's audit entries, for checking against that day's anchor (outside Saral, with `saral-audit-verify`). */
  @Get("entries")
  @Scopes("auditor")
  entries(@Auth() auth: AuthContext, @Query("date") date?: string) {
    return this.audit.entries(auth.tenantId, date as string);
  }

  /** The anchor (count, head hash and Merkle root) for one UTC day. */
  @Get("merkle-root")
  @Scopes("auditor")
  async merkleRoot(@Auth() auth: AuthContext, @Query("date") date?: string) {
    const result = await this.audit.anchor(auth.tenantId, date as string);
    if (result === null) throw new NotFoundException({ error: "not_found", message: "no audit entries on that day" });
    if ("failure" in result) throw new ConflictException({ error: "chain_invalid", failure: result.failure, seqNo: result.seqNo });
    return result.anchor;
  }
}
