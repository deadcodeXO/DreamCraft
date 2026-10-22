import * as prettier from '/vendor/prettier/standalone.mjs';
import { analyzeCss } from '/css-analyzer.mjs';

const pluginUrl = name => `/vendor/prettier/${name}.mjs`;
const loadPlugin = name => import(pluginUrl(name));

window.dreamFormatter = {
  analyzeCss,
  async format(code, path) {
    const extension = path.split('.').pop().toLowerCase();
    let parser;
    let plugins;
    if (['html', 'htm', 'svg', 'vue'].includes(extension)) {
      parser = extension === 'vue' ? 'vue' : 'html';
      plugins = await Promise.all(['html', 'babel', 'estree', 'typescript', 'postcss'].map(loadPlugin));
    } else if (['css', 'scss', 'less'].includes(extension)) {
      parser = extension === 'css' ? 'css' : extension;
      plugins = [await loadPlugin('postcss')];
    } else if (['js', 'mjs', 'cjs', 'jsx'].includes(extension)) {
      parser = 'babel';
      plugins = [await loadPlugin('babel'), await loadPlugin('estree')];
    } else if (['ts', 'tsx'].includes(extension)) {
      parser = 'typescript';
      plugins = [await loadPlugin('typescript'), await loadPlugin('estree')];
    } else if (extension === 'json') {
      parser = 'json';
      plugins = [await loadPlugin('babel'), await loadPlugin('estree')];
    } else if (['md', 'markdown'].includes(extension)) {
      parser = 'markdown';
      plugins = [await loadPlugin('markdown')];
    } else {
      throw new Error(`Formatting is not available for .${extension || 'unknown'} files.`);
    }
    return prettier.format(code, {
      parser,
      plugins,
      printWidth: 100,
      tabWidth: 2,
      useTabs: false,
      semi: true,
      singleQuote: true,
      htmlWhitespaceSensitivity: 'css'
    });
  }
};
