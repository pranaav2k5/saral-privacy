import "reflect-metadata";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { DiscoveryModule, DiscoveryService } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { parse } from "yaml";
import { ACCESS_KEY, type AccessRule } from "../../src/auth/access.js";
import { AppModule } from "../../src/app.module.js";

const SPEC_PATH = fileURLToPath(new URL("../../../../docs/design/openapi.yaml", import.meta.url));
const spec = parse(readFileSync(SPEC_PATH, "utf8")) as {
  paths: Record<string, Record<string, { operationId?: string; "x-access"?: string; "x-scopes"?: string[]; security?: unknown[] }>>;
};

const METHODS: Record<number, string> = { [RequestMethod.GET]: "get", [RequestMethod.POST]: "post", [RequestMethod.DELETE]: "delete", [RequestMethod.PATCH]: "patch" };
const join = (...parts: string[]): string => "/" + parts.flatMap((p) => p.split("/")).filter(Boolean).join("/");

interface Route {
  key: string;
  rule: AccessRule | undefined;
}

async function nestRoutes(): Promise<Route[]> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
  const routes: Route[] = [];
  for (const wrapper of moduleRef.get(DiscoveryService).getControllers()) {
    const type = wrapper.metatype as (new (...a: never[]) => unknown) | null;
    if (type === null) continue;
    const prefix = (Reflect.getMetadata(PATH_METADATA, type) as string | undefined) ?? "";
    for (const name of Object.getOwnPropertyNames(type.prototype)) {
      if (name === "constructor") continue;
      const handler = (type.prototype as Record<string, unknown>)[name] as object;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (method === undefined) continue;
      const path = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? "";
      routes.push({
        key: `${METHODS[method] ?? String(method)} ${join(prefix, path).replace(/:(\w+)/g, "{$1}")}`,
        rule: Reflect.getMetadata(ACCESS_KEY, handler) as AccessRule | undefined,
      });
    }
  }
  await moduleRef.close();
  return routes;
}

type Json = Record<string, unknown>;

/** Every `$ref` in the document, wherever it appears. */
function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else refs(v, out);
    }
  }
  return out;
}

const resolve = (doc: Json, ref: string): unknown =>
  ref.replace(/^#\//, "").split("/").reduce<unknown>((n, part) => (n as Json | undefined)?.[part], doc);

describe("docs/design/openapi.yaml", () => {
  const doc = spec as unknown as Json;

  test("is a well-formed OpenAPI 3.1 document: every $ref resolves, operation ids are unique, path parameters are declared", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect((doc.info as Json).title).toBeTruthy();
    for (const ref of refs(doc)) expect({ ref, found: resolve(doc, ref) !== undefined }).toEqual({ ref, found: true });

    const ids: string[] = [];
    const components = doc.components as { parameters: Record<string, { name: string; in: string }> };
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops as Record<string, Json>)) {
        ids.push(op.operationId as string);
        expect({ op: `${method} ${path}`, responses: Object.keys((op.responses as Json) ?? {}).length > 0 }).toEqual({ op: `${method} ${path}`, responses: true });
        const declared = ((op.parameters as { $ref?: string; name?: string }[] | undefined) ?? []).map((p) =>
          p.$ref ? components.parameters[p.$ref.split("/").pop() as string]?.name : p.name,
        );
        for (const m of path.matchAll(/\{(\w+)\}/g)) expect({ op: `${method} ${path}`, param: m[1], declared: declared.includes(m[1]) }).toEqual({ op: `${method} ${path}`, param: m[1], declared: true });
      }
    }
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("describes exactly the routes the API serves, with the access rule each route enforces", async () => {
    const documented = new Map<string, { access: string }>();
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const access = op["x-access"] === "public" ? "public" : `scopes:${[...(op["x-scopes"] ?? [])].sort().join(",")}`;
        documented.set(`${method} ${path}`, { access });
        // A scoped operation must say it needs a key; a public one must not.
        expect({ op: `${method} ${path}`, secured: (op.security ?? []).length > 0 }).toEqual({ op: `${method} ${path}`, secured: access !== "public" });
      }
    }
    const served = new Map<string, { access: string }>();
    for (const r of await nestRoutes()) {
      expect({ route: r.key, hasRule: r.rule !== undefined }).toEqual({ route: r.key, hasRule: true });
      served.set(r.key, { access: r.rule?.public ? "public" : `scopes:${[...(r.rule?.scopes ?? [])].sort().join(",")}` });
    }
    expect(Object.fromEntries(served)).toEqual(Object.fromEntries(documented));
  });
});
