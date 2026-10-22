function phpLiteral(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function phpSchemaLiteral(columns) {
  return `[${columns.map(column => `[ 'name' => ${phpLiteral(column.name)}, 'type' => ${phpLiteral(column.type)}, 'notNull' => ${column.notNull ? 'true' : 'false'}, 'primaryKeyOrder' => ${Number(column.primaryKeyOrder) || 0} ]`).join(', ')}]`;
}

function phpSqlIdentifier(name, engine = 'sqlite') {
  return engine === 'mysql' ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`;
}

function relativeProjectFile(fromDirectory, targetFile) {
  const from = fromDirectory.split('/').filter(Boolean);
  const target = targetFile.split('/').filter(Boolean);
  while (from.length && target.length && from[0].toLowerCase() === target[0].toLowerCase()) { from.shift(); target.shift(); }
  return [...from.map(() => '..'), ...target].join('/') || targetFile.split('/').at(-1);
}

function phpProjectPath(value, label) {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes(':') || /[\u0000-\u001f]/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..') || !/\.php$/i.test(normalized)) {
    throw new Error(`${label} must be a project-relative PHP file path without empty, dot, or parent folders.`);
  }
  return normalized;
}

function phpProjectDirectory(value) {
  const normalized = String(value || 'auth').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes(':') || /[\u0000-\u001f]/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Authentication folder must be a project-relative path without empty, dot, or parent folders.');
  }
  return normalized;
}

function phpUrlPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function buildPhpConnectionCode(databasePath, pagePath, connection, engine) {
  const remote = engine !== 'sqlite';
  if (remote) return `
$dbHost = getenv('DREAMCRAFT_DB_HOST');
$dbPort = filter_var(getenv('DREAMCRAFT_DB_PORT'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
$databaseName = getenv('DREAMCRAFT_DB_DATABASE');
$dbUser = getenv('DREAMCRAFT_DB_USERNAME');
$dbPassword = getenv('DREAMCRAFT_DB_PASSWORD');
$dbTls = getenv('DREAMCRAFT_DB_TLS') === '1';
if (!is_string($dbHost) || $dbHost === '' || $dbPort === false || !is_string($databaseName) || $databaseName === '' || $dbUser === false || $dbPassword === false || strpbrk($dbHost, ";\\r\\n\\0") !== false || strpbrk($databaseName, ";\\r\\n\\0") !== false) {
    http_response_code(500);
    exit('Set DREAMCRAFT_DB_HOST, DREAMCRAFT_DB_PORT, DREAMCRAFT_DB_DATABASE, DREAMCRAFT_DB_USERNAME, and DREAMCRAFT_DB_PASSWORD in the PHP server environment.');
}
$pdoOptions = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false];
if (${phpLiteral(engine)} === 'mysql') {
    $dsn = 'mysql:host=' . $dbHost . ';port=' . $dbPort . ';dbname=' . $databaseName . ';charset=utf8mb4';
    if ($dbTls) {
        $sslCaAttribute = defined('Pdo\\\\Mysql::ATTR_SSL_CA') ? constant('Pdo\\\\Mysql::ATTR_SSL_CA') : (defined('PDO::MYSQL_ATTR_SSL_CA') ? constant('PDO::MYSQL_ATTR_SSL_CA') : null);
        $sslVerifyAttribute = defined('Pdo\\\\Mysql::ATTR_SSL_VERIFY_SERVER_CERT') ? constant('Pdo\\\\Mysql::ATTR_SSL_VERIFY_SERVER_CERT') : (defined('PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT') ? constant('PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT') : null);
        if ($sslCaAttribute === null || $sslVerifyAttribute === null) { http_response_code(500); exit('The installed PDO MySQL driver cannot verify TLS certificates.'); }
        $caFile = getenv('DREAMCRAFT_DB_CA_FILE');
        if (is_string($caFile) && $caFile !== '') {
            if (!is_file($caFile)) { http_response_code(500); exit('DREAMCRAFT_DB_CA_FILE does not point to a readable CA certificate file.'); }
            $pdoOptions[$sslCaAttribute] = $caFile;
        }
        $pdoOptions[$sslVerifyAttribute] = true;
    }
} else {
    $dsn = 'pgsql:host=' . $dbHost . ';port=' . $dbPort . ';dbname=' . $databaseName . ';sslmode=' . ($dbTls ? 'verify-full' : 'prefer');
    $caFile = getenv('DREAMCRAFT_DB_CA_FILE');
    if ($dbTls && is_string($caFile) && $caFile !== '') {
        if (!is_file($caFile)) { http_response_code(500); exit('DREAMCRAFT_DB_CA_FILE does not point to a readable CA certificate file.'); }
        putenv('PGSSLROOTCERT=' . $caFile);
    }
}
try { $pdo = new PDO($dsn, $dbUser, $dbPassword, $pdoOptions); }
catch (Throwable $exception) { http_response_code(500); exit('Database connection failed. Confirm the PDO driver, server environment, and network access.'); }
`;
  if (!databasePath) throw new Error('Choose a project SQLite database before generating this PHP behavior.');
  const databaseRelative = relativeProjectFile(pagePath.split('/').slice(0, -1).join('/'), databasePath);
  return `
$databaseFile = __DIR__ . '/' . ${phpLiteral(databaseRelative)};
try { $pdo = new PDO('sqlite:' . $databaseFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]); }
catch (Throwable $exception) { http_response_code(500); exit('SQLite connection failed. Confirm that PHP has PDO SQLite enabled and the project database is readable.'); }
`;
}

export function buildPhpDataPage(databasePath, table, pagePath, connection = { engine: 'sqlite', tls: false }) {
  const engine = String(connection.engine || 'sqlite').toLowerCase() === 'postgresql' ? 'postgres' : String(connection.engine || 'sqlite').toLowerCase();
  if (!['sqlite', 'mysql', 'postgres'].includes(engine)) throw new Error(`Unsupported PHP database engine: ${engine}`);
  const remote = engine !== 'sqlite';
  const quoteIdentifier = name => phpSqlIdentifier(name, engine);
  const fields = table.columns;
  const isView = table.kind === 'view';
  const primary = fields.filter(field => field.primaryKeyOrder > 0).sort((a, b) => a.primaryKeyOrder - b.primaryKeyOrder);
  const autoPrimary = primary.length === 1 && (primary[0].autoGenerated === true || (engine === 'sqlite' && primary[0].type.trim().toUpperCase() === 'INTEGER')) ? primary[0] : null;
  const insertable = isView ? [] : fields.filter(field => field !== autoPrimary);
  const editable = isView ? [] : fields.filter(field => !field.primaryKeyOrder);
  const tableIdentifier = quoteIdentifier(table.name);
  const databaseRelative = remote ? '' : relativeProjectFile(pagePath.split('/').slice(0, -1).join('/'), databasePath);
  const fieldsLiteral = phpSchemaLiteral(fields);
  const primaryLiteral = `[${primary.map(field => phpLiteral(field.name)).join(', ')}]`;
  const insertNames = insertable.map(field => phpLiteral(field.name)).join(', ');
  const updateNames = editable.map(field => phpLiteral(field.name)).join(', ');
  const columnsSql = fields.map(field => quoteIdentifier(field.name)).join(', ');
  const orderClause = primary.length ? ' ORDER BY ' + primary.map(field => quoteIdentifier(field.name)).join(', ') : '';
  const searchableFields = fields.filter(field => /CHAR|TEXT|CLOB|STRING|ENUM|UUID/i.test(field.type));
  const searchWhere = searchableFields.length
    ? ' WHERE ' + searchableFields.map((field, index) => `LOWER(${quoteIdentifier(field.name)}) LIKE :search${index}`).join(' OR ')
    : '';
  const insertSql = insertable.length
    ? `INSERT INTO ${tableIdentifier} (${insertable.map(field => quoteIdentifier(field.name)).join(', ')}) VALUES (${insertable.map((_, index) => `:v${index}`).join(', ')})`
    : engine === 'mysql' ? `INSERT INTO ${tableIdentifier} () VALUES ()` : `INSERT INTO ${tableIdentifier} DEFAULT VALUES`;
  const updateSql = primary.length && editable.length
    ? `UPDATE ${tableIdentifier} SET ${editable.map((field, index) => `${quoteIdentifier(field.name)} = :v${index}`).join(', ')} WHERE ${primary.map((field, index) => `${quoteIdentifier(field.name)} = :pk${index}`).join(' AND ')}`
    : '';
  const deleteSql = !isView && primary.length
    ? `DELETE FROM ${tableIdentifier} WHERE ${primary.map((field, index) => `${quoteIdentifier(field.name)} = :pk${index}`).join(' AND ')}`
    : '';
  const updateHandler = updateSql ? `elseif ($action === 'update') { $values = is_array($_POST['values'] ?? null) ? $_POST['values'] : []; $params = []; foreach ($updateFields as $index => $field) { $params[':v' . $index] = $values[$field] ?? ''; } foreach ($primaryFields as $index => $field) { $params[':pk' . $index] = $_POST['primary'][$field] ?? ''; } $statement = $pdo->prepare(${phpLiteral(updateSql)}); $statement->execute($params); $message = 'Record updated.'; }` : '';
  const deleteHandler = deleteSql ? `elseif ($action === 'delete') { $params = []; foreach ($primaryFields as $index => $field) { $params[':pk' . $index] = $_POST['primary'][$field] ?? ''; } $statement = $pdo->prepare(${phpLiteral(deleteSql)}); $statement->execute($params); $message = 'Record deleted.'; }` : '';
  const createInputs = `<div class="fields"><?php foreach ($fields as $field): if (!in_array($field['name'], $insertFields, true)) { continue; } ?><label><?= $h($field['name']) ?><input name="values[<?= $h($field['name']) ?>]" type="<?= preg_match('/INT|REAL|FLOA|DOUB|NUM|DEC/i', $field['type']) ? 'number' : 'text' ?>"<?= preg_match('/INT/i', $field['type']) ? '' : (preg_match('/REAL|FLOA|DOUB|NUM|DEC/i', $field['type']) ? ' step="any"' : '') ?><?= $field['notNull'] ? ' required' : '' ?>></label><?php endforeach; ?></div>`;
  const updateForm = updateSql ? `<form method="post" class="record-form"><input type="hidden" name="csrf" value="<?= $h($csrf) ?>"><input type="hidden" name="action" value="update"><?php foreach ($primaryFields as $field): ?><input type="hidden" name="primary[<?= $h($field) ?>]" value="<?= $h((string)($record[$field] ?? '')) ?>"><?php endforeach; ?><div class="fields"><?php foreach ($fields as $field): if (in_array($field['name'], $primaryFields, true)): ?><div><small class="key">Primary key</small><strong><?= $h($field['name']) ?>: <?= $h((string)($record[$field['name']] ?? '')) ?></strong></div><?php else: ?><label><?= $h($field['name']) ?><input name="values[<?= $h($field['name']) ?>]" value="<?= $h((string)($record[$field['name']] ?? '')) ?>" type="<?= preg_match('/INT|REAL|FLOA|DOUB|NUM|DEC/i', $field['type']) ? 'number' : 'text' ?>"<?= preg_match('/INT/i', $field['type']) ? '' : (preg_match('/REAL|FLOA|DOUB|NUM|DEC/i', $field['type']) ? ' step="any"' : '') ?><?= $field['notNull'] ? ' required' : '' ?>></label><?php endif; endforeach; ?></div><button class="button" type="submit">Save changes</button></form><form method="post" class="delete-form" onsubmit="return confirm('Delete this record?')"><input type="hidden" name="csrf" value="<?= $h($csrf) ?>"><input type="hidden" name="action" value="delete"><?php foreach ($primaryFields as $field): ?><input type="hidden" name="primary[<?= $h($field) ?>]" value="<?= $h((string)($record[$field] ?? '')) ?>"><?php endforeach; ?><button class="delete" type="submit">Delete record</button></form>` : `<dl class="record-fields"><?php foreach ($fields as $field): ?><div><dt><?= $h($field['name']) ?></dt><dd><?= $h((string)($record[$field['name']] ?? '')) ?></dd></div><?php endforeach; ?></dl>`;
  const title = table.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const dbName = (remote ? connection.database || `${engine} database` : databasePath.split('/').at(-1)).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const connectionCode = buildPhpConnectionCode(databasePath, pagePath, connection, engine);
  return `<?php
declare(strict_types=1);
if (session_status() !== PHP_SESSION_ACTIVE) { session_start(); }
${connectionCode}
$table = ${phpLiteral(table.name)};
$fields = ${fieldsLiteral};
$primaryFields = ${primaryLiteral};
$insertFields = [${insertNames}];
$updateFields = [${updateNames}];
$sqlTable = ${phpLiteral(tableIdentifier)};
$h = static fn($value): string => htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
if (empty($_SESSION['dreamcraft_csrf'])) { $_SESSION['dreamcraft_csrf'] = bin2hex(random_bytes(32)); }
$csrf = $_SESSION['dreamcraft_csrf'];
$message = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!hash_equals($csrf, (string)($_POST['csrf'] ?? ''))) { http_response_code(403); exit('Invalid form token. Reload the page and try again.'); }
    $action = (string)($_POST['action'] ?? '');
    try {
        if ($action === 'create') {
            $values = is_array($_POST['values'] ?? null) ? $_POST['values'] : [];
            if (count($insertFields) === 0) { $pdo->exec(${phpLiteral(insertSql)}); }
            else { $params = []; foreach ($insertFields as $index => $field) { $params[':v' . $index] = $values[$field] ?? ''; } $statement = $pdo->prepare(${phpLiteral(insertSql)}); $statement->execute($params); }
            $message = 'Record created.';
        } ${updateHandler} ${deleteHandler}
        else { throw new RuntimeException('Unknown action.'); }
    } catch (Throwable $exception) { $message = 'The database operation failed. Check required fields and database constraints.'; }
}

