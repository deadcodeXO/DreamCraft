import fs from 'node:fs';
import path from 'node:path';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error('Usage: node build-browser-compat-index.mjs <MDN data.json> <output.json>');
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const browsers = ['chrome', 'edge', 'firefox', 'safari'];

function latestStable(name) {
  const releases = source.browsers[name].releases;
  const current = Object.entries(releases).filter(([, release]) => release.status === 'current');
  current.sort(([left], [right]) => compareVersions(left, right));
  return current.at(-1)?.[0] || '';
}

function compareVersions(left, right) {
  const a = String(left).split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
  const b = String(right).split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function supportFor(support, browser) {
  let entry = support?.[browser];
  if (!entry) return null;
  const alternatives = Array.isArray(entry) ? entry : [entry];
  const standard = alternatives.filter(item => !item.prefix);
  const candidates = standard.length ? standard : alternatives;
  candidates.sort((left, right) => {
    const a = left.version_added === true ? '0' : String(left.version_added ?? '999999');
    const b = right.version_added === true ? '0' : String(right.version_added ?? '999999');
    return compareVersions(a.replace(/^≤/, ''), b.replace(/^≤/, ''));
  });
  entry = candidates[0];
  if (!entry) return null;
  return [entry.version_added ?? null, entry.version_removed ?? null, Boolean(entry.partial_implementation), entry.prefix || '', Boolean(entry.flags)];
}

function featureRecord(feature) {
  const support = feature?.__compat?.support;
  if (!support) return null;
  return browsers.map(browser => supportFor(support, browser));
}

function walk(node, pathParts, output) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const record = featureRecord(node);
  if (record) output[pathParts.join('.')] = record;
  for (const [name, child] of Object.entries(node)) {
    if (name !== '__compat' && child && typeof child === 'object') walk(child, [...pathParts, name], output);
  }
}

const css = {};
for (const name of ['properties', 'selectors', 'at-rules']) {
  css[name] = {};
  walk(source.css[name], [], css[name]);
}

const html = { elements: {}, globalAttributes: {}, elementAttributes: {} };
for (const [name, feature] of Object.entries(source.html.elements)) {
  const record = featureRecord(feature);
  if (record) html.elements[name] = record;
  for (const [attribute, attributeFeature] of Object.entries(feature)) {
    if (attribute === '__compat') continue;
    const attributeRecord = featureRecord(attributeFeature);
    if (attributeRecord) html.elementAttributes[`${name}.${attribute}`] = attributeRecord;
  }
}
walk(source.html.global_attributes, [], html.globalAttributes);

const javascript = {
  builtins: {},
  operators: {},
  statements: {},
  functions: {},
  classes: {},
  grammar: {},
  regularExpressions: {},
  apis: {}
};
for (const name of ['builtins', 'operators', 'statements', 'functions', 'classes', 'grammar', 'regular_expressions']) {
  const outputName = name === 'regular_expressions' ? 'regularExpressions' : name;
  walk(source.javascript[name], [], javascript[outputName]);
}
walk(source.api, [], javascript.apis);

const output = {
  metadata: {
    source: 'MDN Browser Compatibility Data',
    packageVersion: source.__meta.version,
    generatedAt: source.__meta.timestamp,
    license: 'CC0-1.0',
    browsers
  },
  currentVersions: Object.fromEntries(browsers.map(name => [name, latestStable(name)])),
  css,
  html,
  javascript
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output));
console.log(JSON.stringify({ outputPath, bytes: fs.statSync(outputPath).size, packageVersion: source.__meta.version, currentVersions: output.currentVersions }));
