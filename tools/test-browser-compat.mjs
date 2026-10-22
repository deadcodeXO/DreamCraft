import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compatibilityReasons, compareVersions } from '../assets/compatibility.mjs';
import { analyzeCss } from '../assets/css-analyzer.mjs';
import { analyzeJavaScript } from '../assets/js-analyzer.mjs';

const data = JSON.parse(await readFile(new URL('../assets/vendor/browser-compat/index.json', import.meta.url), 'utf8'));
const browsers = data.metadata.browsers;
assert.equal(data.metadata.source, 'MDN Browser Compatibility Data');
assert.equal(data.metadata.license, 'CC0-1.0');
assert.deepEqual(browsers, ['chrome', 'edge', 'firefox', 'safari']);
assert.ok(Object.keys(data.css.properties).length > 1000);
assert.ok(data.html.elements.dialog);
assert.ok(data.javascript.builtins['Promise.allSettled']);
assert.ok(data.javascript.operators.optional_chaining);

const latest = { ...data.currentVersions };
assert.deepEqual(compatibilityReasons(data.html.elements.dialog, browsers, latest), []);

const oldTargets = { chrome: '36', edge: '78', firefox: '97', safari: '15' };
const dialogReasons = compatibilityReasons(data.html.elements.dialog, browsers, oldTargets);
assert.equal(dialogReasons.length, 4);
assert.ok(dialogReasons.some(reason => reason.includes('Safari 15: added in 15.4')));

const backdropFilterReasons = compatibilityReasons(data.css.properties['backdrop-filter'], browsers, { ...latest, safari: '17' });
assert.ok(backdropFilterReasons.some(reason => reason.includes('Safari 17: added in 18')));
assert.equal(compareVersions('15.4', '15.3'), 1);

const parsedCss = await analyzeCss(`.layout {\n  display: grid;\n  grid-template-columns: repeat(2, 1fr);\n}\n@supports (backdrop-filter: blur(2px)) {\n  .panel:has(img) { color: red; }\n}`);
assert.ok(parsedCss.declarations.some(item => item.name === 'display' && item.value === 'grid' && item.line === 1));
assert.ok(parsedCss.atRules.some(item => item.name === 'supports' && item.line === 4));
assert.ok(parsedCss.selectors.some(item => item.value === '.panel:has(img)' && item.line === 5));

const jsFeatures = await analyzeJavaScript('const result = object?.value ?? Promise.allSettled([]); document.querySelector("main");', 'app.js', data.javascript);
assert.ok(jsFeatures.some(item => item.category === 'operators' && item.name === 'optional_chaining'));
assert.ok(jsFeatures.some(item => item.category === 'builtins' && item.name === 'Promise.allSettled'));
assert.ok(jsFeatures.some(item => item.category === 'apis' && item.name === 'Document.querySelector'));

console.log(`Browser compatibility index ${data.metadata.packageVersion}: ${Object.keys(data.css.properties).length} CSS features and ${Object.keys(data.html.elements).length} HTML elements verified.`);
