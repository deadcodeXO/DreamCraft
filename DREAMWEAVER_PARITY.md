# DreamCraft / Dreamweaver parity tracker

This tracker describes DreamCraft's current feature coverage and known limits. A checked item means the workflow exists in DreamCraft; it does not imply that Adobe's implementation is identical. Validation status is listed separately from feature presence.

## Complete in DreamCraft

- [x] Native Windows desktop window with branded startup splash, custom title bar, app icon, and dark/light themes.
- [x] Site folders, recent sites, file/folder operations, multiple open document tabs, save/undo/redo, project-wide find and replace, snapshots, and local automatic saves.
- [x] Visual Design, Code, Code/Design Split, and Code/Code Split views. Code/Code uses linked source documents so edits are shared while each pane has independent cursor and scroll state.
- [x] Local related CSS and JavaScript navigation from HTML, PHP, and Vue documents.
- [x] HTML/CSS/JavaScript syntax highlighting, project-aware completion, folding, formatting, core Emmet-style HTML and CSS expansion, and reusable snippets.
- [x] PHP/PHTML highlighting with PHP built-in, superglobal, project-symbol, variable, and local include/require path completions.
- [x] Debounced live HTML/accessibility/reference/CSS/JavaScript syntax diagnostics with a persistent enable/disable setting and clickable source-line results.
- [x] Visual page selection and editing, layer navigation, page metadata, and visual insertion tools.
- [x] CSS Designer source/rule/declaration editing, selector matching, media-query inspection and editing, and desktop/tablet/mobile viewport sizing.
- [x] Persistent explorer/inspector widths, drag resizing, keyboard resizing, collapse controls, command-palette restoration, and remembered settings.
- [x] Site templates with editable, optional, and repeating regions; project assets and starter pages.
- [x] Static HTML/CSS/JavaScript reports, accessibility checks, offline browser-compatibility data, and optional headless Chromium-family site runs.
- [x] Git workflows: initialize, status, stage/unstage, diff, commit, history, origin management, fetch, pull, push, local branch create/switch/merge, annotated tags and tag publishing, and confirmation-gated commit reverts. Merge/revert conflicts remain in the working tree for manual resolution in the editor.
- [x] Local publishing snapshots; FTP/explicit FTPS, SFTP, and WebDAV publishing and selective synchronization.
- [x] SQLite project database workbench, MySQL/PostgreSQL query sessions, and generated PHP/PDO data pages with schema-aware CRUD, prepared search, and bounded pagination.
- [x] Optional Dream AI Ask/Edit integration using a configured OpenAI-compatible endpoint, with preview and guarded apply.

## Still required for strict feature parity

- [x] **Dockable workspace layouts:** Files and Inspector panels can be docked in standard, left-inspector, and right-side arrangements; panel widths and visibility are preserved in named, locally saved layouts that can be applied, replaced, and deleted.
- [x] **Live preview across browsers:** external browsers open the active project page directly from the local site server. Project files are fingerprinted and external pages reload automatically when saved or on-disk files change; project URL paths resolve against the active site.
- [ ] **Browser-engine runtime matrix:** one Site Report pass can now run across every selected installed Edge, Chrome, Chromium, or Brave browser. Firefox and Safari still receive static compatibility analysis only, not executed page tests; a true cross-engine runtime matrix remains open.
- [x] **Connected-device preview:** an explicit Device preview session starts a token-protected, read-only LAN server, provides a phone/tablet URL to copy, serves the active project with responsive assets, and reloads after project changes. The session stops on request, application shutdown, or project switch; its listener exposes no project-editing APIs.
- [x] **Additional server-side web behaviors:** generated PHP authentication bundles use schema-selected username and password-hash columns, `password_verify`, parameterized SQL, CSRF-protected login/logout, secure session cookies, session ID rotation, reusable access guards, safe local return paths, and optional snapshot-protected insertion into an existing PHP page. SQLite, MySQL, and PostgreSQL connection configurations are supported; a PHP 8.3 SQLite runtime test covers denial, valid/invalid credentials, authenticated access, CSRF, and logout. Remote DB authentication has generation and syntax coverage, but no live MySQL/PostgreSQL server runtime validation yet. Adobe extension marketplace integrations, Creative Cloud, and Adobe account/cloud synchronization are intentionally out of scope per user direction.
- [ ] **End-to-end validation against customer sites:** run representative real projects through both themes, Code/Code and Code/Design editing, local server preview, browser tests, publishing dry-runs, and accessibility workflows before declaring production parity.

## Current verification

- Emmet expansion unit checks: `node tools/test-emmet.mjs`.
- Sass/SCSS builds use the embedded Rust Grass compiler; Less builds use the bundled Apache-2.0 Less.js runtime. The Stylesheet Builds panel supports imports, output destinations, expanded/compressed CSS, on-demand builds, and watched rebuilds. The Manage Websites dialog uses a themed in-app folder browser with drive selection and directory navigation; it does not invoke an operating-system picker.
- Preprocessor production smoke: `tools/smoke-production.ps1` verifies Sass imports, output and error handling, the bundled Less.js browser compiler/import, native editor assets, and existing service routes against the release executable.
- Live preview smoke: the release smoke suite verifies project-root URL rewriting, no-cache responses, project-change detection, and an Edge page automatically reloading after its source changes.
- Published snapshot preview smoke: release checks verify root-relative HTML references, domain-root `/` navigation, stylesheet query strings, CSS imports and `url()` assets remain inside the snapshot route, while protocol-relative CDN URLs are preserved.
- Generated PHP data pages and authentication are exercised on PHP 8.3 with disposable SQLite databases by `node tools/test-php-scaffolder-runtime.mjs`; coverage includes CRUD, CSRF rejection, text search, bounded pagination, SQL-injection-safe binding, password verification, guarded access, and logout. The check uses Docker and `php:8.3-cli-alpine`. MySQL/PostgreSQL generated files receive PHP syntax checks; live server runtime remains unverified.
- Connected-device smoke: the release smoke suite starts the LAN listener, reads a tokenized page and stylesheet, verifies invalid tokens and editor APIs are rejected, detects a file change, and stops the listener.
- Dynamic server smoke: the release smoke suite starts Python's HTTP server through DreamCraft, verifies `{port}` and `{project}` substitution, checks loopback readiness and active project content, then stops the server and verifies status.
- Workspace layouts use the Workspace menu to dock panels and create, apply, update, and delete named layouts; panel positions, widths, and visibility are persisted locally.
- Browser compatibility data and asset-library runtime checks are maintained in `tools/`.
- Native startup and shutdown smoke check: `tools/smoke-desktop.ps1` against the release executable.
- Customer-site checkpoint, rerun 2026-10-21: `tools/validate-customer-site.ps1 -ProjectPath D:\digitalchaos-site` stages a temporary copy, confirms 30 project files, 6 HTML/PHP pages, 6 stylesheets, and 6 JavaScript files, checks local references, publishes a snapshot, and runs it in Edge. A headless editor session exercises the themed folder browser and selected-path fill, PHP project-symbol and superglobal completions, both themes, live diagnostics, Design, Code, Code/Design, and Code/Code; adds a staged `/admin/` directory-index link and duplicate-ID error, confirms no false missing-link finding and verifies the clickable diagnostic jumps to the source line; saves the staged page and completes accessibility/reference and runtime reports. The original project manifest is SHA-256 checked before and after. The run completed with two expected backend warnings (`/admin/api/session` and `/api/journal`) because the isolated static-site run did not start the separate journal service. Configured-backend validation and a remote deployment dry-run remain outstanding.
- A successful compile or smoke test does not establish parity for the remaining unchecked integrations above.
