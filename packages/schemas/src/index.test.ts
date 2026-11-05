import { CANONICAL_SCHEMA_VERSION, RECEIPT_SPEC_VERSION } from "./index";

test("canonical schema version starts at 1", () => {
  expect(CANONICAL_SCHEMA_VERSION).toBe(1);
});

test("receipt spec is Kantara KI-CR-v1.1.0", () => {
  expect(RECEIPT_SPEC_VERSION).toBe("KI-CR-v1.1.0");
});