$searchableFields = ${phpSchemaLiteral(searchableFields)};
$rawSearch = is_string($_GET['q'] ?? null) ? $_GET['q'] : '';
$search = trim(substr($rawSearch, 0, 200));
$pageSize = 25;
$currentPage = filter_var($_GET['page'] ?? 1, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) ?: 1;
$whereSql = '';
$searchParams = [];
if ($search !== '' && $searchableFields) {
    $whereSql = ${phpLiteral(searchWhere)};
    foreach ($searchableFields as $index => $_field) { $searchParams[':search' . $index] = '%' . strtolower($search) . '%'; }
}
$countStatement = $pdo->prepare('SELECT COUNT(*) FROM ' . $sqlTable . $whereSql);
foreach ($searchParams as $name => $value) { $countStatement->bindValue($name, $value, PDO::PARAM_STR); }
$countStatement->execute();
$totalRecords = (int)$countStatement->fetchColumn();
$totalPages = max(1, (int)ceil($totalRecords / $pageSize));
$currentPage = min($currentPage, $totalPages);
$selectSql = 'SELECT ${columnsSql} FROM ' . $sqlTable . $whereSql . ${phpLiteral(orderClause)} . ' LIMIT :pageSize OFFSET :pageOffset';
$recordStatement = $pdo->prepare($selectSql);
foreach ($searchParams as $name => $value) { $recordStatement->bindValue($name, $value, PDO::PARAM_STR); }
$recordStatement->bindValue(':pageSize', $pageSize, PDO::PARAM_INT);
$recordStatement->bindValue(':pageOffset', ($currentPage - 1) * $pageSize, PDO::PARAM_INT);
$recordStatement->execute();
$records = $recordStatement->fetchAll();
?>
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Data</title><style>
:root{font:16px/1.5 system-ui,sans-serif;color:#e9e7f0;background:#11121a}*{box-sizing:border-box}body{max-width:1100px;margin:0 auto;padding:32px 20px}h1{font-size:clamp(25px,4vw,38px);margin:0}p{color:#a9a7b6}.panel,.record{margin:20px 0;padding:20px;border:1px solid #353544;border-radius:14px;background:#191a24}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}.fields label{display:grid;gap:5px;color:#bab8c8;font-size:13px}.fields input,.search input{width:100%;padding:9px;border:1px solid #424253;border-radius:7px;background:#11121a;color:#f7f4ff;font:inherit}.button,.delete{padding:9px 14px;border:0;border-radius:7px;background:#8d6bf2;color:white;font:inherit;font-weight:650;cursor:pointer}.delete{background:#5b2b39}.record{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.record-form{min-width:0}.delete-form{grid-column:2;grid-row:1;align-self:end}.record-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.record-fields dt,.key{color:#a7a5b4;font-size:11px}.record-fields dd{margin:0;overflow-wrap:anywhere}.notice{padding:10px;border-radius:7px;background:#26233b;color:#c5b5ff}.key{display:block}.empty{color:#a9a7b6;padding:18px}.search{display:flex;gap:10px;max-width:560px}.pager{display:flex;align-items:center;justify-content:center;gap:14px;margin:18px 0;color:#a9a7b6}.pager a{color:#c5b5ff;text-decoration:none;padding:7px 11px;border:1px solid #424253;border-radius:7px}.pager a[aria-disabled="true"]{opacity:.45;pointer-events:none}@media(max-width:650px){body{padding:20px 12px}.record{grid-template-columns:1fr}.delete-form{grid-column:1;grid-row:auto}.search{flex-wrap:wrap}}
</style></head><body><header><p>PROJECT DATABASE · ${title}</p><h1>${title}</h1><p>Manage records in <code>${dbName}</code>.</p></header>
<?php if ($message !== ''): ?><p class="notice"><?= $h($message) ?></p><?php endif; ?>
${insertable.length ? `<section class="panel"><h2>Create record</h2><form method="post"><input type="hidden" name="csrf" value="<?= $h($csrf) ?>"><input type="hidden" name="action" value="create">${createInputs}<button class="button" type="submit">Create record</button></form></section>` : ''}
<section><h2>Records <small>(<?= number_format($totalRecords) ?>)</small></h2>${searchableFields.length ? `<form method="get" class="search"><input name="q" value="<?= $h($search) ?>" maxlength="200" aria-label="Search records" placeholder="Search records"><button class="button" type="submit">Search</button><?php if ($search !== ''): ?><a class="pager" href="<?= $h($_SERVER['PHP_SELF']) ?>">Clear</a><?php endif; ?></form>` : ''}<?php if (!$records): ?><div class="panel empty">No matching records.</div><?php else: ?><?php foreach ($records as $record): ?><article class="record">${updateForm}</article><?php endforeach; ?><?php endif; ?><nav class="pager" aria-label="Record pages"><a href="?q=<?= rawurlencode($search) ?>&amp;page=<?= max(1, $currentPage - 1) ?>" aria-disabled="<?= $currentPage <= 1 ? 'true' : 'false' ?>">Previous</a><span>Page <?= number_format($currentPage) ?> of <?= number_format($totalPages) ?></span><a href="?q=<?= rawurlencode($search) ?>&amp;page=<?= min($totalPages, $currentPage + 1) ?>" aria-disabled="<?= $currentPage >= $totalPages ? 'true' : 'false' ?>">Next</a></nav></section>
</body></html>
`;
}
export function buildPhpAuthenticationFiles(databasePath, table, options = {}, connection = { engine: 'sqlite', tls: false }) {
  const engine = String(connection.engine || 'sqlite').toLowerCase() === 'postgresql' ? 'postgres' : String(connection.engine || 'sqlite').toLowerCase();
  if (!['sqlite', 'mysql', 'postgres'].includes(engine)) throw new Error(`Unsupported PHP database engine: ${engine}`);
  if (table.kind !== 'table') throw new Error('Authentication requires a database table, not a view.');
  const usernameColumn = String(options.usernameColumn || '').trim();
  const passwordColumn = String(options.passwordColumn || '').trim();
  const username = table.columns.find(column => column.name === usernameColumn);
  const password = table.columns.find(column => column.name === passwordColumn);
  const textType = column => /CHAR|TEXT|CLOB|STRING|ENUM|UUID/i.test(column?.type || '');
  if (!username || !password || username === password || !textType(username) || !textType(password)) throw new Error('Choose different text columns for username and password hash. Store passwords with PHP password_hash().');
  const folder = phpProjectDirectory(options.folder || 'auth');
  const loginRedirect = phpProjectPath(options.loginRedirect || 'index.php', 'Post-login redirect');
  const protectedPage = options.protectedPage ? phpProjectPath(options.protectedPage, 'Protected page') : '';
  const paths = { session: `${folder}/session.php`, login: `${folder}/login.php`, guard: `${folder}/require-login.php`, logout: `${folder}/logout.php` };
  const quote = name => phpSqlIdentifier(name, engine);
  const loginSql = `SELECT ${quote(usernameColumn)} AS username, ${quote(passwordColumn)} AS password_hash FROM ${quote(table.name)} WHERE ${quote(usernameColumn)} = :username LIMIT 1`;
  const connectionCode = buildPhpConnectionCode(databasePath, paths.login, connection, engine);
  const session = `<?php
declare(strict_types=1);
if (session_status() !== PHP_SESSION_ACTIVE) {
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax']);
    session_start();
}
if (!isset($_SESSION['dreamcraft_auth_csrf'])) { $_SESSION['dreamcraft_auth_csrf'] = bin2hex(random_bytes(32)); }
function dreamcraft_auth_csrf(): string { return (string)($_SESSION['dreamcraft_auth_csrf'] ?? ''); }
function dreamcraft_auth_logged_in(): bool { return isset($_SESSION['dreamcraft_auth_user']) && is_string($_SESSION['dreamcraft_auth_user']); }
function dreamcraft_auth_logout_form(): string { $token = htmlspecialchars(dreamcraft_auth_csrf(), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); return '<form method="post" action="${phpUrlPath('/' + paths.logout)}"><input type="hidden" name="csrf" value="' . $token . '"><button type="submit">Sign out</button></form>'; }
`;
  const login = `<?php
declare(strict_types=1);
require_once __DIR__ . '/session.php';
${connectionCode}
$error = '';
$next = (string)($_POST['next'] ?? $_GET['next'] ?? '');
if ($next !== '' && ($next[0] !== '/' || str_starts_with($next, '//') || str_contains($next, '\\\\') || preg_match('/[\\r\\n]/', $next))) { $next = ''; }
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!hash_equals(dreamcraft_auth_csrf(), (string)($_POST['csrf'] ?? ''))) { http_response_code(403); exit('Invalid form token. Reload and try again.'); }
    $username = trim(substr((string)($_POST['username'] ?? ''), 0, 200));
    $password = (string)($_POST['password'] ?? '');
    $statement = $pdo->prepare(${phpLiteral(loginSql)});
    $statement->execute([':username' => $username]);
    $account = $statement->fetch();
    if ($account && is_string($account['password_hash'] ?? null) && password_verify($password, $account['password_hash'])) {
        session_regenerate_id(true); $_SESSION['dreamcraft_auth_user'] = (string)$account['username'];
        header('Location: ' . ($next !== '' ? $next : ${phpLiteral(relativeProjectFile(folder, loginRedirect))}), true, 303); exit;
    }
    $error = 'The username or password was not recognized.';
}
$h = static fn($value): string => htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
?><!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#11121a;color:#eeeaf5;min-height:100vh;display:grid;place-items:center;margin:0}.card{width:min(360px,calc(100vw - 40px));padding:28px;border:1px solid #363443;border-radius:16px;background:#191923}h1{margin:0 0 6px}p{color:#aaa7b8}.error{color:#ff9cac}label{display:grid;gap:6px;margin:14px 0;color:#c8c5d1}input{padding:11px;border:1px solid #474554;border-radius:8px;background:#11121a;color:#fff;font:inherit}button{width:100%;padding:11px;border:0;border-radius:8px;background:#9870f5;color:white;font:inherit;font-weight:700;cursor:pointer}</style></head><body><main class="card"><h1>Sign in</h1><p>Use your account to continue.</p><?php if ($error !== ''): ?><p class="error"><?= $h($error) ?></p><?php endif; ?><form method="post"><input type="hidden" name="csrf" value="<?= $h(dreamcraft_auth_csrf()) ?>"><input type="hidden" name="next" value="<?= $h($next) ?>"><label>Username<input name="username" autocomplete="username" required maxlength="200"></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></main></body></html>
`;
  const guard = `<?php
