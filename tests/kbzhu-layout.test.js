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
