import * as prettier from './vendor/prettier/standalone.mjs';
import * as babel from './vendor/prettier/babel.mjs';
import * as estree from './vendor/prettier/estree.mjs';
import * as typescript from './vendor/prettier/typescript.mjs';

const globalInterfaces = {
  document: 'Document', window: 'Window', navigator: 'Navigator', location: 'Location',
  history: 'History', screen: 'Screen', performance: 'Performance', crypto: 'Crypto',
  localstorage: 'Storage', sessionstorage: 'Storage', indexeddb: 'IDBFactory',
  customelements: 'CustomElementRegistry'
};

function staticPath(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ThisExpression') return [];
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return [];
  let property;
  if (!node.computed && node.property?.type === 'Identifier') property = node.property.name;
  else if (node.computed && ['StringLiteral', 'Literal', 'NumericLiteral'].includes(node.property?.type)) property = String(node.property.value);
  else return [];
  const object = staticPath(node.object);
  return object.length ? [...object, property] : [];
}

function collectDeclarations(ast) {
  const declared = new Set();
  const visitPattern = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier') declared.add(node.name.toLowerCase());
    else if (node.type === 'RestElement') visitPattern(node.argument);
    else if (node.type === 'AssignmentPattern') visitPattern(node.left);
    else if (node.type === 'ArrayPattern') node.elements.forEach(visitPattern);
    else if (node.type === 'ObjectPattern') node.properties.forEach(property => visitPattern(property.type === 'RestElement' ? property.argument : property.value));
  };
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator') visitPattern(node.id);
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') visitPattern(node.id);
    if (/Function/.test(node.type || '')) for (const parameter of node.params || []) visitPattern(parameter);
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') visitPattern(node.local);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments' || key === 'tokens') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
    }
  };
  visit(ast);
  return declared;
}

export async function analyzeJavaScript(code, filePath = 'script.js', compatibilityData) {
  const extension = filePath.split('.').pop().toLowerCase();
  const isTypeScript = ['ts', 'tsx'].includes(extension);
  const parser = isTypeScript ? 'typescript' : 'babel';
  const plugins = isTypeScript ? [typescript] : [babel, estree];
  const { ast } = await prettier.__debug.parse(code, { parser, plugins });
  const features = [];
  const seen = new Set();
  const add = (category, name, node) => {
    const line = Math.max(0, (node?.loc?.start?.line || 1) - 1);
    const key = `${category}:${name}:${line}`;
    if (!seen.has(key)) { seen.add(key); features.push({ category, name, line }); }
  };
  const declared = collectDeclarations(ast);
  const builtinIndex = new Map(Object.entries(compatibilityData?.builtins || {}).map(([name, record]) => [name.toLowerCase(), { name, record }]));
  const apiIndex = new Map(Object.entries(compatibilityData?.apis || {}).map(([name, record]) => [name.toLowerCase(), { name, record }]));
  const queryBuiltin = path => {
    const compact = path.filter(part => part.toLowerCase() !== 'prototype');
    const candidates = [compact.join('.').toLowerCase()];
    if (['window', 'globalthis', 'self'].includes(compact[0]?.toLowerCase())) candidates.unshift(compact.slice(1).join('.').toLowerCase());
    return candidates.map(candidate => builtinIndex.get(candidate)?.name).find(Boolean);
  };
  const queryApi = path => {
    const parts = [...path];
    const first = parts[0]?.toLowerCase();
    if (['window', 'globalthis', 'self'].includes(first)) parts.shift();
    const candidates = [parts.join('.').toLowerCase()];
    const interfaceName = globalInterfaces[parts[0]?.toLowerCase()];
    if (interfaceName) candidates.unshift([interfaceName, ...parts.slice(1)].join('.').toLowerCase());
    return candidates.map(candidate => apiIndex.get(candidate)?.name).find(Boolean);
  };
  const syntax = (category, name, node) => {
    const record = compatibilityData?.[category]?.[name];
    if (record) add(category, name, node);
  };

  const visit = (node, parent = null) => {
    if (!node || typeof node !== 'object') return;
    const type = node.type || '';
    if ((type === 'OptionalMemberExpression' || type === 'OptionalCallExpression' || node.optional) && (type === 'OptionalMemberExpression' || type === 'OptionalCallExpression' || type === 'MemberExpression' || type === 'CallExpression')) syntax('operators', 'optional_chaining', node);
    if (type === 'LogicalExpression' && node.operator === '??') syntax('operators', 'nullish_coalescing', node);
    if (type === 'AssignmentExpression') {
      const assignments = { '??=': 'nullish_coalescing_assignment', '&&=': 'logical_and_assignment', '||=': 'logical_or_assignment', '**=': 'exponentiation_assignment' };
      if (assignments[node.operator]) syntax('operators', assignments[node.operator], node);
    }
    if (type === 'BinaryExpression' && node.operator === '**') syntax('operators', 'exponentiation', node);
    if (type === 'SpreadElement' || type === 'RestElement') syntax('operators', 'spread', node);
    if (type === 'AwaitExpression') syntax('operators', 'await', node);
    if (node.async && /Function|Method/.test(type)) syntax('operators', node.generator ? 'async_generator_function' : 'async_function', node);
    if (type === 'ForOfStatement' && node.await) syntax('statements', 'for_await_of', node);
    if (type === 'ClassPrivateProperty' || type === 'ClassPrivateAccessorProperty') syntax('classes', 'private_class_fields', node);
    if (type === 'ClassPrivateMethod') syntax('classes', 'private_class_methods', node);
    if (type === 'ClassProperty' || type === 'PropertyDefinition') syntax('classes', 'public_class_fields', node);
    if (type === 'StaticBlock') syntax('classes', 'static', node);
    if (type === 'BigIntLiteral') {
      const record = builtinIndex.get('bigint');
      if (record) add('builtins', record.name, node);
    }
    if (type === 'VariableDeclaration' && node.kind === 'using') syntax('statements', 'using', node);
    if (type === 'VariableDeclaration' && node.kind === 'await using') syntax('statements', 'await_using', node);
    if (type === 'ImportExpression') syntax('statements', 'import', node);

    if (type === 'MemberExpression' || type === 'OptionalMemberExpression' || type === 'CallExpression' || type === 'OptionalCallExpression' || type === 'NewExpression') {
      const path = staticPath(type.endsWith('CallExpression') || type === 'NewExpression' ? node.callee : node);
      if (path.length && !declared.has(path[0].toLowerCase())) {
        const builtin = queryBuiltin(path);
        if (builtin) add('builtins', builtin, node);
        else {
          const api = queryApi(path);
          if (api) add('apis', api, node);
        }
      }
    } else if (type === 'Identifier' && parent && (parent.type === 'NewExpression' || parent.type === 'CallExpression') && parent.callee === node && !declared.has(node.name.toLowerCase())) {
      const builtin = queryBuiltin([node.name]);
      if (builtin) add('builtins', builtin, node);
      else {
        const api = queryApi([node.name]);
        if (api) add('apis', api, node);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments' || key === 'tokens') continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, node);
    }
  };
  visit(ast);
  return features;
}