declare(strict_types=1);
require_once __DIR__ . '/session.php';
if (!dreamcraft_auth_logged_in()) {
    $target = (string)($_SERVER['REQUEST_URI'] ?? '/');
    if ($target === '' || $target[0] !== '/' || str_starts_with($target, '//') || preg_match('/[\r\n]/', $target)) { $target = '/'; }
    header('Location: ' . ${phpLiteral(relativeProjectFile(folder, paths.login))} . '?next=' . rawurlencode($target), true, 303); exit;
}
`;
  const logout = `<?php
declare(strict_types=1);
require_once __DIR__ . '/session.php';
if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !hash_equals(dreamcraft_auth_csrf(), (string)($_POST['csrf'] ?? ''))) { http_response_code(403); exit('Invalid sign-out request.'); }
$_SESSION = [];
if (ini_get('session.use_cookies')) { $params = session_get_cookie_params(); setcookie(session_name(), '', ['expires' => time() - 42000, 'path' => $params['path'], 'domain' => $params['domain'], 'secure' => $params['secure'], 'httponly' => $params['httponly'], 'samesite' => 'Lax']); }
session_regenerate_id(true);
header('Location: ' . ${phpLiteral(relativeProjectFile(folder, paths.login))}, true, 303); exit;
`;
  return { files: [{ path: paths.session, content: session }, { path: paths.login, content: login }, { path: paths.guard, content: guard }, { path: paths.logout, content: logout }], protectedPage, loginRedirect };
}
