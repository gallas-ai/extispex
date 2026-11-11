/// <reference lib="deno.ns" />
import { assertEquals } from "@std/assert";
import * as contracts from "@extispex/contracts";
import {
  MAXIMUM_RETENTION_DAYS,
  MINIMUM_PASSWORD_LENGTH,
  MINIMUM_RETENTION_DAYS,
  ROLES,
  SCIM_BASE_PATH,
} from "./access-rules.ts";

Deno.test("keeps the UI's copies of the access rules equal to the contracts", () => {
  assertEquals(ROLES, contracts.ROLES);
  assertEquals(MINIMUM_PASSWORD_LENGTH, contracts.MINIMUM_PASSWORD_LENGTH);
  assertEquals(SCIM_BASE_PATH, contracts.SCIM_BASE_PATH);
  assertEquals(MINIMUM_RETENTION_DAYS, contracts.MINIMUM_RETENTION_DAYS);
  assertEquals(MAXIMUM_RETENTION_DAYS, contracts.MAXIMUM_RETENTION_DAYS);
});
