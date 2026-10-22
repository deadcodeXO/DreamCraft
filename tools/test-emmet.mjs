import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { expandHtml, expandCss } = require('../assets/emmet.js');

assert.equal(expandHtml('ul>li.item*3'), '<ul>\n  <li class="item"></li>\n  <li class="item"></li>\n  <li class="item"></li>\n</ul>');
assert.equal(expandHtml('main>(h1{A good idea}+p.note{Make it real})'), '<main>\n  <h1>A good idea</h1>\n  <p class="note">Make it real</p>\n</main>');
assert.equal(expandHtml('a[href="/work"][aria-label="View work"]{Explore}'), '<a href="/work" aria-label="View work">Explore</a>');
assert.match(expandHtml('!'), /<!doctype html>[\s\S]*<meta name="viewport"/);
assert.equal(expandCss('m10-20'), 'margin: 10px 20px;');
assert.equal(expandCss('w100%'), 'width: 100%;');
assert.equal(expandCss('bgc#fff'), 'background-color: #fff;');
assert.equal(expandCss('df'), 'display: flex;');
assert.throws(() => expandHtml('ul>'), /incomplete operator/);
assert.throws(() => expandCss('unknown-token'), /not supported/);
console.log('Emmet expansion checks passed.');
