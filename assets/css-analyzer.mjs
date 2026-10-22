import * as prettier from './vendor/prettier/standalone.mjs';
import * as postcss from './vendor/prettier/postcss.mjs';

export async function analyzeCss(code) {
  const { ast } = await prettier.__debug.parse(code, { parser: 'css', plugins: [postcss] });
  const declarations = [];
  const atRules = [];
  const selectors = [];
  const visit = node => {
    if (node.type === 'css-decl') declarations.push({ name: node.prop, value: node.value?.text || '', line: Math.max(0, (node.source?.start?.line || 1) - 1) });
    if (node.type === 'css-atrule') atRules.push({ name: node.name, params: node.raws?.params || '', line: Math.max(0, (node.source?.start?.line || 1) - 1) });
    if (node.type === 'css-rule') selectors.push({ value: node.raws?.selector || '', line: Math.max(0, (node.source?.start?.line || 1) - 1) });
    for (const child of node.nodes || []) visit(child);
  };
  visit(ast);
  return { declarations, atRules, selectors };
}
