((root) => {
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

  function readName(source, cursor) {
    const start = cursor.index;
    while (cursor.index < source.length && /[\w:-]/.test(source[cursor.index])) cursor.index++;
    return source.slice(start, cursor.index);
  }

  function readDelimited(source, cursor, open, close) {
    if (source[cursor.index] !== open) return null;
    cursor.index++;
    const start = cursor.index;
    let quote = '';
    while (cursor.index < source.length) {
      const char = source[cursor.index++];
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === close) return source.slice(start, cursor.index - 1);
    }
    throw new Error(`Unclosed ${open} in abbreviation`);
  }

  function parseSequence(source, cursor, grouped = false) {
    const roots = [], parents = [roots];
    let expectTerm = true;
    while (cursor.index < source.length) {
      const next = source[cursor.index];
      if (next === ')' && grouped) { cursor.index++; return roots; }
      if (!expectTerm) {
        if (next === '>') { cursor.index++; const parent = parents.at(-1); const previous = parent.at(-1); if (!previous) throw new Error('A child operator needs an element before it'); parents.push(previous.children); }
        else if (next === '+') { cursor.index++; }
        else if (next === '^') { cursor.index++; if (parents.length === 1) throw new Error('The parent operator has no parent element'); parents.pop(); }
        else throw new Error(`Unexpected character "${next}" in abbreviation`);
        expectTerm = true;
        continue;
      }
      let nodes;
      if (next === '(') {
        cursor.index++;
        nodes = parseSequence(source, cursor, true);
        if (!nodes.length) throw new Error('An abbreviation group cannot be empty');
      } else {
        const node = { tag: '', id: '', classes: [], attributes: [], text: '', children: [] };
        node.tag = readName(source, cursor) || 'div';
        while (cursor.index < source.length) {
          const char = source[cursor.index];
          if (char === '.' || char === '#') {
            cursor.index++;
            const value = readName(source, cursor);
            if (!value) throw new Error(`Expected a name after "${char}"`);
            if (char === '.') node.classes.push(value); else node.id = value;
          } else if (char === '[') {
            const attrs = readDelimited(source, cursor, '[', ']');
            for (const item of attrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
              node.attributes.push([item[1], item[2] ?? item[3] ?? item[4] ?? null]);
            }
          } else if (char === '{') node.text += readDelimited(source, cursor, '{', '}');
          else break;
        }
        nodes = [node];
      }
      let count = 1;
      if (source[cursor.index] === '*') {
        cursor.index++;
        const digits = readName(source, cursor);
        if (!/^\d+$/.test(digits) || Number(digits) < 1 || Number(digits) > 100) throw new Error('Repeat counts must be between 1 and 100');
        count = Number(digits);
      }
      for (let repeat = 0; repeat < count; repeat++) {
        const copies = repeat === 0 ? nodes : nodes.map(node => structuredClone(node));
        parents.at(-1).push(...copies);
      }
      expectTerm = false;
    }
    if (grouped) throw new Error('Unclosed abbreviation group');
    if (expectTerm && roots.length) throw new Error('The abbreviation ends with an incomplete operator');
    return roots;
  }

  function renderNode(node, depth) {
    const pad = '  '.repeat(depth);
    const attrs = [...node.attributes];
    if (node.id) attrs.unshift(['id', node.id]);
    if (node.classes.length) attrs.unshift(['class', node.classes.join(' ')]);
    const attrText = attrs.map(([name, value]) => value === null ? ` ${name}` : ` ${name}="${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join('');
    const opening = `<${node.tag}${attrText}>`;
    if (voidTags.has(node.tag.toLowerCase())) return `${pad}${opening}`;
    if (!node.children.length) return `${pad}${opening}${node.text}</${node.tag}>`;
    const content = node.text ? `${node.text}\n` : '';
    return `${pad}${opening}\n${content}${node.children.map(child => renderNode(child, depth + 1)).join('\n')}\n${pad}</${node.tag}>`;
  }

  function expandHtml(abbreviation) {
    if (abbreviation === '!') return '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Document</title>\n</head>\n<body>\n\n</body>\n</html>';
    const cursor = { index: 0 };
    const nodes = parseSequence(abbreviation, cursor);
    if (cursor.index !== abbreviation.length || !nodes.length) throw new Error('This HTML abbreviation is not supported');
    return nodes.map(node => renderNode(node, 0)).join('\n');
  }

  function cssLength(value) {
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value) === 0 ? '0' : `${value}px`;
    return value;
  }

  function expandCss(abbreviation) {
    const exact = {
      df: 'display: flex;', di: 'display: inline;', dib: 'display: inline-block;', dn: 'display: none;', db: 'display: block;', dg: 'display: grid;',
      aic: 'align-items: center;', ais: 'align-items: flex-start;', aie: 'align-items: flex-end;', jcc: 'justify-content: center;', jcsb: 'justify-content: space-between;',
      fdc: 'flex-direction: column;', fdr: 'flex-direction: row;', fww: 'flex-wrap: wrap;', posr: 'position: relative;', posa: 'position: absolute;', posf: 'position: fixed;',
      m0: 'margin: 0;', p0: 'padding: 0;', tac: 'text-align: center;', tal: 'text-align: left;', tar: 'text-align: right;', bsh: 'box-shadow: 0 2px 8px rgba(0, 0, 0, .15);'
    };
    if (exact[abbreviation]) return exact[abbreviation];
    const box = abbreviation.match(/^(m|mt|mr|mb|ml|p|pt|pr|pb|pl)(-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)?)(?:[- ](-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)?))?$/);
    if (box) {
      const properties = { m: 'margin', mt: 'margin-top', mr: 'margin-right', mb: 'margin-bottom', ml: 'margin-left', p: 'padding', pt: 'padding-top', pr: 'padding-right', pb: 'padding-bottom', pl: 'padding-left' };
      const unit = value => /(px|rem|em|%|vh|vw)$/i.test(value) ? value : cssLength(value);
      return `${properties[box[1]]}: ${unit(box[2])}${box[3] ? ` ${unit(box[3])}` : ''};`;
    }
    const values = [
      [/^(w|h|minw|minh|maxw|maxh|fs|fw|lh|gap|r|z|op)(.+)$/, (_match, key, value) => {
        const property = { w: 'width', h: 'height', minw: 'min-width', minh: 'min-height', maxw: 'max-width', maxh: 'max-height', fs: 'font-size', fw: 'font-weight', lh: 'line-height', gap: 'gap', r: 'border-radius', z: 'z-index', op: 'opacity' }[key];
        return `${property}: ${['fw', 'z', 'op'].includes(key) ? value : cssLength(value)};`;
      }],
      [/^(c|bgc)(#[\da-f]{3,8}|[a-z][\w-]*|var\(.+\))$/i, (_match, key, value) => `${key === 'c' ? 'color' : 'background-color'}: ${value};`],
      [/^bd(\d+)(#[\da-f]{3,8})?$/i, (_match, width, color) => `border: ${width}px solid ${color || 'currentColor'};`]
    ];
    for (const [pattern, format] of values) { const match = abbreviation.match(pattern); if (match) return format(...match); }
    throw new Error('This CSS abbreviation is not supported');
  }

  const api = { expandHtml, expandCss };
  root.dreamEmmet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
