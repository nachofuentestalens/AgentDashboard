import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ModelCatalog } from "@ad/shared";
import { buildApp, type App } from "../src/app.ts";
import { discoverCodexModels, loadModelCatalog } from "../src/model-catalog.ts";
import { FAKE_CODEX } from "../src/codex.ts";
import { api, tempDir } from "./helpers.ts";

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const fake = { command: process.execPath, prefix: [FAKE_CODEX], display: "fake" };

it("loads five ordered models once per startup and refreshes after restart", async () => {
  const dataDir = tempDir("ad-model-start-");
  const app = await buildApp({ dataDir, launchers: { codex: fake } });
  apps.push(app);
  const first = (await api<ModelCatalog>(app, "GET", "/api/models")).body;
  expect(first.presets.codex.map((m) => m.id)).toEqual([1, 2, 3, 4, 5].map((i) => `demo-model-${i}`));
  expect(first.codex.source).toBe("cli");
  expect((await api<ModelCatalog>(app, "GET", "/api/models")).body).toEqual(first);
  await apps.pop()!.close();
  const next = await buildApp({ dataDir, launchers: { codex: fixture([{ model: "new-release", displayName: "New Release" }]) } });
  apps.push(next);
  expect((await api<ModelCatalog>(next, "GET", "/api/models")).body.presets.codex).toEqual([{ id: "new-release", label: "New Release" }]);
});

function fixture(data: unknown[], mode = "normal") {
  const file = path.join(tempDir("ad-model-cli-"), "cli.mjs");
  fs.writeFileSync(
    file,
    `
    import readline from 'node:readline';
    for await (const line of readline.createInterface({input:process.stdin})) {
      const r=JSON.parse(line);
      if (${JSON.stringify(mode)} === 'timeout') continue;
      if (r.method==='initialize') console.log(JSON.stringify({id:r.id,result:{}}));
      else if(r.method==='model/list') console.log(JSON.stringify({id:r.id,result:{data:r.params.cursor ? [{model:'page-two',displayName:'Page Two'}] : ${JSON.stringify(data)},nextCursor:!r.params.cursor && ${JSON.stringify(mode)}==='pages' ? 'next' : null}}));
      else if(r.method!=='initialized') process.exit(2);
    }
  `,
  );
  return { command: process.execPath, prefix: [file], display: "test fixture" };
}

it("filters hidden, duplicate and invalid IDs while preserving order and following pagination", async () => {
  const models = await discoverCodexModels(
    fixture(
      [{ model: "hidden", hidden: true }, { model: "first", displayName: "First" }, { model: "first" }, { model: "invalid id" }, null, { model: "second" }],
      "pages",
    ),
  );
  expect(models.map((m) => m.id)).toEqual(["first", "second", "page-two"]);
});

it("keeps the last good list on failure and avoids a hardcoded fallback on first startup", async () => {
  const dir = tempDir("ad-model-cache-");
  const missing = { command: path.join(dir, "missing.exe"), prefix: [], display: "missing" };
  const empty = await loadModelCatalog(dir, "", missing);
  expect(empty.codex.source).toBe("unavailable");
  expect(empty.presets.codex).toEqual([]);
  const good = await loadModelCatalog(dir, "", fake);
  const cached = await loadModelCatalog(dir, "", missing);
  expect(cached.codex.source).toBe("cache");
  expect(cached.codex.error).toContain("last saved list");
  expect(cached.presets.codex).toEqual(good.presets.codex);
});

it("bounds a hung metadata request without starting inference", async () => {
  await expect(discoverCodexModels(fixture([], "timeout"), 100)).rejects.toThrow("timed out");
});
