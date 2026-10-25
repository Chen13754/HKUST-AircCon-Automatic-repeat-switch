import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API_BASE, SITE_ORIGIN } from "../api-config.js";

test("extension API uses the production URL in the saved school bundle", () => {
  const bundle = readFileSync(new URL("../../HKUST - Smart Power Meter Infrastructure Student Panel_files/main.c005f61e.chunk.js.下载", import.meta.url), "utf8");
  const match = bundle.match(/prod:\{api:"([^"]+)"/);
  assert.ok(match, "saved school bundle must contain a production API URL");
  assert.equal(API_BASE, match[1]);
  assert.equal(new URL(API_BASE).origin, SITE_ORIGIN);
});
