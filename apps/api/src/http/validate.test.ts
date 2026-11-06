import { BadRequestException } from "@nestjs/common";
import { normalizeIdentifier, objectBody, uuidParam } from "./validate.js";

describe("validation helpers", () => {
  test("normalizes phone numbers and email addresses so the same person has one pseudonym", () => {
    expect(normalizeIdentifier(" +91 98765-43210 ")).toBe("+919876543210");
    expect(normalizeIdentifier("Person@Example.ORG ")).toBe("person@example.org");
  });

  test.each(["", "9876543210", "+12", "not an id", "a@b", "+91 98765 43210 99999999"])("rejects the identifier %p", (v) => {
    expect(() => normalizeIdentifier(v)).toThrow(BadRequestException);
  });

  test("objectBody accepts objects only", () => {
    expect(objectBody({ a: 1 })).toEqual({ a: 1 });
    for (const v of [null, undefined, [], "x", 5]) expect(() => objectBody(v)).toThrow(BadRequestException);
  });

  test("uuidParam accepts lowercase UUIDs only", () => {
    expect(uuidParam("11111111-1111-4111-8111-111111111111", "id")).toBe("11111111-1111-4111-8111-111111111111");
    for (const v of ["", "nope", "11111111-1111-4111-8111-11111111111G", "11111111-1111-4111-8111-111111111111 "]) {
      expect(() => uuidParam(v, "id")).toThrow(BadRequestException);
    }
  });
});
