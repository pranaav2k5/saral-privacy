import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Auth, Scopes, type AuthContext } from "../auth/access.js";
import { bad, objectBody, uuidParam } from "../http/validate.js";
import { RopaError, parseRopaDocument, type RopaDocument } from "./ropa-document.js";
import { MAX_VERSIONS, RopaService } from "./ropa.service.js";

function parseBody(raw: unknown): { document: RopaDocument; note?: string; basedOn?: number } {
  const body = objectBody(raw);
  for (const key of Object.keys(body)) if (key !== "document" && key !== "note" && key !== "basedOn") throw bad(key, "is not part of the request");
  if (body.document === undefined) throw bad("document", "must be the record");
  let note: string | undefined;
  if (body.note !== undefined) {
    if (typeof body.note !== "string" || body.note.trim().length < 1 || body.note.trim().length > 500) throw bad("note", "must be text of 1 to 500 characters");
    note = body.note.trim();
  }
  let basedOn: number | undefined;
  if (body.basedOn !== undefined) {
    if (typeof body.basedOn !== "number" || !Number.isInteger(body.basedOn) || body.basedOn < 0 || body.basedOn > MAX_VERSIONS) {
      throw bad("basedOn", `must be a whole number from 0 to ${String(MAX_VERSIONS)}: the version the change started from, or 0 when nothing had been saved`);
    }
    basedOn = body.basedOn;
  }
  try {
    return { document: parseRopaDocument(body.document), ...(note === undefined ? {} : { note }), ...(basedOn === undefined ? {} : { basedOn }) };
  } catch (e) {
    if (e instanceof RopaError) throw bad(e.field === "body" ? "document" : `document.${e.field}`, e.message);
    throw e;
  }
}

/** The organisation's record of processing. The officer and the administrator may both keep it. */
@Controller("v1/ropa")
export class RopaController {
  constructor(private readonly ropa: RopaService) {}

  @Post()
  @Scopes("dpo", "tenant_admin")
  save(@Auth() auth: AuthContext, @Body() raw: unknown) {
    const { document, note, basedOn } = parseBody(raw);
    return this.ropa.create(auth.tenantId, auth, document, note, basedOn);
  }

  @Get()
  @Scopes("dpo", "tenant_admin")
  list(@Auth() auth: AuthContext) {
    return this.ropa.list(auth.tenantId);
  }

  @Get("latest")
  @Scopes("dpo", "tenant_admin")
  latest(@Auth() auth: AuthContext) {
    return this.ropa.get(auth.tenantId, "latest");
  }

  @Get(":id")
  @Scopes("dpo", "tenant_admin")
  one(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.ropa.get(auth.tenantId, uuidParam(id, "id"));
  }
}
