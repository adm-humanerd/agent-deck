import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { applyConsoleLayout } from "../scripts/build/apply-console-layout.mjs";
import { buildDeck } from "../scripts/build/apply-mk2.mjs";

const html = await fs.readFile(
  new URL("../src/deck/index.html", import.meta.url),
  "utf8",
);
const css = await fs.readFile(
  new URL("../src/deck/streamdeck-feel.css", import.meta.url),
  "utf8",
);

test("canonical console source is embedded once and regeneration is idempotent", async () => {
  assert.ok(html.includes(css.trimEnd()));
  assert.equal(await applyConsoleLayout(html), html);
  assert.equal(
    html.split("/* Stream Deck Physical Hardware & Dynamic Keycap Styling */")
      .length,
    2,
  );
});
test('full rebuild is idempotent and retains shared layout auth, recovery and arbitrary pages',async()=>{
 const rebuilt=await buildDeck(html);
 assert.equal(rebuilt,html);
 assert.equal(await buildDeck(rebuilt),rebuilt);
 assert.match(rebuilt,/setDeckAccess\(info\)/);
 assert.match(rebuilt,/await loadSharedLayouts\(\)/);
 assert.doesNotMatch(rebuilt,/localStorage\.setItem|normalizeDeckLayouts/);
 const client=await fs.readFile(new URL('../src/deck/deck-client.js',import.meta.url),'utf8');
 assert.ok(rebuilt.includes(client.trimEnd()));
 assert.doesNotMatch(rebuilt,/mountDeckSessionPager|deck-key-face|deck-key-pager|deck-pager-key/);
 for(const file of ['../src/deck/deck-input.js','../src/deck/deck-send.js','../src/deck/deck-layout.mjs']){const source=(await fs.readFile(new URL(file,import.meta.url),'utf8')).replace(/^export /gm,'').trimEnd();assert.ok(rebuilt.includes(source),file);}
 await assert.rejects(buildDeck('<html>old backup</html>'),/template anchors missing/);
});

test("console update preserves scripts, pairing controls and live state code exactly", async () => {
  const before =
    '<style>/* Stream Deck Physical Hardware & Dynamic Keycap Styling */old overrides</style><script>liveState()</script><dialog id="connectDialog"></dialog>';
  const result = await applyConsoleLayout(before);
  assert.ok(
    result.endsWith(
      '</style><script>liveState()</script><dialog id="connectDialog"></dialog>',
    ),
  );
  assert.ok(!result.includes("old overrides"));
});

test("builder applies console geometry after icon styles instead of reviving conflicting geometry", async () => {
  const builder = await fs.readFile(
    new URL("../scripts/build/apply-mk2.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    builder.indexOf("html=await applyConsoleLayout(html)") >
      builder.indexOf("html=await applyAgentIcons(html)"),
  );
  assert.match(html, /viewport-fit=cover/);
});

test("malformed existing stylesheet is rejected rather than truncating application code", async () => {
  await assert.rejects(
    applyConsoleLayout(
      "<style>/* Stream Deck Physical Hardware & Dynamic Keycap Styling */",
    ),
    /closing tag missing/,
  );
});
test("profile controls remain touch accessible and geometry reserves pager space",()=>{
  assert.match(css,/\.deck-layout-toolbar:not\(\[hidden\]\)\s*\{\s*display: flex !important/);
  assert.match(css,/var\(--deck-available-height\) - 250px/);
  assert.match(css,/\.below-bank\s*\{[^}]*padding: 0 !important/s);
  assert.doesNotMatch(html,/id="quotaKeys"|class="quota-keys"/);
  assert.match(html,/id="showDeckRequest"/);
});
