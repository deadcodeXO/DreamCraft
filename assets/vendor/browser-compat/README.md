# Browser compatibility index

`index.json` is a compact, generated subset of MDN Browser Compatibility Data (BCD) 8.1.6. It contains HTML element/attribute support, CSS property/selector/at-rule support, and JavaScript syntax, built-in, and Web API support for Chrome, Edge, Firefox, and Safari. The checker uses it locally and does not send project source to MDN or another service.

The source package is `@mdn/browser-compat-data@8.1.6`, timestamped 2026-10-15. The upstream dataset is released under CC0-1.0; its license is included beside the generated index. Source: https://github.com/mdn/browser-compat-data.

To regenerate after obtaining the matching upstream package, extract `package/data.json` and `package/LICENSE`, then run:

```powershell
node tools/build-browser-compat-index.mjs <path-to-data.json> assets/vendor/browser-compat/index.json
```
