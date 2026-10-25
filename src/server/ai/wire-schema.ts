import "server-only";
import type { JsonObject } from "../../domain/common";
import { canonicalJson } from "./json";

/** Canonical schema instructions with application validation; this does not claim provider-native schema enforcement. */
export const WIRE_SCHEMA_VERSION="prompt-canonical-json-schema-local-validation-v1";
export function providerWireSchema(schema:JsonObject):JsonObject{
  canonicalJson(schema,65536);
  return schema;
}
