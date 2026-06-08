const fs = require('fs');
const path = require('path');
const assert = require('assert');

const script = fs.readFileSync(path.join(__dirname, '..', 'tampermonkey_script.js'), 'utf8');

function extractConst(name) {
  const match = script.match(new RegExp(`const ${name} = '([^']+)';`));
  assert(match, `Could not find ${name}`);
  return match[1];
}

function extractCssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = script.match(new RegExp(`${escaped}[\\s\\S]*?\\{([\\s\\S]*?)\\n\\s*\\}`, 'm'));
  assert(match, `Could not find CSS rule for ${selector}`);
  return match[1];
}

const inlineRowStyle = extractConst('rowStyle');
const inlineValueStyle = extractConst('valStyle');
const cssRowRule = extractCssRule('div[class*="ProductSnippet__"] .lavka-kbzhu-row,');
const cssValueRule = extractCssRule('div[class*="ProductSnippet__"] .lavka-kbzhu-val,');
const inlineBoxStyle = script.match(/kbzhuBox\.setAttribute\('style', '([^']+)'\);/);

assert(inlineBoxStyle, 'Could not find inline KBZHU box style');

for (const [source, style] of [
  ['inline row style', inlineRowStyle],
  ['injected row CSS', cssRowRule],
]) {
  assert.match(
    style,
    /justify-content:\s*space-between !important/,
    `${source} should distribute content-sized nutrition cells across the row`
  );
}

for (const [source, style] of [
  ['inline value style', inlineValueStyle],
  ['injected value CSS', cssValueRule],
]) {
  assert.match(
    style,
    /flex:\s*0 0 auto !important/,
    `${source} should size each nutrition value by its own content`
  );
  assert.match(
    style,
    /min-width:\s*max-content !important/,
    `${source} should reserve enough width for full numeric tokens`
  );
  assert.doesNotMatch(
    style,
    /overflow:\s*hidden !important/,
    `${source} should not clip digits inside a nutrition value`
  );
}

for (const [source, style] of [
  ['inline box style', inlineBoxStyle[1]],
  ['injected box CSS', extractCssRule('div[class*="ProductSnippet__"] .lavka-kbzhu-box,')],
]) {
  assert.match(
    style,
    /container-type:\s*inline-size !important/,
    `${source} should expose card width for responsive row sizing`
  );
}

assert.match(script, /const KBZHU_MAX_FONT_SIZE = 10;/, 'Expected max row font-size constant');
assert.match(script, /const KBZHU_MIN_FONT_SIZE = 7;/, 'Expected min row font-size constant');
assert.match(script, /function fitKbzhuRows\(kbzhuBox\)/, 'Expected a row font-size fitting helper');
assert.match(script, /scrollWidth > row\.clientWidth/, 'Fitting helper should detect row overflow');
assert.match(script, /fitKbzhuRows\(kbzhuBox\);/, 'Rendered KBZHU rows should be fitted after insertion');

assert.match(script, /enabled:\s*true/, 'Default settings should enable KBZHU loading and rendering');
assert.match(script, /function isKbzhuEnabled\(\)/, 'Expected helper for the global KBZHU enabled flag');
assert.match(script, /function removeKbzhuFromCards\(\)/, 'Expected helper to remove rendered KBZHU blocks when disabled');
assert.match(script, /if \(!isKbzhuEnabled\(\)\) return;/, 'Queueing should stop when KBZHU is disabled');
assert.match(script, /fetchQueue\.length = 0;/, 'Pending requests should be discarded when KBZHU is disabled');
assert.match(script, /if \(!isKbzhuEnabled\(\)\) \{\s*removeKbzhuFromCards\(\);\s*return;\s*\}/, 'Card scanning should clean up and stop when disabled');
assert.match(script, /id="kbzhu-enabled-chk"/, 'Settings UI should include a global enable checkbox');
assert.match(script, /enabled: document\.getElementById\('kbzhu-enabled-chk'\)\.checked/, 'Settings save should persist the global enable flag');
