#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

use axum::{
    Json, Router,
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{
    Connection, OpenFlags, params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use sqlx::{
    AnyPool, Arguments, Column, Row, TypeInfo,
    any::{AnyArguments, AnyPoolOptions},
};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Component, Path as FsPath, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, Command},
    sync::{Mutex as AsyncMutex, RwLock},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(RustEmbed)]
#[folder = "assets/"]
struct EmbeddedAssets;

#[derive(RustEmbed)]
#[folder = "site/"]
struct EmbeddedStarter;

async fn embedded_asset(Path(path): Path<String>) -> Response {
    let path = if path.is_empty() {
        "index.html"
    } else {
        path.as_str()
    };
    let Some(file) = EmbeddedAssets::get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    ([(header::CONTENT_TYPE, content_type.as_ref())], file.data).into_response()
}

async fn embedded_index() -> Response {
    let Some(file) = EmbeddedAssets::get("index.html") else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        file.data,
    )
        .into_response()
}

async fn embedded_splash() -> Response {
    const SPLASH: &str = r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DreamCraft</title><style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{overflow:hidden;background:#101117;color:#f0eef7;font-family:"Segoe UI",Inter,system-ui,sans-serif;-webkit-user-select:none;user-select:none}.splash{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 38px;background:radial-gradient(ellipse at 50% 22%,#29203c 0,#16151f 45%,#101117 78%);border:1px solid #3b334c;border-radius:14px}.brand{display:flex;align-items:center;gap:13px}.mark{width:54px;height:54px;display:grid;place-items:center;border-radius:17px;background:linear-gradient(145deg,#c39aff,#7959ef 65%,#5143b9);box-shadow:0 8px 30px #8059ed50}.mark svg{width:32px;height:32px}.name{font-size:25px;font-weight:700;letter-spacing:-1px}.name span{color:#b69aff}.tagline{margin:11px 0 35px;color:#9895a8;font-size:12px;letter-spacing:.03em}.progress-track{width:100%;height:5px;overflow:hidden;border-radius:999px;background:#292632}.progress-fill{width:12%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#805cf0,#c58cff);transition:width .32s ease}.status{align-self:flex-start;margin-top:13px;color:#bbb7c9;font-size:11px}.version{margin-top:auto;padding-top:28px;color:#676575;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
</style></head><body><main class="splash" aria-label="DreamCraft startup"><div class="brand"><div class="mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 28 24.4 5.3 3.9 19.2h24.2L7.6 5.3 16 28Z" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="16" r="1.8" fill="#eadbff"/></svg></div><div class="name">Dream<span>Craft</span></div></div><div class="tagline">A thoughtful workspace for the open web</div><div class="progress-track" role="progressbar" aria-label="DreamCraft startup progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="12"><div class="progress-fill"></div></div><div class="status" aria-live="polite">Starting DreamCraft…</div><div class="version">Web design studio</div></main><script>window.setStartupProgress=(value,label)=>{const progress=Math.max(0,Math.min(100,Math.round(value)));const bar=document.querySelector('.progress-fill');const track=document.querySelector('.progress-track');bar.style.width=progress+'%';track.setAttribute('aria-valuenow',String(progress));document.querySelector('.status').textContent=label};</script></body></html>"##;
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], SPLASH).into_response()
}

fn application_data_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    base.unwrap_or_else(std::env::temp_dir).join("DreamCraft")
}

#[cfg(windows)]
fn desktop_log(message: &str) {
    let path = std::env::var_os("DREAMCRAFT_DESKTOP_LOG")
        .map(PathBuf::from)
        .unwrap_or_else(|| application_data_dir().join("desktop.log"));
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

fn initialize_embedded_starter(path: &FsPath) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    for name in EmbeddedStarter::iter() {
        if let Some(file) = EmbeddedStarter::get(name.as_ref()) {
            let destination = path.join(name.as_ref());
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            if !destination.exists() {
                fs::write(destination, file.data)?;
            }
        }
    }
    Ok(())
}

#[derive(Clone)]
struct AppState {
    root: Arc<std::sync::RwLock<PathBuf>>,
    app_root: Arc<PathBuf>,
    workspace: Arc<std::sync::RwLock<Workspace>>,
    ai: Arc<RwLock<Option<AiProvider>>>,
    deploy: Arc<RwLock<Option<SftpTarget>>>,
    webdav: Arc<RwLock<Option<WebDavTarget>>>,
    ftp: Arc<RwLock<Option<FtpTarget>>>,
    testing_server: Arc<AsyncMutex<Option<TestingServer>>>,
    device_preview: Arc<AsyncMutex<Option<DevicePreviewSession>>>,
    external_database: Arc<RwLock<Option<ExternalDatabase>>>,
}

struct DevicePreviewSession {
    url: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct DevicePreviewState {
    root: Arc<std::sync::RwLock<PathBuf>>,
    token: String,
}

#[derive(Clone, Serialize)]
struct DevicePreviewStatus {
    active: bool,
    url: Option<String>,
}

#[derive(Clone)]
struct ExternalDatabase {
    engine: String,
    name: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    tls: bool,
    pool: AnyPool,
}

impl AppState {
    fn project_root(&self) -> PathBuf {
        self.root
            .read()
            .expect("project root lock poisoned")
            .clone()
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct ProjectInfo {
    name: String,
    path: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct Workspace {
    current: String,
    projects: Vec<ProjectInfo>,
}

#[derive(Deserialize)]
struct OpenProjectRequest {
    path: String,
}

#[derive(Deserialize)]
struct FolderBrowseQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
struct CreateProjectRequest {
    path: String,
    name: String,
    starter: String,
}

#[derive(Clone)]
struct AiProvider {
    endpoint: String,
    model: String,
    api_key: String,
}

#[derive(Deserialize)]
struct AiSettingsUpdate {
    endpoint: String,
    model: String,
    api_key: Option<String>,
}

#[derive(Serialize)]
struct AiSettingsStatus {
    endpoint: String,
    model: String,
    configured: bool,
}

#[derive(Deserialize)]
struct AiChatRequest {
    prompt: String,
    path: String,
    source: String,
    history: Vec<AiMessage>,
    mode: String,
    context_paths: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct AiMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct AiChatResponse {
    content: String,
    finish_reason: Option<String>,
}

#[derive(Serialize)]
struct AiContextFile {
    path: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct AiError {
    error: String,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    modified_ms: u128,
}

#[derive(Deserialize)]
struct SaveRequest {
    content: String,
}

#[derive(Deserialize)]
struct SassBuildRequest {
    path: String,
    output: String,
    style: Option<String>,
}

#[derive(Serialize)]
struct SassBuildResult {
    path: String,
    output: String,
    bytes: usize,
}

#[derive(Clone, Deserialize, Serialize)]
struct CodeSnippet {
    id: String,
    name: String,
    category: String,
    trigger: String,
    description: String,
    syntax: String,
    mode: String,
    code: String,
}

#[derive(Deserialize)]
struct SnippetLibraryUpdate {
    snippets: Vec<CodeSnippet>,
}

#[derive(Deserialize)]
struct RenameRequest {
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct FolderRequest {
    path: String,
}

#[derive(Serialize)]
struct PublishResult {
    url: String,
}

#[derive(Serialize)]
struct SnapshotEntry {
    id: String,
    created_ms: u128,
    files: usize,
    bytes: u64,
}

#[derive(Deserialize)]
struct GitPathRequest {
    path: Option<String>,
}

#[derive(Deserialize)]
struct GitCommitRequest {
    message: String,
}

#[derive(Deserialize)]
struct GitActionRequest {
    action: String,
}

#[derive(Deserialize)]
struct GitBranchRequest {
    action: String,
    name: String,
}

#[derive(Deserialize)]
struct GitTagRequest {
    action: String,
    name: String,
    message: Option<String>,
}

#[derive(Deserialize)]
struct GitRevertRequest {
    hash: String,
}

#[derive(Deserialize)]
struct GitRemoteRequest {
    url: String,
}

#[derive(Serialize)]
struct GitFile {
    status: String,
    path: String,
}

#[derive(Clone, Deserialize)]
struct SftpTarget {
    host: String,
    username: String,
    remote_path: String,
}

#[derive(Serialize)]
struct DeployStatus {
    configured: bool,
    host: String,
    username: String,
    remote_path: String,
}

#[derive(Deserialize)]
struct DeployRequest {
    host: String,
    username: String,
    remote_path: String,
}

#[derive(Deserialize)]
struct SftpListRequest {
    path: String,
}

#[derive(Deserialize)]
struct SftpSyncRequest {
    paths: Vec<String>,
}

#[derive(Serialize)]
struct SftpRemoteEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: u64,
    local_size: Option<u64>,
    status: &'static str,
    downloadable: bool,
    uploadable: bool,
    navigable: bool,
}

#[derive(Clone)]
struct FtpTarget {
    host: String,
    port: u16,
    username: String,
    password: String,
    secure: bool,
    remote_path: String,
}

#[derive(Serialize)]
struct FtpStatus {
    configured: bool,
    host: String,
    port: u16,
    username: String,
    password_set: bool,
    secure: bool,
    remote_path: String,
}

#[derive(Deserialize)]
struct FtpSettingsRequest {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    secure: bool,
    remote_path: String,
}

#[derive(Deserialize)]
struct FtpSyncRequest {
    paths: Vec<String>,
}

#[derive(Serialize)]
struct FtpRemoteEntry {
    path: String,
    kind: String,
    size: u64,
    local_size: Option<u64>,
    status: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct TestingServerSettings {
    command: String,
    arguments: Vec<String>,
}

struct TestingServer {
    child: Child,
    url: String,
    project_root: PathBuf,
    stopped: bool,
}

fn terminate_testing_process_tree(pid: u32) -> bool {
    #[cfg(windows)]
    {
        return std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

fn external_database_environment_values(
    engine: &str,
    host: &str,
    port: u16,
    database: &str,
    username: &str,
    password: &str,
    tls: bool,
) -> [(&'static str, String); 7] {
    [
        ("DREAMCRAFT_DB_ENGINE", engine.to_owned()),
        ("DREAMCRAFT_DB_HOST", host.to_owned()),
        ("DREAMCRAFT_DB_PORT", port.to_string()),
        ("DREAMCRAFT_DB_DATABASE", database.to_owned()),
        ("DREAMCRAFT_DB_USERNAME", username.to_owned()),
        ("DREAMCRAFT_DB_PASSWORD", password.to_owned()),
        ("DREAMCRAFT_DB_TLS", if tls { "1" } else { "0" }.to_owned()),
    ]
}

impl Drop for TestingServer {
    fn drop(&mut self) {
        if !self.stopped {
            if let Some(pid) = self.child.id() {
                let _ = terminate_testing_process_tree(pid);
            }
        }
    }
}

#[derive(Clone)]
struct WebDavTarget {
    endpoint: reqwest::Url,
    username: String,
    password: String,
    remote_path: String,
}

#[derive(Serialize)]
struct WebDavStatus {
    configured: bool,
    endpoint: String,
    username: String,
    password_set: bool,
    remote_path: String,
}

#[derive(Deserialize)]
struct WebDavRequest {
    endpoint: String,
    username: String,
    password: Option<String>,
    remote_path: String,
}

#[derive(Deserialize)]
struct WebDavSyncRequest {
    paths: Vec<String>,
}

#[derive(Serialize)]
struct WebDavEntry {
    path: String,
    kind: String,
    size: u64,
    status: String,
}

fn propfind_body() -> &'static str {
    "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"
}

fn decode_webdav_path(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

async fn webdav_propfind(
    client: &reqwest::Client,
    target: &WebDavTarget,
    url: reqwest::Url,
) -> Result<Vec<(String, bool, u64)>, (StatusCode, Json<AiError>)> {
    let method = reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is valid");
    let mut request = client
        .request(method, url.clone())
        .header("Depth", "1")
        .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(propfind_body());
    if !target.username.is_empty() {
        request = request.basic_auth(&target.username, Some(&target.password));
    }
    let response = request.send().await.map_err(|_| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            "Could not list the WebDAV collection.",
        )
    })?;
    if !response.status().is_success() {
        return Err(ai_error(
            StatusCode::BAD_GATEWAY,
            format!("WebDAV listing returned HTTP {}.", response.status()),
        ));
    }
    let xml = response.text().await.map_err(|_| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            "WebDAV returned an unreadable listing.",
        )
    })?;
    let document = roxmltree::Document::parse(&xml).map_err(|_| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            "WebDAV returned invalid listing XML.",
        )
    })?;
    let base = webdav_url(target, "").map_err(|_| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "The WebDAV destination URL is invalid.",
        )
    })?;
    let base_path = base.path().trim_end_matches('/');
    let mut entries = Vec::new();
    for node in document
        .descendants()
        .filter(|node| node.has_tag_name(("DAV:", "response")))
    {
        let Some(href) = node
            .children()
            .find(|child| child.has_tag_name(("DAV:", "href")))
            .and_then(|child| child.text())
        else {
            continue;
        };
        let resolved = base.join(href).map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                "WebDAV returned an invalid resource URL.",
            )
        })?;
        if resolved.scheme() != base.scheme()
            || resolved.host_str() != base.host_str()
            || resolved.port_or_known_default() != base.port_or_known_default()
        {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                "WebDAV returned a resource outside the configured server.",
            ));
        }
        let encoded_path = resolved.path();
        let suffix = if encoded_path == base_path || encoded_path == format!("{base_path}/") {
            ""
        } else if let Some(suffix) = encoded_path.strip_prefix(&format!("{base_path}/")) {
            suffix.trim_end_matches('/')
        } else {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                "WebDAV returned a resource outside the configured collection.",
            ));
        };
        let Some(path) = decode_webdav_path(suffix) else {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                "WebDAV returned an unsupported resource path.",
            ));
        };
        if path.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.contains(['\\', '\0'])
                || part.chars().any(char::is_control)
        }) && !path.is_empty()
        {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                "WebDAV returned an unsafe resource path.",
            ));
        }
        let collection = node
            .descendants()
            .any(|child| child.has_tag_name(("DAV:", "collection")));
        let size = node
            .descendants()
            .find(|child| child.has_tag_name(("DAV:", "getcontentlength")))
            .and_then(|child| child.text())
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        entries.push((path, collection, size));
        if entries.len() > 20_000 {
            return Err(ai_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "The WebDAV collection contains more than 20,000 entries.",
            ));
        }
    }
    Ok(entries)
}

async fn webdav_compare(
    State(state): State<AppState>,
) -> Result<Json<Vec<WebDavEntry>>, (StatusCode, Json<AiError>)> {
    let target = state.webdav.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure a WebDAV destination before comparing.",
        )
    })?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the WebDAV client.",
            )
        })?;
    let mut pending = vec![String::new()];
    let mut remote = std::collections::BTreeMap::<String, (bool, u64)>::new();
    let mut visited = std::collections::HashSet::new();
    while let Some(directory) = pending.pop() {
        if !visited.insert(directory.clone()) {
            continue;
        }
        let entries = webdav_propfind(
            &client,
            &target,
            webdav_url(&target, &directory).map_err(|_| {
                ai_error(
                    StatusCode::BAD_REQUEST,
                    "The WebDAV destination URL is invalid.",
                )
            })?,
        )
        .await?;
        for (path, is_directory, size) in entries {
            if path.is_empty() {
                continue;
            }
            if is_directory {
                pending.push(path.clone());
            }
            remote.insert(path, (is_directory, size));
            if remote.len() > 20_000 {
                return Err(ai_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "The WebDAV collection contains more than 20,000 entries.",
                ));
            }
        }
    }
    let local_files = tokio::task::spawn_blocking({
        let root = state.project_root();
        move || collect_site_files(&root)
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not scan the local site.",
        )
    })?
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not read the local site.",
        )
    })?;
    let mut local = std::collections::BTreeMap::<String, (PathBuf, u64)>::new();
    for file in local_files {
        let path = file
            .strip_prefix(state.project_root())
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let size = tokio::fs::metadata(&file)
            .await
            .map_err(|_| {
                ai_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not inspect a local site file.",
                )
            })?
            .len();
        local.insert(path, (file, size));
    }
    let mut entries = Vec::new();
    for (path, (is_directory, size)) in &remote {
        if *is_directory {
            continue;
        }
        let status = match local.get(path) {
            None => "remote-only",
            Some((_, local_size)) if *local_size != *size => "different-size",
            Some((file, _)) => {
                let remote_response = webdav_send(
                    &client,
                    &target,
                    reqwest::Method::GET,
                    webdav_url(&target, path).map_err(|_| {
                        ai_error(
                            StatusCode::BAD_REQUEST,
                            "The WebDAV resource URL is invalid.",
                        )
                    })?,
                    None,
                    None,
                )
                .await
                .map_err(|_| {
                    ai_error(
                        StatusCode::BAD_GATEWAY,
                        "Could not download a WebDAV file for comparison.",
                    )
                })?;
                if !remote_response.status().is_success() {
                    return Err(ai_error(
                        StatusCode::BAD_GATEWAY,
                        format!(
                            "WebDAV could not read {path} (HTTP {}).",
                            remote_response.status()
                        ),
                    ));
                }
                let bytes = remote_response.bytes().await.map_err(|_| {
                    ai_error(
                        StatusCode::BAD_GATEWAY,
                        "WebDAV returned an unreadable file.",
                    )
                })?;
                let local_bytes = tokio::fs::read(file).await.map_err(|_| {
                    ai_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Could not read a local file for comparison.",
                    )
                })?;
                if bytes.as_ref() == local_bytes.as_slice() {
                    "identical"
                } else {
                    "different"
                }
            }
        };
        entries.push(WebDavEntry {
            path: path.clone(),
            kind: "file".into(),
            size: *size,
            status: status.into(),
        });
    }
    for (path, (_, size)) in local {
        if !remote.contains_key(&path) {
            entries.push(WebDavEntry {
                path,
                kind: "file".into(),
                size,
                status: "local-only".into(),
            });
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Json(entries))
}

fn safe_sync_target(root: &FsPath, relative: &str) -> Result<PathBuf, StatusCode> {
    let target = safe_path(root, relative)?;
    let mut current = root.to_path_buf();
    for component in FsPath::new(relative).components() {
        let Component::Normal(part) = component else {
            return Err(StatusCode::BAD_REQUEST);
        };
        current.push(part);
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return Err(StatusCode::BAD_REQUEST);
            }
        }
    }
    Ok(target)
}

async fn webdav_sync(
    State(state): State<AppState>,
    Json(request): Json<WebDavSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.webdav.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure a WebDAV destination before downloading.",
        )
    })?;
    if request.paths.is_empty() || request.paths.len() > 5000 {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 5,000 remote files.",
        ));
    }
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    let mut targets = Vec::with_capacity(paths.len());
    for path in paths {
        if path.is_empty() {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "A remote file path cannot be empty.",
            ));
        }
        let local_path = safe_sync_target(&state.project_root(), &path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                format!("Unsafe local destination path: {path}"),
            )
        })?;
        targets.push((path, local_path));
    }
    let backup_id = create_release(&state.project_root()).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not snapshot the local site before downloading files.",
        )
    })?;
    let backed_up = true;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the WebDAV client.",
            )
        })?;
    for (path, local_path) in &targets {
        let response = webdav_send(
            &client,
            &target,
            reqwest::Method::GET,
            webdav_url(&target, path).map_err(|_| {
                ai_error(
                    StatusCode::BAD_REQUEST,
                    "The WebDAV resource URL is invalid.",
                )
            })?,
            None,
            None,
        )
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                format!("Could not download {path} from WebDAV."),
            )
        })?;
        if !response.status().is_success() {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!(
                    "WebDAV could not download {path} (HTTP {}).",
                    response.status()
                ),
            ));
        }
        let bytes = response.bytes().await.map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                format!("WebDAV returned an unreadable file for {path}."),
            )
        })?;
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|_| {
                ai_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Could not create the local folder for {path}."),
                )
            })?;
        }
        let refreshed_target = safe_sync_target(&state.project_root(), path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                format!("Unsafe local destination path: {path}"),
            )
        })?;
        tokio::fs::write(refreshed_target, &bytes)
            .await
            .map_err(|_| {
                ai_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Could not write the downloaded file {path}."),
                )
            })?;
    }
    Ok(Json(
        serde_json::json!({ "files": targets.len(), "backup_created": backed_up, "backup_id": backup_id }),
    ))
}

async fn webdav_sync_upload(
    State(state): State<AppState>,
    Json(request): Json<WebDavSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.webdav.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure a WebDAV destination before uploading.",
        )
    })?;
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    if paths.is_empty()
        || paths.len() > 5_000
        || paths.iter().any(|path| !valid_remote_relative(path, false))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 5,000 safe local files.",
        ));
    }
    let root = state.project_root();
    let mut sources = Vec::new();
    for path in paths {
        let source = safe_sync_target(&root, &path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                format!("Unsafe local source path: {path}"),
            )
        })?;
        let metadata = tokio::fs::symlink_metadata(&source).await.map_err(|_| {
            ai_error(
                StatusCode::NOT_FOUND,
                format!("Local file not found: {path}"),
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                format!("Only regular local files can be uploaded: {path}"),
            ));
        }
        sources.push((path, source));
    }
    let backup = create_release(&root).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create an immutable site snapshot before WebDAV upload.",
        )
    })?;
    let snapshot = root.join(".dreamcraft").join("releases").join(&backup);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the WebDAV client.",
            )
        })?;
    let mut local_directories = std::collections::BTreeSet::new();
    for (path, _) in &sources {
        if let Some(parent) = FsPath::new(path).parent() {
            let mut relative = String::new();
            for segment in parent.components() {
                let Component::Normal(part) = segment else {
                    continue;
                };
                let part = part.to_string_lossy();
                relative = if relative.is_empty() {
                    part.to_string()
                } else {
                    format!("{relative}/{part}")
                };
                local_directories.insert(relative.clone());
            }
        }
    }
    let mkcol = reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL is a valid method");
    let mut remote_parent = String::new();
    for segment in target
        .remote_path
        .split('/')
        .filter(|part| !part.is_empty())
    {
        remote_parent = if remote_parent.is_empty() {
            segment.to_owned()
        } else {
            format!("{remote_parent}/{segment}")
        };
        let mut directory_target = target.clone();
        directory_target.remote_path = remote_parent.clone();
        let url = webdav_url(&directory_target, "").map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "The WebDAV destination URL is invalid.",
            )
        })?;
        let response = webdav_send(&client, &target, mkcol.clone(), url, None, None)
            .await
            .map_err(|_| {
                ai_error(
                    StatusCode::BAD_GATEWAY,
                    "Could not create a WebDAV destination folder.",
                )
            })?;
        if !response.status().is_success() && response.status() != StatusCode::METHOD_NOT_ALLOWED {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!(
                    "WebDAV could not create folder {remote_parent} (HTTP {}).",
                    response.status()
                ),
            ));
        }
    }
    for directory in local_directories {
        let url = webdav_url(&target, &directory).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "The WebDAV destination URL is invalid.",
            )
        })?;
        let response = webdav_send(&client, &target, mkcol.clone(), url, None, None)
            .await
            .map_err(|_| {
                ai_error(
                    StatusCode::BAD_GATEWAY,
                    "Could not create a WebDAV destination folder.",
                )
            })?;
        if !response.status().is_success() && response.status() != StatusCode::METHOD_NOT_ALLOWED {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!(
                    "WebDAV could not create folder {directory} (HTTP {}).",
                    response.status()
                ),
            ));
        }
    }
    for (path, _) in &sources {
        let bytes =
            tokio::fs::read(snapshot.join(path.replace('/', std::path::MAIN_SEPARATOR_STR)))
                .await
                .map_err(|_| {
                    ai_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Could not read {path} from the upload snapshot."),
                    )
                })?;
        let url = webdav_url(&target, path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "The WebDAV destination URL is invalid.",
            )
        })?;
        let response = webdav_send(
            &client,
            &target,
            reqwest::Method::PUT,
            url,
            None,
            Some(bytes),
        )
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                format!("Could not upload {path} to WebDAV."),
            )
        })?;
        if !response.status().is_success() {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!("WebDAV rejected {path} (HTTP {}).", response.status()),
            ));
        }
    }
    Ok(Json(
        serde_json::json!({"files": sources.len(), "backup": backup}),
    ))
}

async fn webdav_settings(State(state): State<AppState>) -> Json<WebDavStatus> {
    match state.webdav.read().await.clone() {
        Some(target) => Json(WebDavStatus {
            configured: true,
            endpoint: target.endpoint.to_string(),
            username: target.username,
            password_set: !target.password.is_empty(),
            remote_path: target.remote_path,
        }),
        None => Json(WebDavStatus {
            configured: false,
            endpoint: String::new(),
            username: String::new(),
            password_set: false,
            remote_path: String::new(),
        }),
    }
}

async fn update_webdav_settings(
    State(state): State<AppState>,
    Json(request): Json<WebDavRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    let mut endpoint = reqwest::Url::parse(request.endpoint.trim()).map_err(|_| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Enter a valid HTTP or HTTPS WebDAV endpoint.",
        )
    })?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Use an HTTP or HTTPS endpoint without embedded credentials, query parameters, or fragments.",
        ));
    }
    let endpoint_path = endpoint.path().trim_end_matches('/').to_owned();
    endpoint.set_path(&endpoint_path);
    let username = request.username.trim();
    if username.chars().any(|ch| ch.is_control()) {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "The WebDAV username contains unsupported control characters.",
        ));
    }
    let remote_path = request.remote_path.trim();
    if remote_path.is_empty()
        || remote_path
            .split('/')
            .any(|part| matches!(part, "." | ".."))
        || remote_path
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\\' | '"'))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Enter a WebDAV folder path without dot segments or control characters.",
        ));
    }
    let prior = state.webdav.read().await.clone();
    let supplied_password = request.password.unwrap_or_default();
    let password = if supplied_password.is_empty() {
        prior
            .filter(|existing| existing.endpoint == endpoint && existing.username == username)
            .map(|existing| existing.password)
            .unwrap_or_default()
    } else {
        supplied_password
    };
    if password.chars().any(|ch| ch.is_control()) {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "The WebDAV password contains unsupported control characters.",
        ));
    }
    *state.webdav.write().await = Some(WebDavTarget {
        endpoint,
        username: username.to_owned(),
        password,
        remote_path: if remote_path == "/" {
            "/".to_owned()
        } else {
            remote_path.trim_end_matches('/').to_owned()
        },
    });
    Ok(StatusCode::NO_CONTENT)
}

fn webdav_url(target: &WebDavTarget, relative: &str) -> Result<reqwest::Url, reqwest::Url> {
    let mut url = target.endpoint.clone();
    let mut segments = url
        .path_segments_mut()
        .map_err(|_| target.endpoint.clone())?;
    segments.pop_if_empty();
    for part in target
        .remote_path
        .split('/')
        .chain(relative.split('/'))
        .filter(|part| !part.is_empty())
    {
        segments.push(part);
    }
    drop(segments);
    Ok(url)
}

async fn webdav_send(
    client: &reqwest::Client,
    target: &WebDavTarget,
    method: reqwest::Method,
    url: reqwest::Url,
    content_type: Option<&str>,
    body: Option<Vec<u8>>,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut request = client.request(method, url);
    if !target.username.is_empty() {
        request = request.basic_auth(&target.username, Some(&target.password));
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    if let Some(content_type) = content_type {
        request = request.header(header::CONTENT_TYPE, content_type);
    }
    request.send().await
}

async fn webdav_remote_entry(
    client: &reqwest::Client,
    target: &WebDavTarget,
    path: &str,
) -> Result<Option<(bool, u64)>, (StatusCode, Json<AiError>)> {
    let parent = path
        .rsplit_once('/')
        .map(|(folder, _)| folder)
        .unwrap_or("");
    let url = webdav_url(target, parent).map_err(|_| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "The WebDAV destination URL is invalid.",
        )
    })?;
    let entries = webdav_propfind(client, target, url).await?;
    Ok(entries
        .into_iter()
        .find_map(|(entry_path, is_directory, size)| {
            (entry_path == path).then_some((is_directory, size))
        }))
}

async fn webdav_delete_remote(
    State(state): State<AppState>,
    Json(request): Json<WebDavSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.webdav.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure WebDAV before deleting remote files.",
        )
    })?;
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    if paths.is_empty()
        || paths.len() > 500
        || paths.iter().any(|path| !remote_management_path(path))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 500 safe remote files.",
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the WebDAV client.",
            )
        })?;
    for path in &paths {
        let Some((is_directory, _)) = webdav_remote_entry(&client, &target, path).await? else {
            return Err(ai_error(
                StatusCode::NOT_FOUND,
                format!("Remote file not found: {path}"),
            ));
        };
        if is_directory {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                format!("Only files can be deleted: {path}"),
            ));
        }
    }
    for path in &paths {
        let url = webdav_url(&target, path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "The WebDAV destination URL is invalid.",
            )
        })?;
        let response = webdav_send(&client, &target, reqwest::Method::DELETE, url, None, None)
            .await
            .map_err(|_| {
                ai_error(
                    StatusCode::BAD_GATEWAY,
                    format!("Could not delete remote file {path}."),
                )
            })?;
        if !response.status().is_success() {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!(
                    "WebDAV delete for {path} returned HTTP {}.",
                    response.status()
                ),
            ));
        }
    }
    Ok(Json(serde_json::json!({"files": paths.len()})))
}

async fn webdav_rename_remote(
    State(state): State<AppState>,
    Json(request): Json<RenameRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    let target = state.webdav.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure WebDAV before renaming remote files.",
        )
    })?;
    let same_folder =
        request.from.rsplit_once('/').map(|x| x.0) == request.to.rsplit_once('/').map(|x| x.0);
    if !remote_management_path(&request.from)
        || !remote_management_path(&request.to)
        || !same_folder
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Rename a remote file within its current folder using safe paths.",
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the WebDAV client.",
            )
        })?;
    let Some((is_directory, _)) = webdav_remote_entry(&client, &target, &request.from).await?
    else {
        return Err(ai_error(
            StatusCode::NOT_FOUND,
            format!("Remote file not found: {}", request.from),
        ));
    };
    if is_directory {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Only remote files can be renamed.",
        ));
    }
    if webdav_remote_entry(&client, &target, &request.to)
        .await?
        .is_some()
    {
        return Err(ai_error(
            StatusCode::CONFLICT,
            format!("A remote item named {} already exists.", request.to),
        ));
    }
    let source = webdav_url(&target, &request.from)
        .map_err(|_| ai_error(StatusCode::BAD_REQUEST, "The WebDAV source URL is invalid."))?;
    let destination = webdav_url(&target, &request.to).map_err(|_| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "The WebDAV destination URL is invalid.",
        )
    })?;
    let method = reqwest::Method::from_bytes(b"MOVE").expect("MOVE is valid");
    let mut builder = client
        .request(method, source)
        .header("Destination", destination.as_str())
        .header("Overwrite", "F");
    if !target.username.is_empty() {
        builder = builder.basic_auth(&target.username, Some(&target.password));
    }
    let response = builder
        .send()
        .await
        .map_err(|_| ai_error(StatusCode::BAD_GATEWAY, "Could not rename the WebDAV file."))?;
    if !response.status().is_success() {
        return Err(ai_error(
            StatusCode::BAD_GATEWAY,
            format!("WebDAV rename returned HTTP {}.", response.status()),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn test_webdav_connection(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.webdav.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Save a WebDAV connection before testing it.",
        )
    })?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the WebDAV client.",
            )
        })?;
    let url = webdav_url(&target, "").map_err(|_| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "The WebDAV destination URL is invalid.",
        )
    })?;
    let method = reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method");
    let mut request = client
        .request(method, url)
        .header("Depth", "0")
        .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>");
    if !target.username.is_empty() {
        request = request.basic_auth(&target.username, Some(&target.password));
    }
    let response = request.send().await.map_err(|_| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            "Could not reach the WebDAV endpoint.",
        )
    })?;
    if !response.status().is_success() {
        return Err(ai_error(
            StatusCode::BAD_GATEWAY,
            format!("WebDAV connection returned HTTP {}.", response.status()),
        ));
    }
    Ok(Json(
        serde_json::json!({ "connected": true, "status": response.status().as_u16() }),
    ))
}

async fn publish_webdav(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.webdav.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure a WebDAV destination before publishing.",
        )
    })?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the WebDAV client.",
            )
        })?;
    let release_id = create_release(&state.project_root()).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create an immutable publish snapshot.",
        )
    })?;
    let root = Arc::new(
        state
            .project_root()
            .join(".dreamcraft")
            .join("releases")
            .join(release_id),
    );
    let files = tokio::task::spawn_blocking({
        let root = root.clone();
        move || collect_site_files(&root)
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not scan the site files.",
        )
    })?
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not read the site files.",
        )
    })?;

    let mut directories = std::collections::BTreeSet::new();
    directories.insert(String::new());
    for file in &files {
        let relative = file.strip_prefix(root.as_ref()).unwrap_or(file);
        if relative.to_string_lossy().chars().any(char::is_control) {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "A site file path contains control characters and cannot be sent to WebDAV.",
            ));
        }
        let mut parent = String::new();
        if let Some(path) = relative.parent() {
            for segment in path.components() {
                let segment = segment.as_os_str().to_string_lossy();
                if segment.is_empty() || segment == "." {
                    continue;
                }
                parent = if parent.is_empty() {
                    segment.to_string()
                } else {
                    format!("{parent}/{segment}")
                };
                directories.insert(parent.clone());
            }
        }
    }

    let mut remote_prefix = String::new();
    for part in target.remote_path.split('/') {
        if part.is_empty() {
            continue;
        }
        remote_prefix = if remote_prefix.is_empty() {
            part.to_owned()
        } else {
            format!("{remote_prefix}/{part}")
        };
        let mut prefix_target = target.clone();
        prefix_target.remote_path = remote_prefix.clone();
        let url = webdav_url(&prefix_target, "").map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "The WebDAV destination URL is invalid.",
            )
        })?;
        let response = webdav_send(
            &client,
            &target,
            reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL is a valid method"),
            url,
            None,
            None,
        )
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                "Could not reach the WebDAV server.",
            )
        })?;
        if !response.status().is_success() && response.status() != StatusCode::METHOD_NOT_ALLOWED {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!(
                    "WebDAV could not create a destination folder (HTTP {}).",
                    response.status()
                ),
            ));
        }
    }

    for directory in &directories {
        let url = webdav_url(&target, directory).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "The WebDAV destination URL is invalid.",
            )
        })?;
        let response = webdav_send(
            &client,
            &target,
            reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL is a valid method"),
            url,
            None,
            None,
        )
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                "Could not reach the WebDAV server.",
            )
        })?;
        if !response.status().is_success() && response.status() != StatusCode::METHOD_NOT_ALLOWED {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!(
                    "WebDAV could not create a destination folder (HTTP {}).",
                    response.status()
                ),
            ));
        }
    }

    for file in &files {
        let relative = file.strip_prefix(root.as_ref()).unwrap_or(file);
        let relative = relative.to_string_lossy().replace('\\', "/");
        let url = webdav_url(&target, &relative).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "The WebDAV destination URL is invalid.",
            )
        })?;
        let body = tokio::fs::read(file).await.map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read a site file for upload.",
            )
        })?;
        let response = webdav_send(
            &client,
            &target,
            reqwest::Method::PUT,
            url,
            Some(mime_for(file)),
            Some(body),
        )
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                "Could not reach the WebDAV server.",
            )
        })?;
        if !response.status().is_success() {
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!(
                    "WebDAV could not upload {relative} (HTTP {}).",
                    response.status()
                ),
            ));
        }
    }
    Ok(Json(serde_json::json!({
        "files": files.len(),
        "destination": format!("{}:{}", target.endpoint, target.remote_path)
    })))
}

async fn deploy_settings(State(state): State<AppState>) -> Json<DeployStatus> {
    let target = state.deploy.read().await.clone();
    Json(match target {
        Some(target) => DeployStatus {
            configured: true,
            host: target.host,
            username: target.username,
            remote_path: target.remote_path,
        },
        None => DeployStatus {
            configured: false,
            host: String::new(),
            username: String::new(),
            remote_path: String::new(),
        },
    })
}

async fn update_deploy_settings(
    State(state): State<AppState>,
    Json(request): Json<DeployRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    let host = request.host.trim();
    let username = request.username.trim();
    let remote_path = request.remote_path.trim();
    let valid_host = !host.is_empty()
        && host
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '[')
        && host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ".-:_[]_".contains(ch));
    let valid_username = !username.is_empty()
        && username
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        && username
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch));
    let safe_remote_path = !remote_path.is_empty()
        && !remote_path
            .chars()
            .any(|ch| matches!(ch, '\r' | '\n' | '"'))
        && !remote_path.split('/').any(|part| part == "..")
        && remote_path
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "/._-~ ".contains(ch));
    if !valid_host || !valid_username || !safe_remote_path {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Enter a valid host, username, and remote folder path. Use an absolute path or a folder under the SSH user's home directory.",
        ));
    }
    *state.deploy.write().await = Some(SftpTarget {
        host: host.to_owned(),
        username: username.to_owned(),
        remote_path: remote_path.trim_end_matches('/').to_owned(),
    });
    Ok(StatusCode::NO_CONTENT)
}

fn quote_sftp(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "")
            .replace('\r', "")
    )
}

async fn run_sftp_batch(
    target: &SftpTarget,
    batch: &str,
    timeout: std::time::Duration,
) -> Result<std::process::Output, (StatusCode, Json<AiError>)> {
    let destination = format!("{}@{}", target.username, target.host);
    let mut child = Command::new("sftp")
        .args(["-q", "-b", "-", "-oBatchMode=yes", &destination])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| {
            ai_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "OpenSSH sftp was not found. Install the Windows OpenSSH Client and ensure sftp is on PATH.",
            )
        })?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(batch.as_bytes()).await.map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                "Could not send the SFTP command batch.",
            )
        })?;
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| ai_error(StatusCode::GATEWAY_TIMEOUT, "The SFTP operation timed out."))?
        .map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                "The SFTP process ended unexpectedly.",
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ai_error(
            StatusCode::BAD_GATEWAY,
            if detail.is_empty() {
                "SFTP could not complete the requested operation.".to_string()
            } else {
                format!("SFTP could not complete the requested operation: {detail}")
            },
        ));
    }
    Ok(output)
}

fn valid_remote_relative(path: &str, allow_empty: bool) -> bool {
    if path.is_empty() {
        return allow_empty;
    }
    !path.starts_with('/')
        && !path.starts_with('\\')
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part
                    .chars()
                    .any(|ch| ch.is_control() || matches!(ch, '\\' | '"' | '*' | '?' | '[' | ']'))
        })
}

fn local_name_key(name: &str) -> String {
    #[cfg(windows)]
    {
        return name.to_lowercase();
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

fn remote_project_path(target: &SftpTarget, relative: &str) -> String {
    if relative.is_empty() {
        target.remote_path.clone()
    } else {
        format!("{}/{}", target.remote_path.trim_end_matches('/'), relative)
    }
}

fn sftp_listing_name(line: &str) -> Option<(String, &'static str, u64)> {
    let mut token_count = 0usize;
    let mut in_token = false;
    let mut eighth_end = None;
    for (index, character) in line.char_indices() {
        if character.is_whitespace() {
            if in_token {
                token_count += 1;
                in_token = false;
                if token_count == 8 {
                    eighth_end = Some(index);
                    break;
                }
            }
        } else if !in_token {
            in_token = true;
        }
    }
    let end = eighth_end?;
    let mut fields = line.split_whitespace();
    let mode = fields.next()?;
    fields.next()?;
    fields.next()?;
    fields.next()?;
    let size = fields.next()?.parse::<u64>().ok()?;
    let name = line[end..].trim_start();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let kind = match mode.chars().next()? {
        'd' => "directory",
        '-' => "file",
        _ => return None,
    };
    Some((name.to_string(), kind, size))
}

async fn sftp_list(
    State(state): State<AppState>,
    Json(request): Json<SftpListRequest>,
) -> Result<Json<Vec<SftpRemoteEntry>>, (StatusCode, Json<AiError>)> {
    let target = state.deploy.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure an SFTP destination before comparing files.",
        )
    })?;
    if !valid_remote_relative(&request.path, true) {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "The remote folder path is invalid.",
        ));
    }
    let remote_directory = remote_project_path(&target, &request.path);
    let batch = format!("ls -la {}\n", quote_sftp(&remote_directory));
    let output = run_sftp_batch(&target, &batch, std::time::Duration::from_secs(120)).await?;
    let root = state.project_root();
    let scan_root = root.clone();
    let local_files = tokio::task::spawn_blocking(move || collect_site_files(&scan_root))
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not scan local website files.",
            )
        })?
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read local website files.",
            )
        })?;
    let mut local = std::collections::BTreeMap::new();
    for file in local_files {
        let relative = file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let parent = relative
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        if parent == request.path {
            let name = relative.rsplit('/').next().unwrap_or_default().to_string();
            let size = tokio::fs::metadata(&file)
                .await
                .map_err(|_| {
                    ai_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Could not inspect a local website file.",
                    )
                })?
                .len();
            local.insert(local_name_key(&name), (name, relative, size));
        }
    }
    let local_folder = if request.path.is_empty() {
        root.clone()
    } else {
        safe_sync_target(&root, &request.path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "Unsafe local comparison folder path.",
            )
        })?;
        root.join(request.path.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    let mut local_directories = std::collections::BTreeMap::<String, String>::new();
    match tokio::fs::read_dir(&local_folder).await {
        Ok(mut folder_entries) => {
            while let Some(entry) = folder_entries.next_entry().await.map_err(|_| {
                ai_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not read the matching local website folder.",
                )
            })? {
                let kind = entry.file_type().await.map_err(|_| {
                    ai_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Could not inspect a local website folder.",
                    )
                })?;
                if kind.is_dir()
                    && !kind.is_symlink()
                    && entry.file_name() != ".dreamcraft"
                    && entry.file_name() != ".git"
                {
                    let directory = entry.path();
                    let relative = directory
                        .strip_prefix(&root)
                        .unwrap_or(&directory)
                        .to_string_lossy()
                        .replace('\\', "/");
                    local_directories
                        .insert(entry.file_name().to_string_lossy().into_owned(), relative);
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read the matching local website folder.",
            ));
        }
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut remote_names = std::collections::BTreeSet::new();
    for line in stdout.lines() {
        if let Some((name, kind, size)) = sftp_listing_name(line) {
            if name == ".dreamcraft" || name == ".git" {
                continue;
            }
            let relative = if request.path.is_empty() {
                name.clone()
            } else {
                format!("{}/{name}", request.path)
            };
            let local_size = local.get(&local_name_key(&name)).map(|(_, _, size)| *size);
            let status = if kind == "directory" {
                "folder"
            } else if local_size.is_none() {
                "remote-only"
            } else if local_size == Some(size) {
                "same-size"
            } else {
                "different-size"
            };
            let path_is_safe = valid_remote_relative(&relative, false);
            let downloadable = kind == "file" && path_is_safe;
            let uploadable = kind == "file" && path_is_safe && local_size.is_some();
            let navigable = kind == "directory" && path_is_safe;
            remote_names.insert(local_name_key(&name));
            entries.push(SftpRemoteEntry {
                name,
                path: relative,
                kind,
                size,
                local_size,
                status,
                downloadable,
                uploadable,
                navigable,
            });
        }
    }
    for (key, (name, relative, size)) in local {
        if !remote_names.contains(&key) {
            let uploadable = valid_remote_relative(&relative, false);
            entries.push(SftpRemoteEntry {
                name,
                path: relative,
                kind: "file",
                size,
                local_size: Some(size),
                status: "local-only",
                downloadable: false,
                uploadable,
                navigable: false,
            });
        }
    }
    for (name, relative) in local_directories {
        if !remote_names.contains(&local_name_key(&name)) {
            let navigable = valid_remote_relative(&relative, false);
            entries.push(SftpRemoteEntry {
                name,
                path: relative,
                kind: "directory",
                size: 0,
                local_size: None,
                status: "local-only",
                downloadable: false,
                uploadable: false,
                navigable,
            });
        }
    }
    let verify_paths = entries
        .iter()
        .filter(|entry| entry.kind == "file" && entry.status == "same-size")
        .map(|entry| entry.path.clone())
        .collect::<Vec<_>>();
    for entry in &mut entries {
        if entry.status == "same-size" {
            entry.status = "same-size-unverified";
        }
    }
    if !verify_paths.is_empty() {
        let verify_dir = std::env::temp_dir().join(format!(
            "dreamcraft-sftp-verify-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        if tokio::fs::create_dir(&verify_dir).await.is_ok() {
            let mut batch = String::new();
            let mut staged = Vec::new();
            for (index, path) in verify_paths.iter().enumerate() {
                let destination = verify_dir.join(format!("{index}.bin"));
                batch.push_str(&format!(
                    "get {} {}\n",
                    quote_sftp(&remote_project_path(&target, path)),
                    quote_sftp(&destination.to_string_lossy().replace('\\', "/"))
                ));
                staged.push((path.clone(), destination));
            }
            if run_sftp_batch(&target, &batch, std::time::Duration::from_secs(600))
                .await
                .is_ok()
            {
                for (path, remote_file) in staged {
                    let local_file = root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    let identical = match (
                        tokio::fs::read(&remote_file).await,
                        tokio::fs::read(&local_file).await,
                    ) {
                        (Ok(remote), Ok(local)) => remote == local,
                        _ => continue,
                    };
                    if let Some(entry) = entries.iter_mut().find(|entry| entry.path == path) {
                        entry.status = if identical { "identical" } else { "different" };
                        if identical {
                            entry.downloadable = false;
                            entry.uploadable = false;
                        }
                    }
                }
            }
            let _ = tokio::fs::remove_dir_all(verify_dir).await;
        }
    }
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(Json(entries))
}

async fn sftp_sync(
    State(state): State<AppState>,
    Json(request): Json<SftpSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.deploy.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure an SFTP destination before downloading files.",
        )
    })?;
    if request.paths.is_empty()
        || request.paths.len() > 5000
        || request
            .paths
            .iter()
            .any(|path| !valid_remote_relative(path, false))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 5,000 valid remote files.",
        ));
    }
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    let root = state.project_root();
    let mut targets = Vec::with_capacity(paths.len());
    for path in paths {
        let local_path = safe_sync_target(&root, &path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                format!("Unsafe local destination path: {path}"),
            )
        })?;
        targets.push((path, local_path));
    }
    let backup_id = create_release(&root).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not snapshot the local site before downloading SFTP files.",
        )
    })?;
    let staging = root
        .join(".dreamcraft")
        .join(format!("sftp-download-{backup_id}"));
    tokio::fs::create_dir_all(staging.parent().ok_or_else(|| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not prepare SFTP staging.",
        )
    })?)
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not prepare SFTP staging.",
        )
    })?;
    tokio::fs::create_dir(&staging).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create a unique SFTP staging folder.",
        )
    })?;
    let mut batch = String::new();
    let mut staged = Vec::with_capacity(targets.len());
    for (path, destination) in &targets {
        let staged_path = staging.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = staged_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|_| {
                ai_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not create an SFTP staging subfolder.",
                )
            })?;
        }
        batch.push_str(&format!(
            "get {} {}\n",
            quote_sftp(&remote_project_path(&target, path)),
            quote_sftp(&staged_path.to_string_lossy().replace('\\', "/"))
        ));
        staged.push((staged_path, destination.clone(), path.clone()));
    }
    if let Err(error) = run_sftp_batch(&target, &batch, std::time::Duration::from_secs(600)).await {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error);
    }
    for (staged_path, destination, path) in &staged {
        let metadata = tokio::fs::symlink_metadata(staged_path)
            .await
            .map_err(|_| {
                ai_error(
                    StatusCode::BAD_GATEWAY,
                    format!("SFTP did not create the downloaded file for {path}."),
                )
            })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(ai_error(
                StatusCode::BAD_GATEWAY,
                format!("SFTP returned an unsafe file for {path}."),
            ));
        }
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|_| {
                ai_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Could not create the local folder for {path}."),
                )
            })?;
        }
        safe_sync_target(&root, path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                format!("Unsafe local destination path: {path}"),
            )
        })?;
        tokio::fs::copy(staged_path, destination)
            .await
            .map_err(|_| {
                ai_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Could not write the downloaded file {path}."),
                )
            })?;
    }
    let _ = tokio::fs::remove_dir_all(&staging).await;
    Ok(Json(
        serde_json::json!({ "files": staged.len(), "backup": backup_id }),
    ))
}

async fn sftp_sync_upload(
    State(state): State<AppState>,
    Json(request): Json<SftpSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.deploy.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure an SFTP destination before uploading files.",
        )
    })?;
    if request.paths.is_empty()
        || request.paths.len() > 5000
        || request
            .paths
            .iter()
            .any(|path| !valid_remote_relative(path, false))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 5,000 valid local files.",
        ));
    }
    let root = state.project_root();
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    let mut local = Vec::with_capacity(paths.len());
    for path in paths {
        let source = safe_sync_target(&root, &path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                format!("Unsafe local source path: {path}"),
            )
        })?;
        let metadata = tokio::fs::symlink_metadata(&source).await.map_err(|_| {
            ai_error(
                StatusCode::NOT_FOUND,
                format!("Local file not found: {path}"),
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                format!("Only regular site files can be uploaded: {path}"),
            ));
        }
        local.push((path, source));
    }
    let backup_id = create_release(&root).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create an immutable site snapshot before SFTP upload.",
        )
    })?;
    let snapshot = root.join(".dreamcraft").join("releases").join(&backup_id);
    let mut directories = std::collections::BTreeSet::new();
    for (path, _) in &local {
        if let Some(parent) = FsPath::new(path).parent() {
            let mut current = target.remote_path.trim_end_matches('/').to_string();
            for component in parent.components() {
                let Component::Normal(part) = component else {
                    continue;
                };
                let part = part.to_string_lossy();
                current = format!("{}/{part}", current.trim_end_matches('/'));
                directories.insert(current.clone());
            }
        }
    }
    let mut batch = String::new();
    for directory in directories {
        batch.push_str(&format!("-mkdir {}\n", quote_sftp(&directory)));
    }
    for (path, _) in &local {
        let source = snapshot.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let metadata = tokio::fs::symlink_metadata(&source).await.map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Could not read {path} from the immutable snapshot."),
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                format!("The snapshot contains an unsafe file: {path}"),
            ));
        }
        batch.push_str(&format!(
            "put -p {} {}\n",
            quote_sftp(&source.to_string_lossy().replace('\\', "/")),
            quote_sftp(&remote_project_path(&target, path))
        ));
    }
    run_sftp_batch(&target, &batch, std::time::Duration::from_secs(600)).await?;
    Ok(Json(
        serde_json::json!({ "files": local.len(), "backup": backup_id }),
    ))
}

fn remote_management_path(path: &str) -> bool {
    valid_remote_relative(path, false)
        && !path
            .split('/')
            .any(|part| matches!(part, ".git" | ".dreamcraft"))
}

async fn sftp_management_folder(
    state: &AppState,
    path: &str,
) -> Result<Vec<SftpRemoteEntry>, (StatusCode, Json<AiError>)> {
    let folder = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let Json(entries) = sftp_list(
        State(state.clone()),
        Json(SftpListRequest {
            path: folder.to_owned(),
        }),
    )
    .await?;
    Ok(entries)
}

async fn sftp_delete_remote(
    State(state): State<AppState>,
    Json(request): Json<SftpSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.deploy.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure SFTP before deleting remote files.",
        )
    })?;
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    if paths.is_empty()
        || paths.len() > 500
        || paths.iter().any(|path| !remote_management_path(path))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 500 safe remote files.",
        ));
    }
    let parent = paths[0]
        .rsplit_once('/')
        .map(|(folder, _)| folder)
        .unwrap_or("");
    if paths.iter().any(|path| {
        path.rsplit_once('/')
            .map(|(folder, _)| folder)
            .unwrap_or("")
            != parent
    }) {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Delete selected files from one remote folder at a time.",
        ));
    }
    let entries = sftp_management_folder(&state, &paths[0]).await?;
    for path in &paths {
        if !entries.iter().any(|entry| {
            entry.path == *path && entry.kind == "file" && entry.status != "local-only"
        }) {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                format!("The selected remote file is missing or is not a regular file: {path}"),
            ));
        }
    }
    let batch = paths
        .iter()
        .map(|path| format!("rm {}\n", quote_sftp(&remote_project_path(&target, path))))
        .collect::<String>();
    run_sftp_batch(&target, &batch, std::time::Duration::from_secs(120)).await?;
    Ok(Json(serde_json::json!({"files": paths.len()})))
}

async fn sftp_rename_remote(
    State(state): State<AppState>,
    Json(request): Json<RenameRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    let target = state.deploy.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure SFTP before renaming remote files.",
        )
    })?;
    let same_folder =
        request.from.rsplit_once('/').map(|x| x.0) == request.to.rsplit_once('/').map(|x| x.0);
    if !remote_management_path(&request.from)
        || !remote_management_path(&request.to)
        || !same_folder
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Rename a remote file within its current folder using safe paths.",
        ));
    }
    let entries = sftp_management_folder(&state, &request.from).await?;
    if !entries.iter().any(|entry| {
        entry.path == request.from && entry.kind == "file" && entry.status != "local-only"
    }) {
        return Err(ai_error(
            StatusCode::NOT_FOUND,
            format!("Remote file not found: {}", request.from),
        ));
    }
    if entries
        .iter()
        .any(|entry| entry.path == request.to && entry.status != "local-only")
    {
        return Err(ai_error(
            StatusCode::CONFLICT,
            format!("A remote item named {} already exists.", request.to),
        ));
    }
    let batch = format!(
        "rename {} {}\n",
        quote_sftp(&remote_project_path(&target, &request.from)),
        quote_sftp(&remote_project_path(&target, &request.to))
    );
    run_sftp_batch(&target, &batch, std::time::Duration::from_secs(120)).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn collect_site_files(root: &FsPath) -> std::io::Result<Vec<PathBuf>> {
    fn visit(root: &FsPath, folder: &FsPath, output: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in fs::read_dir(folder)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            if ty.is_symlink() {
                continue;
            }
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap_or(&path);
            if relative
                .components()
                .any(|part| part.as_os_str() == ".dreamcraft" || part.as_os_str() == ".git")
            {
                continue;
            }
            if ty.is_dir() {
                visit(root, &path, output)?;
            } else if ty.is_file() {
                output.push(path);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

async fn deploy_sftp(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.deploy.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure an SFTP destination before publishing.",
        )
    })?;
    let release_id = create_release(&state.project_root()).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create an immutable publish snapshot.",
        )
    })?;
    let root = Arc::new(
        state
            .project_root()
            .join(".dreamcraft")
            .join("releases")
            .join(release_id),
    );
    let files = tokio::task::spawn_blocking({
        let root = root.clone();
        move || collect_site_files(&root)
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not scan the site files.",
        )
    })?
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not read the site files.",
        )
    })?;

    let base = target.remote_path.trim_matches('/');
    let base = if target.remote_path.starts_with('/') {
        format!("/{base}")
    } else {
        base.to_owned()
    };
    let mut dirs = std::collections::BTreeSet::new();
    if !base.is_empty() {
        let mut current = if base.starts_with('/') {
            "/".to_owned()
        } else {
            String::new()
        };
        for part in base.trim_start_matches('/').split('/') {
            if part.is_empty() {
                continue;
            }
            if !current.is_empty() && !current.ends_with('/') {
                current.push('/');
            }
            current.push_str(part);
            dirs.insert(current.clone());
        }
    }
    for file in &files {
        let relative = file.strip_prefix(root.as_ref()).unwrap_or(file);
        if let Some(parent) = relative.parent() {
            let mut current = base.clone();
            for part in parent.components() {
                let segment = part.as_os_str().to_string_lossy();
                if segment.is_empty() || segment == "." {
                    continue;
                }
                current = if current.is_empty() {
                    segment.to_string()
                } else {
                    format!("{current}/{segment}")
                };
                dirs.insert(current.clone());
            }
        }
    }
    let mut batch = String::new();
    for dir in &dirs {
        batch.push_str(&format!("-mkdir {}\n", quote_sftp(dir)));
    }
    for file in &files {
        let relative = file.strip_prefix(root.as_ref()).unwrap_or(file);
        if relative
            .to_string_lossy()
            .chars()
            .any(|ch| matches!(ch, '\r' | '\n'))
        {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "A site file path contains a line break and cannot be represented safely in an SFTP batch.",
            ));
        }
        let remote = if base.is_empty() {
            relative.to_string_lossy().replace('\\', "/")
        } else {
            format!("{base}/{}", relative.to_string_lossy().replace('\\', "/"))
        };
        let local = file.to_string_lossy().replace('\\', "/");
        batch.push_str(&format!(
            "put -p {} {}\n",
            quote_sftp(&local),
            quote_sftp(&remote)
        ));
    }

    let mut child = Command::new("sftp")
        .args(["-b", "-", "-oBatchMode=yes", &format!("{}@{}", target.username, target.host)])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| ai_error(StatusCode::SERVICE_UNAVAILABLE, "OpenSSH sftp was not found. Install the Windows OpenSSH Client and ensure sftp is on PATH."))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(batch.as_bytes()).await.map_err(|_| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                "Could not send the upload manifest to sftp.",
            )
        })?;
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(600),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::GATEWAY_TIMEOUT,
            "SFTP upload exceeded ten minutes.",
        )
    })?
    .map_err(|_| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            "SFTP process ended before completing the upload.",
        )
    })?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(ai_error(
            StatusCode::BAD_GATEWAY,
            if message.is_empty() {
                "SFTP upload failed. Check the host, SSH key, host-key acceptance, and destination folder.".into()
            } else {
                message
            },
        ));
    }
    Ok(Json(
        serde_json::json!({ "files": files.len(), "destination": format!("{}:{}", target.host, target.remote_path), "output": String::from_utf8_lossy(&output.stdout).trim() }),
    ))
}

async fn ftp_settings(State(state): State<AppState>) -> Json<FtpStatus> {
    match state.ftp.read().await.clone() {
        Some(target) => Json(FtpStatus {
            configured: true,
            host: target.host,
            port: target.port,
            username: target.username,
            password_set: !target.password.is_empty(),
            secure: target.secure,
            remote_path: target.remote_path,
        }),
        None => Json(FtpStatus {
            configured: false,
            host: String::new(),
            port: 21,
            username: String::new(),
            password_set: false,
            secure: true,
            remote_path: String::new(),
        }),
    }
}

async fn update_ftp_settings(
    State(state): State<AppState>,
    Json(request): Json<FtpSettingsRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    let host = request.host.trim();
    let username = request.username.trim();
    let remote_path = request.remote_path.trim();
    if host.is_empty()
        || username.is_empty()
        || request.port == 0
        || host.chars().any(|ch| ch.is_control() || ch.is_whitespace())
        || username.chars().any(char::is_control)
        || remote_path
            .split('/')
            .any(|part| matches!(part, "." | ".."))
        || remote_path.chars().any(|ch| ch.is_control() || ch == '\\')
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Enter a host, username, valid port, and remote folder path without dot segments or control characters.",
        ));
    }
    let prior = state.ftp.read().await.clone();
    let supplied_password = request.password.unwrap_or_default();
    let password = if supplied_password.is_empty() {
        prior
            .filter(|existing| {
                existing.host == host
                    && existing.port == request.port
                    && existing.username == username
                    && existing.secure == request.secure
            })
            .map(|existing| existing.password)
            .unwrap_or_default()
    } else {
        supplied_password
    };
    if password.chars().any(char::is_control) {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "The FTP password contains unsupported control characters.",
        ));
    }
    *state.ftp.write().await = Some(FtpTarget {
        host: host.to_owned(),
        port: request.port,
        username: username.to_owned(),
        password,
        secure: request.secure,
        remote_path: if remote_path == "/" {
            "/".to_owned()
        } else {
            remote_path.trim_end_matches('/').to_owned()
        },
    });
    Ok(StatusCode::NO_CONTENT)
}

async fn testing_settings(State(state): State<AppState>) -> Json<TestingServerSettings> {
    let path = state
        .project_root()
        .join(".dreamcraft")
        .join("testing-server.json");
    let settings = tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    Json(settings)
}

async fn update_testing_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(settings): Json<TestingServerSettings>,
) -> Result<StatusCode, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let command = settings.command.trim();
    if command.is_empty()
        || command.chars().any(char::is_control)
        || settings.arguments.len() > 64
        || settings
            .arguments
            .iter()
            .any(|arg| arg.chars().any(char::is_control))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let root = state.project_root();
    let directory = root.join(".dreamcraft");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let bytes = serde_json::to_vec_pretty(&TestingServerSettings {
        command: command.to_owned(),
        arguments: settings.arguments,
    })
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(directory.join("testing-server.json"), bytes)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_testing_server(state: &AppState) {
    if let Some(mut server) = state.testing_server.lock().await.take() {
        if server.child.try_wait().ok().flatten().is_none() {
            let tree_stopped = if let Some(pid) = server.child.id() {
                tokio::task::spawn_blocking(move || terminate_testing_process_tree(pid))
                    .await
                    .unwrap_or(false)
            } else {
                false
            };
            if !tree_stopped {
                let _ = server.child.kill().await;
            }
            let _ = server.child.wait().await;
        }
        server.stopped = true;
    }
}

async fn start_testing_server(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    if !local_origin(&headers) {
        return Err(ai_error(
            StatusCode::FORBIDDEN,
            "Testing servers can only be started by this local editor.",
        ));
    }
    let root = state.project_root();
    let path = root.join(".dreamcraft").join("testing-server.json");
    let settings = tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<TestingServerSettings>(&bytes).ok())
        .ok_or_else(|| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "Configure and save a testing-server command first.",
            )
        })?;
    if settings.command.trim().is_empty() {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Configure and save a testing-server command first.",
        ));
    }
    stop_testing_server(&state).await;
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not reserve a local testing-server port.",
            )
        })?;
    let port = socket
        .local_addr()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not inspect the testing-server port.",
            )
        })?
        .port();
    drop(socket);
    let project = root.to_string_lossy().into_owned();
    let mut command = Command::new(settings.command.trim());
    command
        .current_dir(&root)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for name in [
        "DREAMCRAFT_DB_ENGINE",
        "DREAMCRAFT_DB_HOST",
        "DREAMCRAFT_DB_PORT",
        "DREAMCRAFT_DB_DATABASE",
        "DREAMCRAFT_DB_USERNAME",
        "DREAMCRAFT_DB_PASSWORD",
        "DREAMCRAFT_DB_TLS",
    ] {
        command.env_remove(name);
    }
    if let Some(database) = state.external_database.read().await.as_ref() {
        command.envs(external_database_environment_values(
            &database.engine,
            &database.host,
            database.port,
            &database.database,
            &database.username,
            &database.password,
            database.tls,
        ));
    }
    for argument in settings.arguments {
        command.arg(
            argument
                .replace("{port}", &port.to_string())
                .replace("{project}", &project),
        );
    }
    let mut child = command.spawn().map_err(|error| {
        ai_error(
            StatusCode::BAD_REQUEST,
            format!("Could not start the testing server command: {error}"),
        )
    })?;
    let ready = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some()
            {
                return Err(
                    "The testing-server process exited before it began listening.".to_owned(),
                );
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await;
    match ready {
        Ok(Ok(())) => {}
        Ok(Err(message)) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(ai_error(StatusCode::BAD_GATEWAY, message));
        }
        Err(_) => {
            if let Some(pid) = child.id() {
                let _ =
                    tokio::task::spawn_blocking(move || terminate_testing_process_tree(pid)).await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(ai_error(
                StatusCode::GATEWAY_TIMEOUT,
                "The testing server did not listen on the assigned port within 15 seconds. Use {port} in its arguments.",
            ));
        }
    }
    let url = format!("http://127.0.0.1:{port}");
    *state.testing_server.lock().await = Some(TestingServer {
        child,
        url: url.clone(),
        project_root: root,
        stopped: false,
    });
    Ok(Json(serde_json::json!({ "running": true, "url": url })))
}

async fn testing_server_status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mut guard = state.testing_server.lock().await;
    let Some(mut server) = guard.take() else {
        return Json(serde_json::json!({ "running": false }));
    };
    if server.child.try_wait().ok().flatten().is_some()
        || server.project_root != state.project_root()
    {
        if server.project_root != state.project_root() {
            let _ = server.child.kill().await;
            let _ = server.child.wait().await;
            server.stopped = true;
        }
        return Json(serde_json::json!({ "running": false }));
    }
    let result = Json(serde_json::json!({ "running": true, "url": server.url }));
    *guard = Some(server);
    result
}

async fn stop_testing_server_endpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    stop_testing_server(&state).await;
    Ok(StatusCode::NO_CONTENT)
}

fn ftp_login_and_check(target: &FtpTarget) -> Result<(), String> {
    if target.secure {
        let stream = suppaftp::NativeTlsFtpStream::connect((target.host.as_str(), target.port))
            .map_err(|error| error.to_string())?;
        let connector = suppaftp::NativeTlsConnector::from(
            suppaftp::native_tls::TlsConnector::new().map_err(|error| error.to_string())?,
        );
        let mut ftp = stream
            .into_secure(connector, &target.host)
            .map_err(|error| error.to_string())?;
        ftp.login(&target.username, &target.password)
            .map_err(|error| error.to_string())?;
        ftp.pwd().map_err(|error| error.to_string())?;
        ftp.quit().map_err(|error| error.to_string())?;
    } else {
        let mut ftp = suppaftp::FtpStream::connect((target.host.as_str(), target.port))
            .map_err(|error| error.to_string())?;
        ftp.login(&target.username, &target.password)
            .map_err(|error| error.to_string())?;
        ftp.pwd().map_err(|error| error.to_string())?;
        ftp.quit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ftp_delete_files_blocking<T: suppaftp::TlsStream>(
    ftp: &mut suppaftp::ImplFtpStream<T>,
    target: &FtpTarget,
    paths: &[String],
) -> Result<usize, String> {
    ftp.login(&target.username, &target.password)
        .map_err(|error| error.to_string())?;
    ftp.transfer_type(suppaftp::types::FileType::Binary)
        .map_err(|error| error.to_string())?;
    if target.remote_path.starts_with('/') {
        ftp.cwd("/").map_err(|error| error.to_string())?;
    }
    for segment in target
        .remote_path
        .split('/')
        .filter(|part| !part.is_empty())
    {
        ftp.cwd(segment).map_err(|error| error.to_string())?;
    }
    for path in paths {
        ftp.size(path)
            .map_err(|error| format!("Could not verify remote file {path}: {error}"))?;
        ftp.rm(path)
            .map_err(|error| format!("Could not delete remote file {path}: {error}"))?;
    }
    ftp.quit().map_err(|error| error.to_string())?;
    Ok(paths.len())
}

fn ftp_rename_file_blocking<T: suppaftp::TlsStream>(
    ftp: &mut suppaftp::ImplFtpStream<T>,
    target: &FtpTarget,
    from: &str,
    to: &str,
) -> Result<(), String> {
    ftp.login(&target.username, &target.password)
        .map_err(|error| error.to_string())?;
    ftp.transfer_type(suppaftp::types::FileType::Binary)
        .map_err(|error| error.to_string())?;
    if target.remote_path.starts_with('/') {
        ftp.cwd("/").map_err(|error| error.to_string())?;
    }
    for segment in target
        .remote_path
        .split('/')
        .filter(|part| !part.is_empty())
    {
        ftp.cwd(segment).map_err(|error| error.to_string())?;
    }
    ftp.size(from)
        .map_err(|error| format!("Could not verify remote file {from}: {error}"))?;
    if ftp.size(to).is_ok() {
        return Err(format!("A remote file named {to} already exists."));
    }
    ftp.rename(from, to)
        .map_err(|error| format!("Could not rename remote file: {error}"))?;
    ftp.quit().map_err(|error| error.to_string())?;
    Ok(())
}

async fn ftp_delete_remote(
    State(state): State<AppState>,
    Json(request): Json<FtpSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.ftp.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure FTP before deleting remote files.",
        )
    })?;
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    if paths.is_empty()
        || paths.len() > 500
        || paths.iter().any(|path| !remote_management_path(path))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 500 safe remote files.",
        ));
    }
    let result = tokio::task::spawn_blocking(move || {
        if target.secure {
            let stream = suppaftp::NativeTlsFtpStream::connect((target.host.as_str(), target.port))
                .map_err(|error| error.to_string())?;
            let connector = suppaftp::NativeTlsConnector::from(
                suppaftp::native_tls::TlsConnector::new().map_err(|error| error.to_string())?,
            );
            let mut ftp = stream
                .into_secure(connector, &target.host)
                .map_err(|error| error.to_string())?;
            ftp_delete_files_blocking(&mut ftp, &target, &paths)
        } else {
            let mut ftp = suppaftp::FtpStream::connect((target.host.as_str(), target.port))
                .map_err(|error| error.to_string())?;
            ftp_delete_files_blocking(&mut ftp, &target, &paths)
        }
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "FTP delete worker stopped unexpectedly.",
        )
    })?;
    result
        .map(|files| Json(serde_json::json!({"files": files})))
        .map_err(|message| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                format!("FTP delete failed: {message}"),
            )
        })
}

async fn ftp_rename_remote(
    State(state): State<AppState>,
    Json(request): Json<RenameRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    let target = state.ftp.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure FTP before renaming remote files.",
        )
    })?;
    let same_folder =
        request.from.rsplit_once('/').map(|x| x.0) == request.to.rsplit_once('/').map(|x| x.0);
    if !remote_management_path(&request.from)
        || !remote_management_path(&request.to)
        || !same_folder
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Rename a remote file within its current folder using safe paths.",
        ));
    }
    let from = request.from;
    let to = request.to;
    let result = tokio::task::spawn_blocking(move || {
        if target.secure {
            let stream = suppaftp::NativeTlsFtpStream::connect((target.host.as_str(), target.port))
                .map_err(|error| error.to_string())?;
            let connector = suppaftp::NativeTlsConnector::from(
                suppaftp::native_tls::TlsConnector::new().map_err(|error| error.to_string())?,
            );
            let mut ftp = stream
                .into_secure(connector, &target.host)
                .map_err(|error| error.to_string())?;
            ftp_rename_file_blocking(&mut ftp, &target, &from, &to)
        } else {
            let mut ftp = suppaftp::FtpStream::connect((target.host.as_str(), target.port))
                .map_err(|error| error.to_string())?;
            ftp_rename_file_blocking(&mut ftp, &target, &from, &to)
        }
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "FTP rename worker stopped unexpectedly.",
        )
    })?;
    result.map(|_| StatusCode::NO_CONTENT).map_err(|message| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            format!("FTP rename failed: {message}"),
        )
    })
}

async fn test_ftp_connection(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.ftp.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Save an FTP connection before testing it.",
        )
    })?;
    let result = tokio::task::spawn_blocking(move || ftp_login_and_check(&target))
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "FTP connection worker stopped unexpectedly.",
            )
        })?;
    result.map_err(|message| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            format!("FTP connection failed: {message}"),
        )
    })?;
    Ok(Json(serde_json::json!({ "connected": true })))
}

fn ensure_ftp_directory<T: suppaftp::TlsStream>(
    ftp: &mut suppaftp::ImplFtpStream<T>,
    name: &str,
) -> Result<(), String> {
    if ftp.cwd(name).is_ok() {
        return Ok(());
    }
    ftp.mkdir(name).map_err(|error| error.to_string())?;
    ftp.cwd(name).map_err(|error| error.to_string())
}

fn publish_ftp_files<T: suppaftp::TlsStream + Send + 'static>(
    mut ftp: suppaftp::ImplFtpStream<T>,
    target: &FtpTarget,
    root: &FsPath,
    files: &[PathBuf],
) -> Result<(), String> {
    ftp.login(&target.username, &target.password)
        .map_err(|error| error.to_string())?;
    ftp.transfer_type(suppaftp::types::FileType::Binary)
        .map_err(|error| error.to_string())?;
    if target.remote_path.starts_with('/') {
        ftp.cwd("/").map_err(|error| error.to_string())?;
    }
    for segment in target
        .remote_path
        .split('/')
        .filter(|part| !part.is_empty())
    {
        ensure_ftp_directory(&mut ftp, segment)?;
    }
    let remote_root = ftp.pwd().map_err(|error| error.to_string())?;
    for file in files {
        let relative = file.strip_prefix(root).unwrap_or(file);
        let segments: Vec<String> = relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect();
        if segments.is_empty()
            || segments.iter().any(|part| {
                part.is_empty() || part == "." || part == ".." || part.chars().any(char::is_control)
            })
        {
            return Err("A site file has a name that cannot be transferred safely.".into());
        }
        ftp.cwd(&remote_root).map_err(|error| error.to_string())?;
        for segment in &segments[..segments.len() - 1] {
            ensure_ftp_directory(&mut ftp, segment)?;
        }
        let mut source = fs::File::open(file).map_err(|error| error.to_string())?;
        ftp.put_file(segments.last().expect("checked non-empty"), &mut source)
            .map_err(|error| error.to_string())?;
    }
    ftp.quit().map_err(|error| error.to_string())?;
    Ok(())
}

fn ftp_scan_directory<T: suppaftp::TlsStream>(
    ftp: &mut suppaftp::ImplFtpStream<T>,
    base: &str,
    root: &FsPath,
    relative: &str,
    output: &mut Vec<FtpRemoteEntry>,
    local: &std::collections::BTreeMap<String, u64>,
    depth: usize,
) -> Result<(), String> {
    if depth > 64 || output.len() > 20_000 {
        return Err("The FTP site exceeds the 20,000-entry or 64-folder safety limit.".into());
    }
    let directory = if relative.is_empty() {
        base.to_owned()
    } else {
        format!("{}/{relative}", base.trim_end_matches('/'))
    };
    ftp.cwd(&directory)
        .map_err(|error| format!("Could not open FTP folder {relative}: {error}"))?;
    let listing = ftp
        .mlsd(None)
        .or_else(|_| ftp.list(None))
        .map_err(|error| format!("Could not list FTP folder {relative}: {error}"))?;
    for line in listing {
        let parsed = suppaftp::list::ListParser::parse_mlsd(&line)
            .or_else(|_| suppaftp::list::ListParser::parse_posix(&line))
            .or_else(|_| suppaftp::list::ListParser::parse_dos(&line));
        let Ok(entry) = parsed else { continue };
        let name = entry.name();
        if name == "."
            || name == ".."
            || entry.is_symlink()
            || name.chars().any(char::is_control)
            || name.contains(['/', '\\'])
        {
            continue;
        }
        let path = if relative.is_empty() {
            name.to_owned()
        } else {
            format!("{relative}/{name}")
        };
        if !valid_remote_relative(&path, false) {
            continue;
        }
        if entry.is_directory() {
            output.push(FtpRemoteEntry {
                path: path.clone(),
                kind: "directory".into(),
                size: 0,
                local_size: None,
                status: "folder".into(),
            });
            ftp_scan_directory(ftp, base, root, &path, output, local, depth + 1)?;
            continue;
        }
        if !entry.is_file() {
            continue;
        }
        let size = entry.size() as u64;
        let local_size = local.get(&path).copied();
        let status = match local_size {
            None => "remote-only",
            Some(local_size) if local_size != size => "different-size",
            Some(_) => {
                ftp.cwd(base).map_err(|error| error.to_string())?;
                let remote = ftp
                    .retr_as_buffer(&path)
                    .map_err(|error| format!("Could not verify FTP file {path}: {error}"))?
                    .into_inner();
                let local_bytes =
                    fs::read(root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR))).ok();
                if local_bytes.as_deref() == Some(remote.as_slice()) {
                    "identical"
                } else {
                    "different"
                }
            }
        };
        output.push(FtpRemoteEntry {
            path,
            kind: "file".into(),
            size,
            local_size,
            status: status.into(),
        });
    }
    Ok(())
}

fn ftp_compare_blocking<T: suppaftp::TlsStream>(
    ftp: &mut suppaftp::ImplFtpStream<T>,
    target: &FtpTarget,
    root: &FsPath,
) -> Result<Vec<FtpRemoteEntry>, String> {
    ftp.login(&target.username, &target.password)
        .map_err(|error| error.to_string())?;
    ftp.transfer_type(suppaftp::types::FileType::Binary)
        .map_err(|error| error.to_string())?;
    if target.remote_path.starts_with('/') {
        ftp.cwd("/").map_err(|error| error.to_string())?;
    }
    for segment in target
        .remote_path
        .split('/')
        .filter(|part| !part.is_empty())
    {
        ftp.cwd(segment).map_err(|error| error.to_string())?;
    }
    let base = ftp.pwd().map_err(|error| error.to_string())?;
    let files = collect_site_files(root).map_err(|error| error.to_string())?;
    let mut local = std::collections::BTreeMap::new();
    for file in files {
        let path = file
            .strip_prefix(root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let size = fs::metadata(&file)
            .map_err(|error| error.to_string())?
            .len();
        local.insert(path, size);
    }
    let mut entries = Vec::new();
    ftp_scan_directory(ftp, &base, root, "", &mut entries, &local, 0)?;
    let remote_files = entries
        .iter()
        .filter(|entry| entry.kind == "file")
        .map(|entry| entry.path.clone())
        .collect::<std::collections::HashSet<_>>();
    for (path, size) in local {
        if !remote_files.contains(&path) {
            entries.push(FtpRemoteEntry {
                path,
                kind: "file".into(),
                size,
                local_size: Some(size),
                status: "local-only".into(),
            });
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let _ = ftp.quit();
    Ok(entries)
}

async fn compare_ftp(
    State(state): State<AppState>,
) -> Result<Json<Vec<FtpRemoteEntry>>, (StatusCode, Json<AiError>)> {
    let target = state.ftp.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure an FTP destination before comparing.",
        )
    })?;
    let root = state.project_root();
    let result = tokio::task::spawn_blocking(move || {
        if target.secure {
            let stream = suppaftp::NativeTlsFtpStream::connect((target.host.as_str(), target.port))
                .map_err(|error| error.to_string())?;
            let connector = suppaftp::NativeTlsConnector::from(
                suppaftp::native_tls::TlsConnector::new().map_err(|error| error.to_string())?,
            );
            let mut ftp = stream
                .into_secure(connector, &target.host)
                .map_err(|error| error.to_string())?;
            ftp_compare_blocking(&mut ftp, &target, &root)
        } else {
            let mut ftp = suppaftp::FtpStream::connect((target.host.as_str(), target.port))
                .map_err(|error| error.to_string())?;
            ftp_compare_blocking(&mut ftp, &target, &root)
        }
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "FTP comparison worker stopped unexpectedly.",
        )
    })?;
    result.map(Json).map_err(|message| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            format!("FTP comparison failed: {message}"),
        )
    })
}

fn ftp_download_blocking<T: suppaftp::TlsStream>(
    ftp: &mut suppaftp::ImplFtpStream<T>,
    target: &FtpTarget,
    root: &FsPath,
    paths: &[String],
    backup_id: &str,
) -> Result<usize, String> {
    ftp.login(&target.username, &target.password)
        .map_err(|error| error.to_string())?;
    ftp.transfer_type(suppaftp::types::FileType::Binary)
        .map_err(|error| error.to_string())?;
    if target.remote_path.starts_with('/') {
        ftp.cwd("/").map_err(|error| error.to_string())?;
    }
    for segment in target
        .remote_path
        .split('/')
        .filter(|part| !part.is_empty())
    {
        ftp.cwd(segment).map_err(|error| error.to_string())?;
    }
    let base = ftp.pwd().map_err(|error| error.to_string())?;
    let staging = root
        .join(".dreamcraft")
        .join(format!("ftp-download-{backup_id}"));
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        for path in paths {
            ftp.cwd(&base).map_err(|error| error.to_string())?;
            let bytes = ftp
                .retr_as_buffer(path)
                .map_err(|error| format!("Could not download {path}: {error}"))?
                .into_inner();
            let staged = staging.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = staged.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(staged, bytes).map_err(|error| error.to_string())?;
        }
        for path in paths {
            let source = staging.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
            let destination =
                safe_sync_target(root, path).map_err(|_| format!("Unsafe local path: {path}"))?;
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(source, destination).map_err(|error| error.to_string())?;
        }
        Ok(paths.len())
    })();
    let _ = fs::remove_dir_all(staging);
    let _ = ftp.quit();
    result
}

async fn sync_ftp_download(
    State(state): State<AppState>,
    Json(request): Json<FtpSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.ftp.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure an FTP destination before downloading.",
        )
    })?;
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    if paths.is_empty()
        || paths.len() > 5_000
        || paths.iter().any(|path| !valid_remote_relative(path, false))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 5,000 safe remote files.",
        ));
    }
    let root = state.project_root();
    for path in &paths {
        safe_sync_target(&root, path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                format!("Unsafe local destination: {path}"),
            )
        })?;
    }
    let backup = create_release(&root).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not snapshot the site before FTP download.",
        )
    })?;
    let worker_target = target.clone();
    let worker_root = root.clone();
    let worker_paths = paths.clone();
    let worker_backup = backup.clone();
    let result = tokio::task::spawn_blocking(move || {
        if worker_target.secure {
            let stream = suppaftp::NativeTlsFtpStream::connect((
                worker_target.host.as_str(),
                worker_target.port,
            ))
            .map_err(|error| error.to_string())?;
            let connector = suppaftp::NativeTlsConnector::from(
                suppaftp::native_tls::TlsConnector::new().map_err(|error| error.to_string())?,
            );
            let mut ftp = stream
                .into_secure(connector, &worker_target.host)
                .map_err(|error| error.to_string())?;
            ftp_download_blocking(
                &mut ftp,
                &worker_target,
                &worker_root,
                &worker_paths,
                &worker_backup,
            )
        } else {
            let mut ftp =
                suppaftp::FtpStream::connect((worker_target.host.as_str(), worker_target.port))
                    .map_err(|error| error.to_string())?;
            ftp_download_blocking(
                &mut ftp,
                &worker_target,
                &worker_root,
                &worker_paths,
                &worker_backup,
            )
        }
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "FTP download worker stopped unexpectedly.",
        )
    })?;
    result
        .map(|files| Json(serde_json::json!({"files": files, "backup": backup})))
        .map_err(|message| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                format!("FTP download failed: {message}"),
            )
        })
}

async fn sync_ftp_upload(
    State(state): State<AppState>,
    Json(request): Json<FtpSyncRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.ftp.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure an FTP destination before uploading.",
        )
    })?;
    let mut paths = request.paths;
    paths.sort();
    paths.dedup();
    if paths.is_empty()
        || paths.len() > 5_000
        || paths.iter().any(|path| !valid_remote_relative(path, false))
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Select between 1 and 5,000 safe local files.",
        ));
    }
    let root = state.project_root();
    for path in &paths {
        let source = safe_sync_target(&root, path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                format!("Unsafe local file: {path}"),
            )
        })?;
        let metadata = fs::symlink_metadata(source).map_err(|_| {
            ai_error(
                StatusCode::NOT_FOUND,
                format!("Local file not found: {path}"),
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                format!("Only regular files can be uploaded: {path}"),
            ));
        }
    }
    let backup = create_release(&root).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not snapshot files before FTP upload.",
        )
    })?;
    let snapshot = root.join(".dreamcraft").join("releases").join(&backup);
    let worker_target = target.clone();
    let worker_paths = paths.clone();
    let result = tokio::task::spawn_blocking(move || {
        if worker_target.secure {
            let stream = suppaftp::NativeTlsFtpStream::connect((
                worker_target.host.as_str(),
                worker_target.port,
            ))
            .map_err(|error| error.to_string())?;
            let connector = suppaftp::NativeTlsConnector::from(
                suppaftp::native_tls::TlsConnector::new().map_err(|error| error.to_string())?,
            );
            let ftp = stream
                .into_secure(connector, &worker_target.host)
                .map_err(|error| error.to_string())?;
            upload_ftp_selected(ftp, &worker_target, &snapshot, &worker_paths)
        } else {
            let ftp =
                suppaftp::FtpStream::connect((worker_target.host.as_str(), worker_target.port))
                    .map_err(|error| error.to_string())?;
            upload_ftp_selected(ftp, &worker_target, &snapshot, &worker_paths)
        }
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "FTP upload worker stopped unexpectedly.",
        )
    })?;
    result
        .map(|files| Json(serde_json::json!({"files": files, "backup": backup})))
        .map_err(|message| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                format!("FTP upload failed: {message}"),
            )
        })
}

fn upload_ftp_selected<T: suppaftp::TlsStream + Send + 'static>(
    mut ftp: suppaftp::ImplFtpStream<T>,
    target: &FtpTarget,
    snapshot: &FsPath,
    paths: &[String],
) -> Result<usize, String> {
    ftp.login(&target.username, &target.password)
        .map_err(|error| error.to_string())?;
    ftp.transfer_type(suppaftp::types::FileType::Binary)
        .map_err(|error| error.to_string())?;
    if target.remote_path.starts_with('/') {
        ftp.cwd("/").map_err(|error| error.to_string())?;
    }
    for segment in target
        .remote_path
        .split('/')
        .filter(|part| !part.is_empty())
    {
        ensure_ftp_directory(&mut ftp, segment)?;
    }
    let base = ftp.pwd().map_err(|error| error.to_string())?;
    for path in paths {
        let parts = path.split('/').collect::<Vec<_>>();
        ftp.cwd(&base).map_err(|error| error.to_string())?;
        for part in &parts[..parts.len() - 1] {
            ensure_ftp_directory(&mut ftp, part)?;
        }
        let source = snapshot.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let mut file = fs::File::open(source).map_err(|error| error.to_string())?;
        ftp.put_file(parts[parts.len() - 1], &mut file)
            .map_err(|error| format!("Could not upload {path}: {error}"))?;
    }
    ftp.quit().map_err(|error| error.to_string())?;
    Ok(paths.len())
}

async fn publish_ftp(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let target = state.ftp.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Configure an FTP destination before publishing.",
        )
    })?;
    let release_id = create_release(&state.project_root()).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not create an immutable publish snapshot.",
        )
    })?;
    let root = state
        .project_root()
        .join(".dreamcraft")
        .join("releases")
        .join(&release_id);
    let files = tokio::task::spawn_blocking({
        let root = root.clone();
        move || collect_site_files(&root)
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not scan the site files.",
        )
    })?
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not read the site files.",
        )
    })?;
    let file_count = files.len();
    let destination = format!(
        "{}://{}:{}/{}",
        if target.secure { "ftps" } else { "ftp" },
        target.host,
        target.port,
        target.remote_path
    );
    let transfer = tokio::task::spawn_blocking(move || {
        if target.secure {
            let stream = suppaftp::NativeTlsFtpStream::connect((target.host.as_str(), target.port))
                .map_err(|error| error.to_string())?;
            let connector = suppaftp::NativeTlsConnector::from(
                suppaftp::native_tls::TlsConnector::new().map_err(|error| error.to_string())?,
            );
            let ftp = stream
                .into_secure(connector, &target.host)
                .map_err(|error| error.to_string())?;
            publish_ftp_files(ftp, &target, &root, &files)
        } else {
            let ftp = suppaftp::FtpStream::connect((target.host.as_str(), target.port))
                .map_err(|error| error.to_string())?;
            publish_ftp_files(ftp, &target, &root, &files)
        }
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "FTP upload worker stopped unexpectedly.",
        )
    })?;
    transfer.map_err(|message| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            format!("FTP upload failed: {message}"),
        )
    })?;
    Ok(Json(
        serde_json::json!({ "files": file_count, "destination": destination, "snapshot": release_id }),
    ))
}

async fn git_command(
    root: &FsPath,
    args: &[&str],
) -> Result<std::process::Output, (StatusCode, Json<AiError>)> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Git was not found. Install Git and make it available on PATH.",
            )
        })
}

async fn git_output(root: &FsPath, args: &[&str]) -> Result<String, (StatusCode, Json<AiError>)> {
    let output = git_command(root, args).await?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            if message.is_empty() {
                "Git command failed.".into()
            } else {
                message
            },
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn git_status(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let root = state.project_root();
    let check = match git_command(&root, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(output) if output.status.success() => true,
        Ok(_) => false,
        Err(error) if error.0 == StatusCode::SERVICE_UNAVAILABLE => return Err(error),
        Err(error) => return Err(error),
    };
    if !check {
        return Ok(Json(
            serde_json::json!({ "available": true, "repository": false, "branch": "", "branches": [], "tags": [], "files": [], "history": [] }),
        ));
    }
    let status = git_output(
        &root,
        &["status", "--porcelain=v1", "-b", "--untracked-files=all"],
    )
    .await?;
    let mut lines = status.lines();
    let branch_line = lines.next().unwrap_or("## HEAD");
    let branch = branch_line
        .trim_start_matches("## ")
        .split("...")
        .next()
        .unwrap_or("HEAD")
        .to_owned();
    let files: Vec<GitFile> = lines
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            Some(GitFile {
                status: line[..2].to_owned(),
                path: line[3..].to_owned(),
            })
        })
        .collect();
    let history = git_output(&root, &["log", "-10", "--format=%h%x09%s%x09%cr"])
        .await
        .unwrap_or_default()
        .lines()
        .map(|line| {
            let fields: Vec<_> = line.splitn(3, '\t').collect();
            serde_json::json!({
                "hash": fields.first().copied().unwrap_or(""),
                "subject": fields.get(1).copied().unwrap_or(""),
                "date": fields.get(2).copied().unwrap_or("")
            })
        })
        .collect::<Vec<_>>();
    let remote = git_output(&root, &["remote", "get-url", "origin"])
        .await
        .unwrap_or_default()
        .trim()
        .to_owned();
    let branches = git_output(&root, &["branch", "--format=%(refname:short)"])
        .await
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let tags = git_output(&root, &["tag", "--list"])
        .await
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok(Json(
        serde_json::json!({ "available": true, "repository": true, "branch": branch, "branches": branches, "tags": tags, "files": files, "history": history, "remote": remote }),
    ))
}

async fn git_init(
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    git_output(&state.project_root(), &["init"]).await?;
    let ignore = state.project_root().join(".gitignore");
    if !ignore.exists() {
        tokio::fs::write(
            ignore,
            ".dreamcraft/\nnode_modules/\n.DS_Store\nThumbs.db\n",
        )
        .await
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not write the project .gitignore.",
            )
        })?;
    }
    Ok(StatusCode::CREATED)
}

async fn git_stage(
    State(state): State<AppState>,
    Json(request): Json<GitPathRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    if let Some(path) = request.path {
        safe_path(&state.project_root(), &path)
            .map_err(|_| ai_error(StatusCode::BAD_REQUEST, "Choose a project-relative path."))?;
        git_output(&state.project_root(), &["add", "-A", "--", &path]).await?;
    } else {
        git_output(&state.project_root(), &["add", "-A"]).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn git_unstage(
    State(state): State<AppState>,
    Json(request): Json<GitPathRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    let path = request.path.unwrap_or_default();
    let has_commit = git_command(&state.project_root(), &["rev-parse", "--verify", "HEAD"])
        .await?
        .status
        .success();
    if !path.is_empty() {
        safe_path(&state.project_root(), &path)
            .map_err(|_| ai_error(StatusCode::BAD_REQUEST, "Choose a project-relative path."))?;
        if has_commit {
            git_output(&state.project_root(), &["reset", "-q", "HEAD", "--", &path]).await?;
        } else {
            git_output(
                &state.project_root(),
                &["rm", "--cached", "-r", "-f", "--", &path],
            )
            .await?;
        }
    } else {
        if has_commit {
            git_output(&state.project_root(), &["reset", "-q", "HEAD"]).await?;
        } else {
            git_output(&state.project_root(), &["rm", "--cached", "-r", "-f", "."]).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn git_commit(
    State(state): State<AppState>,
    Json(request): Json<GitCommitRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let message = request.message.trim();
    if message.is_empty() {
        return Err(ai_error(StatusCode::BAD_REQUEST, "Enter a commit message."));
    }
    git_output(&state.project_root(), &["commit", "-m", message]).await?;
    Ok(Json(serde_json::json!({ "committed": true })))
}

async fn git_action(
    State(state): State<AppState>,
    Json(request): Json<GitActionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let args: &[&str] = match request.action.as_str() {
        "fetch" => &["fetch", "--all", "--prune"],
        "pull" => &["pull", "--ff-only"],
        "push" => &["push"],
        "push-tags" => &["push", "--tags"],
        _ => {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "Choose fetch, pull, push, or push-tags.",
            ));
        }
    };
    let output = git_output(&state.project_root(), args).await?;
    Ok(Json(serde_json::json!({ "output": output.trim() })))
}

async fn git_branch(
    State(state): State<AppState>,
    Json(request): Json<GitBranchRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let root = state.project_root();
    let name = request.name.trim();
    if name.is_empty()
        || name.len() > 240
        || name.starts_with('-')
        || name.chars().any(char::is_control)
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Enter a valid Git branch name.",
        ));
    }
    let valid = git_command(&root, &["check-ref-format", "--branch", name]).await?;
    if !valid.status.success() {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Git rejected that branch name.",
        ));
    }
    let output = match request.action.as_str() {
        "switch" => {
            if !git_command(
                &root,
                &["rev-parse", "--verify", &format!("refs/heads/{name}")],
            )
            .await?
            .status
            .success()
            {
                return Err(ai_error(
                    StatusCode::NOT_FOUND,
                    "That local branch does not exist.",
                ));
            }
            git_command(&root, &["switch", "--", name]).await?
        }
        "merge" => {
            if !git_command(
                &root,
                &["rev-parse", "--verify", &format!("refs/heads/{name}")],
            )
            .await?
            .status
            .success()
            {
                return Err(ai_error(
                    StatusCode::NOT_FOUND,
                    "That local branch does not exist.",
                ));
            }
            let result = git_command(&root, &["merge", "--no-edit", "--", name]).await?;
            if !result.status.success() {
                let details = String::from_utf8_lossy(&result.stderr).trim().to_owned();
                let conflict = git_command(&root, &["diff", "--name-only", "--diff-filter=U"])
                    .await
                    .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_owned())
                    .unwrap_or_default();
                let message = if conflict.is_empty() {
                    format!("Git could not merge branch {name}: {details}")
                } else {
                    format!(
                        "Merge is in progress with conflicts in: {}. Resolve those files in DreamCraft, then commit to finish the merge.",
                        conflict.lines().collect::<Vec<_>>().join(", ")
                    )
                };
                return Err(ai_error(StatusCode::CONFLICT, message));
            }
            result
        }
        "create" => {
            if git_command(
                &root,
                &["rev-parse", "--verify", &format!("refs/heads/{name}")],
            )
            .await?
            .status
            .success()
            {
                return Err(ai_error(
                    StatusCode::CONFLICT,
                    "A local branch already has that name.",
                ));
            }
            git_command(&root, &["switch", "-c", name]).await?
        }
        _ => {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "Choose create, switch, or merge.",
            ));
        }
    };
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            if details.is_empty() {
                "Git branch operation failed.".into()
            } else {
                details
            },
        ));
    }
    Ok(Json(
        serde_json::json!({ "output": String::from_utf8_lossy(&output.stdout).trim() }),
    ))
}

async fn git_tag(
    State(state): State<AppState>,
    Json(request): Json<GitTagRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let root = state.project_root();
    let name = request.name.trim();
    if name.is_empty()
        || name.len() > 240
        || name.starts_with('-')
        || name.chars().any(char::is_control)
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Enter a valid Git tag name.",
        ));
    }
    let reference = format!("refs/tags/{name}");
    let valid = git_command(&root, &["check-ref-format", &reference]).await?;
    if !valid.status.success() {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Git rejected that tag name.",
        ));
    }
    let exists = git_command(&root, &["show-ref", "--verify", "--quiet", &reference])
        .await?
        .status
        .success();
    let output = match request.action.as_str() {
        "create" => {
            if exists {
                return Err(ai_error(
                    StatusCode::CONFLICT,
                    "A tag already has that name.",
                ));
            }
            let message = request
                .message
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(name);
            git_command(&root, &["tag", "-a", name, "-m", message]).await?
        }
        "delete" => {
            if !exists {
                return Err(ai_error(StatusCode::NOT_FOUND, "That tag does not exist."));
            }
            git_command(&root, &["tag", "-d", name]).await?
        }
        _ => {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "Choose create or delete.",
            ));
        }
    };
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            if details.is_empty() {
                "Git tag operation failed.".into()
            } else {
                details
            },
        ));
    }
    Ok(Json(
        serde_json::json!({ "output": String::from_utf8_lossy(&output.stdout).trim() }),
    ))
}

async fn git_revert(
    State(state): State<AppState>,
    Json(request): Json<GitRevertRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let root = state.project_root();
    let hash = request.hash.trim();
    if !(7..=64).contains(&hash.len()) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Choose a commit from the displayed Git history.",
        ));
    }
    let revision = format!("{hash}^{{commit}}");
    if !git_command(&root, &["rev-parse", "--verify", "--quiet", &revision])
        .await?
        .status
        .success()
    {
        return Err(ai_error(
            StatusCode::NOT_FOUND,
            "That commit is not available in this repository.",
        ));
    }
    let output = git_command(&root, &["revert", "--no-edit", hash]).await?;
    if !output.status.success() {
        let conflicts = git_command(&root, &["diff", "--name-only", "--diff-filter=U"])
            .await
            .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_owned())
            .unwrap_or_default();
        if !conflicts.is_empty() {
            return Err(ai_error(
                StatusCode::CONFLICT,
                format!(
                    "Revert is in progress with conflicts in: {}. Resolve those files, stage them, and commit to complete the revert.",
                    conflicts.lines().collect::<Vec<_>>().join(", ")
                ),
            ));
        }
        let details = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            if details.is_empty() {
                "Git could not revert that commit.".into()
            } else {
                details
            },
        ));
    }
    Ok(Json(
        serde_json::json!({ "output": String::from_utf8_lossy(&output.stdout).trim() }),
    ))
}

async fn git_remote(
    State(state): State<AppState>,
    Json(request): Json<GitRemoteRequest>,
) -> Result<StatusCode, (StatusCode, Json<AiError>)> {
    let url = request.url.trim();
    if url.is_empty() {
        return Err(ai_error(StatusCode::BAD_REQUEST, "Enter a remote URL."));
    }
    if url.chars().any(char::is_whitespace) {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "The Git remote URL cannot contain whitespace.",
        ));
    }
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if !matches!(parsed.scheme(), "https" | "http" | "ssh" | "git" | "file")
            || parsed.password().is_some()
            || (!parsed.username().is_empty() && parsed.scheme() != "ssh")
        {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "Use an HTTP, HTTPS, SSH, Git, or local path remote URL. Put credentials in Git's credential manager, not in the URL.",
            ));
        }
    } else {
        let Some((identity, _)) = url.split_once('@') else {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "Enter a valid repository URL.",
            ));
        };
        if identity.contains(':') || !url.contains(':') {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "Enter a valid repository URL without embedded credentials.",
            ));
        }
    }
    match git_command(&state.project_root(), &["remote", "get-url", "origin"]).await {
        Ok(output) if output.status.success() => {
            git_output(&state.project_root(), &["remote", "set-url", "origin", url]).await?;
        }
        _ => {
            git_output(&state.project_root(), &["remote", "add", "origin", url]).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn git_diff(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Query(staged): Query<GitStagedQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    safe_path(&state.project_root(), &path)
        .map_err(|_| ai_error(StatusCode::BAD_REQUEST, "Choose a project-relative path."))?;
    let result = if staged.staged {
        git_command(&state.project_root(), &["diff", "--cached", "--", &path]).await?
    } else {
        git_command(&state.project_root(), &["diff", "--", &path]).await?
    };
    let mut output = if result.status.success() {
        String::from_utf8_lossy(&result.stdout).into_owned()
    } else if result.status.code() == Some(1) {
        String::from_utf8_lossy(&result.stdout).into_owned()
    } else {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            String::from_utf8_lossy(&result.stderr).trim().to_owned(),
        ));
    };
    if output.is_empty() && !staged.staged {
        let status = git_command(
            &state.project_root(),
            &["status", "--porcelain=v1", "--", &path],
        )
        .await?;
        let status_text = String::from_utf8_lossy(&status.stdout);
        if status_text.lines().any(|line| line.starts_with("??")) {
            let target = safe_path(&state.project_root(), &path).map_err(|_| {
                ai_error(StatusCode::BAD_REQUEST, "Choose a project-relative path.")
            })?;
            if let Ok(content) = tokio::fs::read_to_string(&target).await {
                output = format!(
                    "Untracked file: {path}\n\n{}",
                    content
                        .lines()
                        .map(|line| format!("+{line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
            }
        }
    }
    Ok(Json(serde_json::json!({ "path": path, "diff": output })))
}

#[derive(Deserialize)]
struct GitStagedQuery {
    #[serde(default)]
    staged: bool,
}

fn ai_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<AiError>) {
    (
        status,
        Json(AiError {
            error: message.into(),
        }),
    )
}

async fn ai_settings(State(state): State<AppState>) -> Json<AiSettingsStatus> {
    let provider = state.ai.read().await;
    match provider.as_ref() {
        Some(provider) => Json(AiSettingsStatus {
            endpoint: provider.endpoint.clone(),
            model: provider.model.clone(),
            configured: true,
        }),
        None => Json(AiSettingsStatus {
            endpoint: "http://127.0.0.1:11434/v1".into(),
            model: String::new(),
            configured: false,
        }),
    }
}

async fn update_ai_settings(
    State(state): State<AppState>,
    Json(request): Json<AiSettingsUpdate>,
) -> Result<Json<AiSettingsStatus>, (StatusCode, Json<AiError>)> {
    let endpoint = request.endpoint.trim().trim_end_matches('/');
    let model = request.model.trim();
    let parsed = reqwest::Url::parse(endpoint).map_err(|_| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "Enter a valid HTTP or HTTPS endpoint.",
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "The endpoint must use HTTP or HTTPS.",
        ));
    }
    if model.is_empty() {
        return Err(ai_error(StatusCode::BAD_REQUEST, "Enter a model name."));
    }
    let mut provider = state.ai.write().await;
    let api_key = request.api_key.unwrap_or_default();
    let api_key = if api_key.trim().is_empty() {
        provider
            .as_ref()
            .map(|p| p.api_key.clone())
            .unwrap_or_default()
    } else {
        api_key.trim().to_owned()
    };
    let result = AiProvider {
        endpoint: endpoint.to_owned(),
        model: model.to_owned(),
        api_key,
    };
    let status = AiSettingsStatus {
        endpoint: result.endpoint.clone(),
        model: result.model.clone(),
        configured: true,
    };
    *provider = Some(result);
    Ok(Json(status))
}

async fn ai_provider(state: &AppState) -> Result<AiProvider, (StatusCode, Json<AiError>)> {
    state.ai.read().await.clone().ok_or_else(|| {
        ai_error(
            StatusCode::PRECONDITION_REQUIRED,
            "Configure a compatible AI endpoint and model first.",
        )
    })
}

async fn test_ai_connection(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    let provider = ai_provider(&state).await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the AI HTTP client.",
            )
        })?;
    let mut request = client
        .post(format!("{}/chat/completions", provider.endpoint))
        .json(&serde_json::json!({
            "model": provider.model,
            "messages": [{ "role": "user", "content": "Reply with: DreamCraft connection successful." }],
            "max_tokens": 24,
            "temperature": 0
        }));
    if !provider.api_key.is_empty() {
        request = request.bearer_auth(&provider.api_key);
    }
    let response = request.send().await.map_err(|_| ai_error(StatusCode::BAD_GATEWAY, "Could not reach the configured endpoint. Check the URL and that the service is running."))?;
    if !response.status().is_success() {
        return Err(ai_error(
            StatusCode::BAD_GATEWAY,
            format!(
                "The endpoint returned HTTP {} while testing chat completions.",
                response.status()
            ),
        ));
    }
    let body: serde_json::Value = response.json().await.map_err(|_| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            "The endpoint returned an invalid chat-completions response.",
        )
    })?;
    if body
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        return Err(ai_error(
            StatusCode::BAD_GATEWAY,
            "The endpoint did not return chat-completions message content.",
        ));
    }
    Ok(Json(
        serde_json::json!({ "connected": true, "model": provider.model }),
    ))
}

async fn ai_chat(
    State(state): State<AppState>,
    Json(request): Json<AiChatRequest>,
) -> Result<Json<AiChatResponse>, (StatusCode, Json<AiError>)> {
    ai_provider(&state).await?;
    if request.prompt.trim().is_empty() {
        return Err(ai_error(StatusCode::BAD_REQUEST, "Write a prompt first."));
    }
    if request.source.len() > 1_000_000 {
        return Err(ai_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "The open file is larger than the 1 MB AI context limit.",
        ));
    }
    match request.mode.as_str() {
        "edit" => {
            return ai_edit_completion(&state, request.prompt, request.path, request.source).await;
        }
        "chat" => {}
        _ => {
            return Err(ai_error(
                StatusCode::BAD_REQUEST,
                "Choose chat or single-file edit mode.",
            ));
        }
    }
    let mut messages = vec![AiMessage {
        role: "system".into(),
        content: "You are Dream AI, a practical web design and development assistant inside DreamCraft. Give direct explanations and produce complete, usable code when asked to edit the open file. When proposing a file edit, include exactly one fenced code block containing the complete replacement contents of the open file, with no ellipses or omitted sections. Never claim to have changed files; the user reviews and applies code explicitly.".into(),
    }];
    messages.extend(
        request
            .history
            .into_iter()
            .filter(|m| matches!(m.role.as_str(), "user" | "assistant"))
            .take(20),
    );
    let mut context_paths = request.context_paths;
    context_paths.truncate(40);
    let mut context_files = Vec::new();
    let mut context_size = request.source.len();
    for path in context_paths {
        if path == request.path || context_size >= 600_000 {
            continue;
        }
        let root = state.project_root();
        let target = safe_path(&root, &path).map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "The AI context contains an invalid project path.",
            )
        })?;
        let metadata = tokio::fs::metadata(&target).await.map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "A selected AI context file no longer exists.",
            )
        })?;
        let canonical_root = tokio::fs::canonicalize(&root).await.map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not resolve the active website folder.",
            )
        })?;
        let canonical_target = tokio::fs::canonicalize(&target).await.map_err(|_| {
            ai_error(
                StatusCode::BAD_REQUEST,
                "A selected AI context file could not be resolved.",
            )
        })?;
        if !metadata.is_file()
            || !canonical_target.starts_with(&canonical_root)
            || metadata.len() > 120_000
        {
            continue;
        }
        let content = tokio::fs::read_to_string(&canonical_target)
            .await
            .map_err(|_| {
                ai_error(
                    StatusCode::BAD_REQUEST,
                    "A selected AI context file is not valid UTF-8 text.",
                )
            })?;
        context_size += content.len();
        if context_size > 600_000 {
            break;
        }
        context_files.push(AiContextFile { path, content });
    }
    messages.push(AiMessage {
        role: "user".into(),
        content: format!(
            "Open file: {}\n\nCurrent complete file contents:\n{}\n\nAdditional project context files (read-only):\n{}\n\nRequest: {}",
            request.path, request.source,
            serde_json::to_string_pretty(&context_files).unwrap_or_default(),
            request.prompt
        ),
    });
    ai_completion(&state, messages).await
}

async fn ai_edit_completion(
    state: &AppState,
    prompt: String,
    path: String,
    source: String,
) -> Result<Json<AiChatResponse>, (StatusCode, Json<AiError>)> {
    if prompt.trim().is_empty() {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "Write an edit instruction first.",
        ));
    }
    if source.len() > 1_000_000 {
        return Err(ai_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "The open file is larger than the 1 MB AI edit limit.",
        ));
    }
    let root = state.project_root();
    let target = safe_path(&root, &path).map_err(|_| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "The AI edit target must be an existing file inside the active website.",
        )
    })?;
    let canonical_root = tokio::fs::canonicalize(&root).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not resolve the active website folder.",
        )
    })?;
    let canonical_target = tokio::fs::canonicalize(&target).await.map_err(|_| {
        ai_error(
            StatusCode::BAD_REQUEST,
            "The AI edit target no longer exists inside the active website.",
        )
    })?;
    if path.trim().is_empty()
        || path.chars().any(char::is_control)
        || !canonical_target.starts_with(&canonical_root)
        || !canonical_target.is_file()
    {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "The AI edit target must be an existing file inside the active website.",
        ));
    }
    let messages = vec![
        AiMessage {
            role: "system".into(),
            content: format!(
                "You edit one existing project file at a time. Return only the complete replacement contents of the file, with no Markdown fences, commentary, truncation, or omitted sections. Preserve existing behavior outside the requested change. If you cannot safely produce a complete file, return the exact token DREAMCRAFT_EDIT_UNAVAILABLE and nothing else. Target path: {path}"
            ),
        },
        AiMessage {
            role: "user".into(),
            content: format!(
                "Edit instruction:\n{prompt}\n\nCurrent complete file contents:\n{source}"
            ),
        },
    ];
    ai_completion(state, messages).await
}

async fn ai_completion(
    state: &AppState,
    messages: Vec<AiMessage>,
) -> Result<Json<AiChatResponse>, (StatusCode, Json<AiError>)> {
    let provider = ai_provider(state).await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|_| {
            ai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create the AI HTTP client.",
            )
        })?;
    let mut call = client.post(format!("{}/chat/completions", provider.endpoint))
        .json(&serde_json::json!({ "model": provider.model, "messages": messages, "temperature": 0.2 }));
    if !provider.api_key.is_empty() {
        call = call.bearer_auth(&provider.api_key);
    }
    let response = call.send().await.map_err(|_| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            "The AI request could not reach the configured endpoint.",
        )
    })?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(ai_error(
            StatusCode::BAD_GATEWAY,
            format!("AI endpoint returned HTTP {status}."),
        ));
    }
    let body: serde_json::Value = response.json().await.map_err(|_| {
        ai_error(
            StatusCode::BAD_GATEWAY,
            "The AI endpoint returned an invalid response.",
        )
    })?;
    let choice = body.pointer("/choices/0");
    let finish_reason = choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let content = choice
        .and_then(|choice| choice.pointer("/message/content"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            ai_error(
                StatusCode::BAD_GATEWAY,
                "The AI response did not include message content.",
            )
        })?;
    Ok(Json(AiChatResponse {
        content: content.to_owned(),
        finish_reason,
    }))
}

static RELEASE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn safe_path(root: &FsPath, relative: &str) -> Result<PathBuf, StatusCode> {
    let path = FsPath::new(relative);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(root.join(path))
}

fn list_files(root: &FsPath, folder: &FsPath, results: &mut Vec<FileEntry>) -> std::io::Result<()> {
    for item in fs::read_dir(folder)? {
        let item = item?;
        if item.file_name() == ".dreamcraft" {
            continue;
        }
        let path = item.path();
        let relative = path.strip_prefix(root).unwrap_or(&path);
        let meta = item.metadata()?;
        let is_dir = meta.is_dir();
        results.push(FileEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: relative.to_string_lossy().replace('\\', "/"),
            kind: if is_dir { "directory" } else { "file" },
            size: if is_dir { 0 } else { meta.len() },
            modified_ms: meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_millis()),
        });
        if is_dir {
            list_files(root, &path, results)?;
        }
    }
    Ok(())
}

async fn files(State(state): State<AppState>) -> Result<Json<Vec<FileEntry>>, StatusCode> {
    let root = state.project_root();
    tokio::task::spawn_blocking(move || {
        let mut entries = Vec::new();
        list_files(&root, &root, &mut entries).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        entries.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        Ok(Json(entries))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn browse_folders(
    headers: HeaderMap,
    Query(query): Query<FolderBrowseQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let has_origin = headers.contains_key(header::ORIGIN);
    let host_is_loopback = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| {
            host.starts_with("127.0.0.1:")
                || host == "127.0.0.1"
                || host.starts_with("localhost:")
                || host == "localhost"
        });
    if !host_is_loopback || (has_origin && !local_origin(&headers)) {
        return Err(StatusCode::FORBIDDEN);
    }
    let Some(requested) = query.path else {
        #[cfg(windows)]
        let roots: Vec<String> = ('A'..='Z')
            .filter_map(|drive| {
                let path = PathBuf::from(format!("{drive}:\\\\"));
                path.is_dir().then(|| path.to_string_lossy().into_owned())
            })
            .collect();
        #[cfg(not(windows))]
        let roots = vec![FsPath::new("/").to_string_lossy().into_owned()];
        return Ok(Json(
            serde_json::json!({ "current": "", "parent": null, "folders": [], "roots": roots }),
        ));
    };
    let canonical = fs::canonicalize(&requested).map_err(|_| StatusCode::NOT_FOUND)?;
    if !canonical.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut folders = Vec::new();
    for entry in fs::read_dir(&canonical).map_err(|_| StatusCode::FORBIDDEN)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            folders.push(serde_json::json!({
                "name": entry.file_name().to_string_lossy(),
                "path": entry.path().to_string_lossy(),
            }));
        }
    }
    folders.sort_by(|left, right| {
        left.get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_lowercase()
            .cmp(
                &right
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_lowercase(),
            )
    });
    let parent = canonical
        .parent()
        .filter(|path| *path != canonical)
        .map(|path| path.to_string_lossy().into_owned());
    Ok(Json(serde_json::json!({
        "current": canonical.to_string_lossy(),
        "parent": parent,
        "folders": folders,
        "roots": []
    })))
}

#[derive(Debug)]
struct ProjectSassFs {
    root: PathBuf,
}

impl ProjectSassFs {
    fn resolve(&self, path: &FsPath) -> Option<PathBuf> {
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        };
        let resolved = fs::canonicalize(candidate).ok()?;
        resolved.starts_with(&self.root).then_some(resolved)
    }
}

impl grass::Fs for ProjectSassFs {
    fn is_dir(&self, path: &FsPath) -> bool {
        self.resolve(path).is_some_and(|resolved| resolved.is_dir())
    }

    fn is_file(&self, path: &FsPath) -> bool {
        self.resolve(path)
            .is_some_and(|resolved| resolved.is_file())
    }

    fn read(&self, path: &FsPath) -> std::io::Result<Vec<u8>> {
        let resolved = self.resolve(path).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Sass imports must stay inside the active website.",
            )
        })?;
        fs::read(resolved)
    }

    fn canonicalize(&self, path: &FsPath) -> std::io::Result<PathBuf> {
        self.resolve(path).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Sass imports must stay inside the active website.",
            )
            .into()
        })
    }
}

async fn build_sass(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SassBuildRequest>,
) -> Response {
    if !local_origin(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(AiError {
                error: "Sass builds are available only to the local DreamCraft editor.".into(),
            }),
        )
            .into_response();
    }
    let root = state.project_root();
    let result =
        tokio::task::spawn_blocking(move || -> Result<SassBuildResult, (StatusCode, String)> {
            let root = fs::canonicalize(&root).map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "The active website folder is unavailable.".into(),
                )
            })?;
            let source = safe_path(&root, &request.path).map_err(|_| {
                (
                    StatusCode::BAD_REQUEST,
                    "Choose a Sass or SCSS file inside the active website.".into(),
                )
            })?;
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(extension.as_str(), "scss" | "sass") {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "The Sass compiler accepts .scss and indented .sass files.".into(),
                ));
            }
            let source = fs::canonicalize(&source).map_err(|_| {
                (
                    StatusCode::NOT_FOUND,
                    "The Sass source file could not be found.".into(),
                )
            })?;
            if !source.starts_with(&root) {
                return Err((
                    StatusCode::FORBIDDEN,
                    "The Sass source resolves outside the active website.".into(),
                ));
            }
            let output = safe_path(&root, &request.output).map_err(|_| {
                (
                    StatusCode::BAD_REQUEST,
                    "Choose a CSS output path inside the active website.".into(),
                )
            })?;
            if output
                .extension()
                .and_then(|value| value.to_str())
                .is_none_or(|value| !value.eq_ignore_ascii_case("css"))
            {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "The compiled stylesheet must use the .css extension.".into(),
                ));
            }
            if output == source {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "The generated CSS cannot overwrite its Sass source.".into(),
                ));
            }
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|_| {
                    (
                        StatusCode::FORBIDDEN,
                        "The CSS output folder could not be created.".into(),
                    )
                })?;
                let parent = fs::canonicalize(parent).map_err(|_| {
                    (
                        StatusCode::BAD_REQUEST,
                        "The CSS output folder is not available.".into(),
                    )
                })?;
                if !parent.starts_with(&root) {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "The CSS output folder resolves outside the active website.".into(),
                    ));
                }
            }
            if let Ok(metadata) = fs::symlink_metadata(&output) {
                if metadata.file_type().is_symlink() || metadata.is_dir() {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "The CSS output cannot replace a symbolic link or folder.".into(),
                    ));
                }
            }
            let style = match request.style.as_deref().unwrap_or("expanded") {
                "expanded" => grass::OutputStyle::Expanded,
                "compressed" => grass::OutputStyle::Compressed,
                _ => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "Choose expanded or compressed CSS output.".into(),
                    ));
                }
            };
            let sass_fs = ProjectSassFs { root: root.clone() };
            let options = grass::Options::default()
                .fs(&sass_fs)
                .load_path(root.join("node_modules"))
                .style(style);
            let css = grass::from_path(&source, &options)
                .map_err(|error| (StatusCode::UNPROCESSABLE_ENTITY, error.to_string()))?;
            if css.len() > 32 * 1024 * 1024 {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "The generated CSS exceeds DreamCraft's 32 MB output limit.".into(),
                ));
            }
            fs::write(&output, css.as_bytes()).map_err(|_| {
                (
                    StatusCode::FORBIDDEN,
                    "DreamCraft could not write the generated CSS file.".into(),
                )
            })?;
            Ok(SassBuildResult {
                path: request.path,
                output: request.output,
                bytes: css.len(),
            })
        })
        .await;
    match result {
        Ok(Ok(result)) => Json(result).into_response(),
        Ok(Err((status, error))) => (status, Json(AiError { error })).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(AiError {
                error: "The Sass compiler stopped unexpectedly.".into(),
            }),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct DatabasePathRequest {
    path: String,
}

#[derive(Deserialize)]
struct DatabaseQueryRequest {
    path: String,
    sql: String,
    #[serde(default)]
    params: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct RemoteDatabaseRequest {
    engine: String,
    name: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String,
    #[serde(default)]
    tls: bool,
}

struct DetectedBrowser {
    id: &'static str,
    name: &'static str,
    executable: PathBuf,
}

#[derive(Serialize)]
struct BrowserInfo {
    id: &'static str,
    name: &'static str,
}

#[derive(Deserialize)]
struct ExternalPreviewRequest {
    browser_id: String,
    url: String,
}

#[derive(Deserialize)]
struct BrowserTestRequest {
    browser_id: String,
    url: String,
}

#[derive(Serialize)]
struct BrowserTestIssue {
    severity: &'static str,
    path: String,
    line: usize,
    message: String,
}

fn chromium_browser_id(id: &str) -> bool {
    matches!(id, "edge" | "chrome" | "chromium" | "brave")
}

async fn websocket_json(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    value: serde_json::Value,
) -> Result<(), StatusCode> {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

async fn run_browser_test(
    headers: HeaderMap,
    Json(request): Json<BrowserTestRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    let target = validate_external_preview_target(&request.url, origin)?;
    if !chromium_browser_id(&request.browser_id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let browser = discover_external_browsers()
        .into_iter()
        .find(|browser| browser.id == request.browser_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let profile = tempfile::tempdir().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let profile_path = profile.path().to_path_buf();
    let mut child = Command::new(&browser.executable)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--remote-debugging-port=0",
        ])
        .arg(format!("--user-data-dir={}", profile_path.display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let active_port_path = profile_path.join("DevToolsActivePort");
    let mut ws_url = None;
    for _ in 0..100 {
        if let Ok(contents) = tokio::fs::read_to_string(&active_port_path).await {
            if let Some(port) = contents
                .lines()
                .next()
                .and_then(|line| line.parse::<u16>().ok())
            {
                let endpoint = format!("http://127.0.0.1:{port}/json/version");
                if let Ok(response) = reqwest::get(endpoint).await {
                    if let Ok(json) = response.json::<serde_json::Value>().await {
                        ws_url = json
                            .get("webSocketDebuggerUrl")
                            .and_then(|value| value.as_str())
                            .map(str::to_owned);
                    }
                }
            }
        }
        if ws_url.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let Some(ws_url) = ws_url else {
        let _ = child.kill().await;
        return Err(StatusCode::GATEWAY_TIMEOUT);
    };
    let result = async {
        let (mut socket, _) = connect_async(ws_url).await.map_err(|_| StatusCode::BAD_GATEWAY)?;
        websocket_json(&mut socket, serde_json::json!({"id":1,"method":"Target.createTarget","params":{"url":"about:blank"}})).await?;
        let mut target_id = None;
        for _ in 0..32 {
            let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next()).await.map_err(|_| StatusCode::GATEWAY_TIMEOUT)?.ok_or(StatusCode::BAD_GATEWAY)?.map_err(|_| StatusCode::BAD_GATEWAY)?;
            if let Message::Text(text) = message {
                let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| StatusCode::BAD_GATEWAY)?;
                if value.get("id").and_then(|id| id.as_u64()) == Some(1) { target_id = value.pointer("/result/targetId").and_then(|id| id.as_str()).map(str::to_owned); break; }
            }
        }
        let target_id = target_id.ok_or(StatusCode::BAD_GATEWAY)?;
        websocket_json(&mut socket, serde_json::json!({"id":2,"method":"Target.attachToTarget","params":{"targetId":target_id,"flatten":true}})).await?;
        let mut session_id = None;
        for _ in 0..32 {
            let message = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next()).await.map_err(|_| StatusCode::GATEWAY_TIMEOUT)?.ok_or(StatusCode::BAD_GATEWAY)?.map_err(|_| StatusCode::BAD_GATEWAY)?;
            if let Message::Text(text) = message {
                let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| StatusCode::BAD_GATEWAY)?;
                if value.get("id").and_then(|id| id.as_u64()) == Some(2) { session_id = value.pointer("/result/sessionId").and_then(|id| id.as_str()).map(str::to_owned); break; }
            }
        }
        let session_id = session_id.ok_or(StatusCode::BAD_GATEWAY)?;
        for (id, method) in [(3,"Runtime.enable"),(4,"Network.enable"),(5,"Page.enable")] {
            websocket_json(&mut socket, serde_json::json!({"id":id,"method":method,"sessionId":session_id})).await?;
        }
        websocket_json(&mut socket, serde_json::json!({"id":7,"method":"Page.navigate","params":{"url":target.as_str()},"sessionId":session_id})).await?;
        let mut issues: Vec<BrowserTestIssue> = Vec::new();
        let mut network_urls = std::collections::HashMap::new();
        let mut loaded = false;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while tokio::time::Instant::now() < deadline {
            let wait = deadline.saturating_duration_since(tokio::time::Instant::now()).min(std::time::Duration::from_secs(2));
            let Ok(Some(Ok(Message::Text(text)))) = tokio::time::timeout(wait, socket.next()).await else { if loaded { break; } else { continue; } };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue; };
            if value.get("sessionId").and_then(|v| v.as_str()) != Some(&session_id) { continue; }
            let method = value.get("method").and_then(|v| v.as_str()).unwrap_or("");
            let params = value.get("params").cloned().unwrap_or_default();
            let (severity, path, line, message) = match method {
                "Page.loadEventFired" => { loaded = true; continue; }
                "Network.requestWillBeSent" => {
                    if let (Some(id), Some(url)) = (params.get("requestId").and_then(|v|v.as_str()), params.pointer("/request/url").and_then(|v|v.as_str())) { network_urls.insert(id.to_owned(), url.to_owned()); }
                    continue;
                }
                "Network.responseReceived" => {
                    let status = params.pointer("/response/status").and_then(|v|v.as_u64()).unwrap_or(200);
                    if status >= 400 {
                        let request_id = params.get("requestId").and_then(|v|v.as_str()).unwrap_or("");
                        let url = params.pointer("/response/url").and_then(|v|v.as_str()).or_else(||network_urls.get(request_id).map(String::as_str)).unwrap_or(target.path());
                        if reqwest::Url::parse(url).ok().is_some_and(|url| url.path().ends_with("/favicon.ico")) { continue; }
                        let message = format!("HTTP {status} while loading this resource.");
                        if issues.len() < 500 {
                            let normalized_path = if url.starts_with("http://") || url.starts_with("https://") { reqwest::Url::parse(url).ok().map(|url|url.path().to_owned()).unwrap_or_else(||target.path().to_owned()) } else { url.to_owned() };
                            issues.push(BrowserTestIssue { severity:"error", path:normalized_path, line:0, message });
                        }
                    }
                    continue;
                }
                "Runtime.exceptionThrown" => {
                    let details = params.pointer("/exceptionDetails").cloned().unwrap_or_default();
                    let exception = details.pointer("/exception/description").or_else(|| details.get("text")).and_then(|v| v.as_str()).unwrap_or("Unhandled JavaScript exception");
                    let frame = details.pointer("/stackTrace/callFrames/0");
                    ("error", frame.and_then(|v|v.get("url")).and_then(|v|v.as_str()).unwrap_or(target.path()).to_owned(), frame.and_then(|v|v.get("lineNumber")).and_then(|v|v.as_u64()).unwrap_or(0) as usize, exception.to_owned())
                }
                "Runtime.consoleAPICalled" if params.get("type").and_then(|v|v.as_str()) == Some("error") => {
                    let text = params.get("args").and_then(|v|v.as_array()).map(|args| args.iter().filter_map(|arg|arg.get("value").and_then(|v|v.as_str()).or_else(||arg.get("description").and_then(|v|v.as_str()))).collect::<Vec<_>>().join(" ")).filter(|text|!text.is_empty()).unwrap_or_else(||"Browser console error".to_owned());
                    if text.starts_with("Failed to load resource:") { continue; }
                    let frame = params.pointer("/stackTrace/callFrames/0");
                    ("error", frame.and_then(|v|v.get("url")).and_then(|v|v.as_str()).unwrap_or(target.path()).to_owned(), frame.and_then(|v|v.get("lineNumber")).and_then(|v|v.as_u64()).unwrap_or(0) as usize, text)
                }
                "Network.loadingFailed" => {
                    let request_id = params.get("requestId").and_then(|v|v.as_str()).unwrap_or("");
                    let url = network_urls.get(request_id).map(String::as_str).unwrap_or(target.path());
                    if reqwest::Url::parse(url).ok().is_some_and(|url| url.path().ends_with("/favicon.ico")) { continue; }
                    ("warning", url.to_owned(), 0, format!("Network request failed: {}", params.get("errorText").and_then(|v|v.as_str()).unwrap_or("unknown error")))
                }
                _ => continue,
            };
            if issues.len() < 500 {
                let normalized_path = if path.starts_with("http://") || path.starts_with("https://") { reqwest::Url::parse(&path).ok().map(|url| url.path().to_owned()).unwrap_or_else(|| target.path().to_owned()) } else { path };
                issues.push(BrowserTestIssue { severity, path: normalized_path, line, message: message.chars().take(1000).collect() });
            }
        }
        if !loaded { issues.push(BrowserTestIssue { severity:"error", path:target.path().to_owned(), line:0, message:"Page did not finish loading within 15 seconds.".into() }); }
        let _ = websocket_json(&mut socket, serde_json::json!({"id":8,"method":"Browser.close"})).await;
        Ok::<_,StatusCode>((issues,loaded))
    }.await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    drop(profile);
    let (issues, loaded) = result?;
    Ok(Json(
        serde_json::json!({"browser":browser.name,"loaded":loaded,"issues":issues}),
    ))
}

fn discover_external_browsers() -> Vec<DetectedBrowser> {
    let mut candidates: Vec<(&'static str, &'static str, PathBuf)> = Vec::new();
    #[cfg(windows)]
    {
        let roots = [
            std::env::var_os("ProgramFiles").map(PathBuf::from),
            std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        ];
        let known = [
            (
                "edge",
                "Microsoft Edge",
                "Microsoft/Edge/Application/msedge.exe",
            ),
            (
                "chrome",
                "Google Chrome",
                "Google/Chrome/Application/chrome.exe",
            ),
            ("firefox", "Mozilla Firefox", "Mozilla Firefox/firefox.exe"),
            (
                "brave",
                "Brave",
                "BraveSoftware/Brave-Browser/Application/brave.exe",
            ),
        ];
        for root in roots.into_iter().flatten() {
            for (id, name, relative) in known {
                candidates.push((id, name, root.join(relative)));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        for (id, name, executable) in [
            (
                "safari",
                "Safari",
                "/Applications/Safari.app/Contents/MacOS/safarilauncher",
            ),
            (
                "chrome",
                "Google Chrome",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ),
            (
                "firefox",
                "Mozilla Firefox",
                "/Applications/Firefox.app/Contents/MacOS/firefox",
            ),
        ] {
            candidates.push((id, name, PathBuf::from(executable)));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let path_dirs = std::env::var_os("PATH").unwrap_or_default();
        for directory in std::env::split_paths(&path_dirs) {
            for (id, name, executable) in [
                ("chrome", "Google Chrome", "google-chrome"),
                ("chromium", "Chromium", "chromium"),
                ("firefox", "Mozilla Firefox", "firefox"),
                ("brave", "Brave", "brave-browser"),
            ] {
                candidates.push((id, name, directory.join(executable)));
            }
        }
    }
    let mut detected = Vec::new();
    for (id, name, executable) in candidates {
        if executable.is_file() && !detected.iter().any(|item: &DetectedBrowser| item.id == id) {
            detected.push(DetectedBrowser {
                id,
                name,
                executable,
            });
        }
    }
    detected
}

fn validate_external_preview_target(
    target: &str,
    origin: &str,
) -> Result<reqwest::Url, StatusCode> {
    let target = reqwest::Url::parse(target).map_err(|_| StatusCode::BAD_REQUEST)?;
    let origin = reqwest::Url::parse(&format!("{origin}/")).map_err(|_| StatusCode::FORBIDDEN)?;
    if target.scheme() != "http"
        || !target.username().is_empty()
        || target.password().is_some()
        || target.origin() != origin.origin()
        || !(target.path().starts_with("/published/") || target.path().starts_with("/site/"))
        || target
            .path_segments()
            .is_some_and(|mut segments| segments.any(|segment| segment == "." || segment == ".."))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(target)
}

async fn external_browser_list(headers: HeaderMap) -> Result<Json<Vec<BrowserInfo>>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(Json(
        discover_external_browsers()
            .into_iter()
            .map(|browser| BrowserInfo {
                id: browser.id,
                name: browser.name,
            })
            .collect(),
    ))
}

async fn open_external_preview(
    headers: HeaderMap,
    Json(request): Json<ExternalPreviewRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    let target = validate_external_preview_target(&request.url, origin)?;
    let browser = discover_external_browsers()
        .into_iter()
        .find(|browser| browser.id == request.browser_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    tokio::process::Command::new(&browser.executable)
        .arg(target.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(
        serde_json::json!({"opened":true,"browser":browser.name,"url":target.as_str()}),
    ))
}

fn project_revision(root: &FsPath) -> Result<String, StatusCode> {
    let mut hasher = DefaultHasher::new();
    fn hash_directory(
        root: &FsPath,
        folder: &FsPath,
        hasher: &mut DefaultHasher,
        depth: usize,
    ) -> std::io::Result<()> {
        if depth > 64 {
            return Ok(());
        }
        let mut items = fs::read_dir(folder)?.collect::<Result<Vec<_>, _>>()?;
        items.sort_by_key(|item| item.file_name());
        for item in items {
            let name = item.file_name();
            if matches!(name.to_str(), Some(".dreamcraft" | ".git" | "node_modules")) {
                continue;
            }
            let path = item.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            path.strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .hash(hasher);
            metadata.len().hash(hasher);
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos())
                .hash(hasher);
            if metadata.is_dir() {
                hash_directory(root, &path, hasher, depth + 1)?;
            }
        }
        Ok(())
    }
    hash_directory(root, root, &mut hasher, 0).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(format!("{:016x}", hasher.finish()))
}

async fn live_preview_version(State(state): State<AppState>) -> Result<String, StatusCode> {
    let root = state.project_root();
    tokio::task::spawn_blocking(move || project_revision(&root))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn device_preview_file(
    State(state): State<DevicePreviewState>,
    Path((token, path)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
    if token != state.token {
        return Err(StatusCode::NOT_FOUND);
    }
    let root = state
        .root
        .read()
        .expect("project root lock poisoned")
        .clone();
    let prefix = format!("/preview/{token}");
    let version_url = format!("{prefix}/live-version");
    serve_project_file(root, &path, &prefix, &version_url).await
}

async fn device_preview_version(
    State(state): State<DevicePreviewState>,
    Path(token): Path<String>,
) -> Result<Response, StatusCode> {
    if token != state.token {
        return Err(StatusCode::NOT_FOUND);
    }
    let root = state
        .root
        .read()
        .expect("project root lock poisoned")
        .clone();
    let version = tokio::task::spawn_blocking(move || project_revision(&root))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;
    Ok(([(header::CACHE_CONTROL, "no-store")], version).into_response())
}

async fn stop_device_preview(state: &AppState) {
    if let Some(session) = state.device_preview.lock().await.take() {
        let _ = session.shutdown.send(());
        session.task.abort();
    }
}

async fn stop_device_preview_endpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    stop_device_preview(&state).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn device_preview_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DevicePreviewStatus>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let session = state.device_preview.lock().await;
    Ok(Json(match session.as_ref() {
        Some(session) => DevicePreviewStatus {
            active: true,
            url: Some(session.url.clone()),
        },
        None => DevicePreviewStatus {
            active: false,
            url: None,
        },
    }))
}

async fn start_device_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DevicePreviewStatus>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(session) = state.device_preview.lock().await.as_ref() {
        return Ok(Json(DevicePreviewStatus {
            active: true,
            url: Some(session.url.clone()),
        }));
    }
    let route_probe =
        std::net::UdpSocket::bind("0.0.0.0:0").map_err(|_| StatusCode::BAD_GATEWAY)?;
    route_probe
        .connect("192.0.2.1:80")
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let lan_ip = route_probe
        .local_addr()
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .ip();
    if lan_ip.is_loopback() || lan_ip.is_unspecified() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let port = listener
        .local_addr()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let preview_state = DevicePreviewState {
        root: state.root.clone(),
        token: token.clone(),
    };
    let app = Router::new()
        .route("/preview/{token}/live-version", get(device_preview_version))
        .route("/preview/{token}/{*path}", get(device_preview_file))
        .with_state(preview_state);
    let (shutdown, shutdown_receiver) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_receiver.await;
            })
            .await;
    });
    let url = format!("http://{lan_ip}:{port}/preview/{token}/index.html");
    *state.device_preview.lock().await = Some(DevicePreviewSession {
        url: url.clone(),
        shutdown,
        task,
    });
    Ok(Json(DevicePreviewStatus {
        active: true,
        url: Some(url),
    }))
}

fn remote_database_url(request: &RemoteDatabaseRequest) -> Result<String, StatusCode> {
    let engine = request.engine.to_ascii_lowercase();
    let (scheme, default_port) = match engine.as_str() {
        "mysql" => ("mysql", 3306),
        "postgres" | "postgresql" => ("postgres", 5432),
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    if request.port == 0
        || request.host.is_empty()
        || request.host.len() > 253
        || request.database.is_empty()
        || request.database.len() > 128
        || request.username.len() > 128
        || request.password.len() > 1024
        || request.name.len() > 80
        || [
            request.host.as_str(),
            request.database.as_str(),
            request.username.as_str(),
            request.name.as_str(),
        ]
        .iter()
        .any(|value| value.chars().any(char::is_control))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut url = reqwest::Url::parse(&format!("{scheme}://localhost:{default_port}/"))
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    url.set_host(Some(&request.host))
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    url.set_port(Some(request.port))
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    url.set_username(&request.username)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    url.set_password(Some(&request.password))
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    url.set_path(&request.database);
    if request.tls {
        url.query_pairs_mut().append_pair(
            if scheme == "postgres" {
                "sslmode"
            } else {
                "ssl-mode"
            },
            if scheme == "postgres" {
                "verify-full"
            } else {
                "REQUIRED"
            },
        );
    }
    Ok(url.to_string())
}

async fn open_remote_database(
    request: &RemoteDatabaseRequest,
) -> Result<ExternalDatabase, StatusCode> {
    let url = remote_database_url(request)?;
    let pool = AnyPoolOptions::new()
        .max_connections(3)
        .acquire_timeout(std::time::Duration::from_secs(8))
        .connect(&url)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(ExternalDatabase {
        engine: if request.engine.eq_ignore_ascii_case("mysql") {
            "mysql"
        } else {
            "postgres"
        }
        .into(),
        name: if request.name.trim().is_empty() {
            request.database.clone()
        } else {
            request.name.trim().to_owned()
        },
        host: request.host.clone(),
        port: request.port,
        database: request.database.clone(),
        username: request.username.clone(),
        password: request.password.clone(),
        tls: request.tls,
        pool,
    })
}

fn remote_database_public(database: Option<&ExternalDatabase>) -> serde_json::Value {
    match database {
        Some(db) => {
            serde_json::json!({"connected":true,"engine":db.engine,"name":db.name,"host":db.host,"port":db.port,"database":db.database,"username":db.username,"tls":db.tls})
        }
        None => serde_json::json!({"connected":false}),
    }
}

async fn remote_database_connection(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let connection = state.external_database.read().await;
    Ok(Json(remote_database_public(connection.as_ref())))
}

async fn remote_database_connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RemoteDatabaseRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let database = open_remote_database(&request).await?;
    let result = remote_database_public(Some(&database));
    stop_testing_server(&state).await;
    let mut current = state.external_database.write().await;
    if let Some(previous) = current.replace(database) {
        previous.pool.close().await;
    }
    Ok(Json(result))
}

async fn remote_database_disconnect(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(database) = state.external_database.write().await.take() {
        stop_testing_server(&state).await;
        database.pool.close().await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RemoteDatabaseQueryRequest {
    sql: String,
    #[serde(default)]
    params: Vec<serde_json::Value>,
}

fn external_sql_arguments(values: &[serde_json::Value]) -> Result<AnyArguments, StatusCode> {
    let mut arguments = AnyArguments::default();
    for value in values {
        match value {
            serde_json::Value::Null => arguments.add(Option::<String>::None),
            serde_json::Value::Bool(value) => arguments.add(*value),
            serde_json::Value::Number(value) if value.as_i64().is_some() => {
                arguments.add(value.as_i64().unwrap())
            }
            serde_json::Value::Number(value) if value.as_f64().is_some() => {
                arguments.add(value.as_f64().unwrap())
            }
            serde_json::Value::String(value) if value.len() <= 1024 * 1024 => {
                arguments.add(value.clone())
            }
            _ => return Err(StatusCode::BAD_REQUEST),
        }
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    }
    Ok(arguments)
}

async fn remote_database_schema(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let guard = state.external_database.read().await;
    let db = guard.as_ref().ok_or(StatusCode::CONFLICT)?;
    let sql = if db.engine == "mysql" {
        "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_TYPE, TABLE_NAME"
    } else {
        "SELECT table_name, CASE WHEN table_type = 'VIEW' THEN 'VIEW' ELSE 'BASE TABLE' END FROM information_schema.tables WHERE table_schema = current_schema() AND table_type IN ('BASE TABLE','VIEW') ORDER BY table_type, table_name"
    };
    let rows = sqlx::query_as::<sqlx::Any, (String, String)>(sql)
        .fetch_all(&db.pool)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut tables = Vec::new();
    for (name, kind_raw) in rows {
        let columns_sql = if db.engine == "mysql" {
            "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, COALESCE(CAST(k.ORDINAL_POSITION AS CHAR), '0'), IF(c.EXTRA LIKE '%auto_increment%', 'YES', 'NO') FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME AND k.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION"
        } else {
            "SELECT c.column_name, c.data_type, c.is_nullable, COALESCE(k.ordinal_position, 0)::text, CASE WHEN c.is_identity = 'YES' OR c.column_default LIKE 'nextval(%' THEN 'YES' ELSE 'NO' END FROM information_schema.columns c LEFT JOIN information_schema.key_column_usage k ON k.table_schema=c.table_schema AND k.table_name=c.table_name AND k.column_name=c.column_name LEFT JOIN information_schema.table_constraints tc ON tc.table_schema=k.table_schema AND tc.table_name=k.table_name AND tc.constraint_name=k.constraint_name AND tc.constraint_type='PRIMARY KEY' WHERE c.table_schema = current_schema() AND c.table_name = $1 AND (k.constraint_name IS NULL OR tc.constraint_type = 'PRIMARY KEY') ORDER BY c.ordinal_position"
        };
        let columns =
            sqlx::query_as::<sqlx::Any, (String, String, String, String, String)>(columns_sql)
                .bind(&name)
                .fetch_all(&db.pool)
                .await
                .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let mut schema_columns = Vec::new();
        for (column_name, column_type, nullable, key_order, auto_generated) in columns {
            schema_columns.push(serde_json::json!({"name":column_name,"type":column_type,"notNull":nullable.eq_ignore_ascii_case("NO"),"primaryKeyOrder":key_order.parse::<usize>().unwrap_or(0),"autoGenerated":auto_generated.eq_ignore_ascii_case("YES")}));
        }
        tables.push(serde_json::json!({"name":name,"kind":if kind_raw.eq_ignore_ascii_case("VIEW") { "view" } else { "table" },"columns":schema_columns}));
    }
    Ok(Json(serde_json::json!({"tables":tables})))
}

async fn remote_database_query(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RemoteDatabaseQueryRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    if request.sql.trim().is_empty()
        || request.sql.len() > 1024 * 1024
        || request.params.len() > 500
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let arguments = external_sql_arguments(&request.params)?;
    let guard = state.external_database.read().await;
    let db = guard.as_ref().ok_or(StatusCode::CONFLICT)?;
    let first = request
        .sql
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    // The database panel is an intentional SQL workbench: the user explicitly submits SQL here,
    // while all values remain bound separately. AssertSqlSafe marks that reviewed product boundary.
    let returns_rows = matches!(
        first.as_str(),
        "select" | "show" | "describe" | "desc" | "explain" | "with"
    ) || request.sql.to_ascii_lowercase().contains(" returning ");
    if returns_rows {
        let rows =
            sqlx::query_with::<sqlx::Any, _>(sqlx::AssertSqlSafe(request.sql.clone()), arguments)
                .fetch_all(&db.pool)
                .await
                .map_err(|_| StatusCode::BAD_REQUEST)?;
        let columns = rows
            .first()
            .map(|row| {
                row.columns()
                    .iter()
                    .map(|column| column.name().to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut result_rows = Vec::new();
        let mut size = 0usize;
        for row in rows.iter().take(1001) {
            if result_rows.len() == 1000 {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            let mut values = Vec::with_capacity(columns.len());
            for (index, column) in row.columns().iter().enumerate() {
                let type_name = column.type_info().name().to_ascii_lowercase();
                let value = if ["bool", "boolean"].contains(&type_name.as_str()) { row.try_get::<Option<bool>,_>(index).map(|v| v.map(serde_json::Value::Bool)) }
                    else if ["tinyint", "smallint", "int", "integer", "bigint", "int2", "int4", "int8"].contains(&type_name.as_str()) { row.try_get::<Option<i64>,_>(index).map(|v| v.map(|n|serde_json::json!(n))) }
                    else if ["float", "double", "real", "float4", "float8", "numeric", "decimal"].contains(&type_name.as_str()) { row.try_get::<Option<f64>,_>(index).map(|v| v.and_then(serde_json::Number::from_f64).map(serde_json::Value::Number)) }
                    else if ["bytea", "blob", "binary", "varbinary", "longblob"].contains(&type_name.as_str()) { row.try_get::<Option<Vec<u8>>,_>(index).map(|v| v.map(|bytes|serde_json::json!({"type":"blob","hex":bytes.iter().map(|byte|format!("{byte:02x}")).collect::<String>()}))) }
                    else { row.try_get::<Option<String>,_>(index).map(|v| v.map(serde_json::Value::String)) }.map_err(|_| StatusCode::BAD_GATEWAY)?;
                values.push(value);
            }
            size = size.saturating_add(
                serde_json::to_vec(&values)
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                    .len(),
            );
            if size > 8 * 1024 * 1024 {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            result_rows.push(values);
        }
        let row_count = result_rows.len();
        Ok(Json(
            serde_json::json!({"columns":columns,"rowCount":row_count,"rows":result_rows,"changes":0,"lastInsertRowId":0}),
        ))
    } else {
        let result = sqlx::query_with::<sqlx::Any, _>(sqlx::AssertSqlSafe(request.sql), arguments)
            .execute(&db.pool)
            .await
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        Ok(Json(
            serde_json::json!({"columns":[],"rows":[],"rowCount":0,"changes":result.rows_affected(),"lastInsertRowId":0}),
        ))
    }
}

fn is_sqlite_path(path: &FsPath) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "db" | "sqlite" | "sqlite3"
    )
}

fn collect_databases(
    root: &FsPath,
    folder: &FsPath,
    output: &mut Vec<serde_json::Value>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if file_type.is_dir() {
            if !matches!(
                entry.file_name().to_str(),
                Some(".git" | ".dreamcraft" | "node_modules" | "vendor" | "target")
            ) {
                collect_databases(root, &path, output)?;
            }
        } else if file_type.is_file() && is_sqlite_path(&path) {
            output.push(serde_json::json!({"path":relative,"size":entry.metadata()?.len()}));
        }
    }
    Ok(())
}

fn resolve_database(root: &FsPath, relative: &str) -> Result<PathBuf, StatusCode> {
    if !is_sqlite_path(FsPath::new(relative)) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let candidate = safe_path(root, relative)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let canonical = candidate
        .canonicalize()
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(canonical)
}

fn database_json_value(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => serde_json::json!(value),
        ValueRef::Real(value) => serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(value) => {
            serde_json::Value::String(String::from_utf8_lossy(value).into_owned())
        }
        ValueRef::Blob(value) => {
            serde_json::json!({"type":"blob","hex":value.iter().map(|byte| format!("{byte:02x}")).collect::<String>()})
        }
    }
}

fn database_sql_value(value: &serde_json::Value) -> Result<SqlValue, StatusCode> {
    match value {
        serde_json::Value::Null => Ok(SqlValue::Null),
        serde_json::Value::Bool(value) => Ok(SqlValue::Integer(i64::from(*value))),
        serde_json::Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .ok_or(StatusCode::BAD_REQUEST),
        serde_json::Value::String(value) if value.len() <= 1024 * 1024 => {
            Ok(SqlValue::Text(value.clone()))
        }
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

fn execute_database_statement(
    connection: &Connection,
    sql: &str,
    params: &[SqlValue],
) -> Result<serde_json::Value, StatusCode> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if statement.column_count() == 0 {
        let changes = statement
            .execute(params_from_iter(params.iter()))
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        return Ok(
            serde_json::json!({"columns":[],"rows":[],"rowCount":0,"changes":changes,"lastInsertRowId":connection.last_insert_rowid()}),
        );
    }
    let columns = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let mut rows = statement
        .query(params_from_iter(params.iter()))
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let mut values = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = rows.next().map_err(|_| StatusCode::BAD_REQUEST)? {
        if values.len() >= 1000 {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let mut record = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            record.push(database_json_value(
                row.get_ref(index).map_err(|_| StatusCode::BAD_REQUEST)?,
            ));
        }
        bytes = bytes.saturating_add(
            serde_json::to_vec(&record)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                .len(),
        );
        if bytes > 8 * 1024 * 1024 {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        values.push(record);
    }
    Ok(
        serde_json::json!({"columns":columns,"rowCount":values.len(),"rows":values,"changes":0,"lastInsertRowId":connection.last_insert_rowid()}),
    )
}

async fn database_files(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<serde_json::Value>>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let root = state.project_root();
    tokio::task::spawn_blocking(move || {
        let mut output = Vec::new();
        collect_databases(&root, &root, &mut output)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        output.sort_by(|a, b| {
            a["path"]
                .as_str()
                .unwrap_or("")
                .cmp(b["path"].as_str().unwrap_or(""))
        });
        Ok(Json(output))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn database_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DatabasePathRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let relative = request.path.clone();
    if !is_sqlite_path(FsPath::new(&relative)) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let root = state.project_root();
    let target = safe_path(&root, &relative)?;
    tokio::task::spawn_blocking(move || {
        let canonical_root = root.canonicalize().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let parent = target.parent().ok_or(StatusCode::BAD_REQUEST)?;
        let relative_parent = parent.strip_prefix(&root).map_err(|_| StatusCode::FORBIDDEN)?;
        let mut safe_parent = canonical_root.clone();
        for component in relative_parent.components() {
            let Component::Normal(part) = component else { return Err(StatusCode::BAD_REQUEST); };
            safe_parent.push(part);
            match fs::symlink_metadata(&safe_parent) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => return Err(StatusCode::FORBIDDEN),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&safe_parent).map_err(|_| StatusCode::BAD_REQUEST)?,
                Err(_) => return Err(StatusCode::BAD_REQUEST),
            }
        }
        let file_name = target.file_name().ok_or(StatusCode::BAD_REQUEST)?;
        let safe_target = safe_parent.join(file_name);
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&safe_target)
            .map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists { StatusCode::CONFLICT } else { StatusCode::BAD_REQUEST })?;
        drop(file);
        let connection = Connection::open_with_flags(&safe_target, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        connection.execute_batch("PRAGMA user_version=0;").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        drop(connection);
        Ok(Json(serde_json::json!({"path":relative,"size":safe_target.metadata().map(|m|m.len()).unwrap_or(0)})))
    }).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn database_schema(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DatabasePathRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let path = resolve_database(&state.project_root(), &request.path)?;
    tokio::task::spawn_blocking(move || {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_| StatusCode::BAD_REQUEST)?;
        let mut table_statement = connection.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").map_err(|_| StatusCode::BAD_REQUEST)?;
        let mut tables = Vec::new();
        let mut rows = table_statement.query([]).map_err(|_| StatusCode::BAD_REQUEST)?;
        while let Some(row) = rows.next().map_err(|_| StatusCode::BAD_REQUEST)? {
            let name: String = row.get(0).map_err(|_| StatusCode::BAD_REQUEST)?;
            let kind: String = row.get(1).map_err(|_| StatusCode::BAD_REQUEST)?;
            let mut columns_statement = connection.prepare(r#"SELECT name, type, "notnull", pk FROM pragma_table_info(?1)"#).map_err(|_| StatusCode::BAD_REQUEST)?;
            let columns = columns_statement.query_map([&name], |column| Ok(serde_json::json!({"name":column.get::<_,String>(0)?,"type":column.get::<_,String>(1)?,"notNull":column.get::<_,i64>(2)? != 0,"primaryKeyOrder":column.get::<_,i64>(3)?}))).map_err(|_| StatusCode::BAD_REQUEST)?.collect::<Result<Vec<_>,_>>().map_err(|_| StatusCode::BAD_REQUEST)?;
            tables.push(serde_json::json!({"name":name,"kind":kind,"columns":columns}));
        }
        Ok(Json(serde_json::json!({"tables":tables})))
    }).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn database_query(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DatabaseQueryRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    if request.sql.trim().is_empty()
        || request.sql.len() > 1024 * 1024
        || request.params.len() > 500
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let params = request
        .params
        .iter()
        .map(database_sql_value)
        .collect::<Result<Vec<_>, _>>()?;
    let path = resolve_database(&state.project_root(), &request.path)?;
    tokio::task::spawn_blocking(move || {
        let connection = Connection::open(path).map_err(|_| StatusCode::BAD_REQUEST)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        Ok(Json(execute_database_statement(
            &connection,
            &request.sql,
            &params,
        )?))
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
}

async fn get_snippets(State(state): State<AppState>) -> Result<Json<Vec<CodeSnippet>>, StatusCode> {
    let path = state.app_root.join(".dreamcraft").join("snippets.json");
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Json)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Json(Vec::new())),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn update_snippets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SnippetLibraryUpdate>,
) -> Result<Json<Vec<CodeSnippet>>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    if request.snippets.len() > 500 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mut ids = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    let mut total_bytes = 0usize;
    for snippet in &request.snippets {
        total_bytes = total_bytes.saturating_add(snippet.code.len());
        if snippet.id.is_empty()
            || snippet.id.len() > 128
            || snippet.name.trim().is_empty()
            || snippet.name.len() > 120
            || snippet.category.trim().is_empty()
            || snippet.category.len() > 64
            || snippet.trigger.len() > 40
            || snippet.description.len() > 500
            || !matches!(
                snippet.syntax.as_str(),
                "htmlmixed" | "css" | "javascript" | "json" | "xml" | "text"
            )
            || snippet.code.is_empty()
            || snippet.code.len() > 64 * 1024
            || !matches!(snippet.mode.as_str(), "insert" | "wrap")
            || (snippet.mode == "wrap" && !snippet.code.contains("${selection}"))
            || !ids.insert(snippet.id.clone())
            || !names.insert((snippet.category.to_lowercase(), snippet.name.to_lowercase()))
        {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    if total_bytes > 4 * 1024 * 1024 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let directory = state.app_root.join(".dreamcraft");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let path = directory.join("snippets.json");
    let temp = directory.join(format!(
        "snippets-{}.tmp",
        RELEASE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let bytes = serde_json::to_vec_pretty(&request.snippets)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    if let Err(error) = tokio::fs::rename(&temp, &path).await {
        let _ = tokio::fs::remove_file(temp).await;
        return Err(if error.kind() == std::io::ErrorKind::PermissionDenied {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        });
    }
    Ok(Json(request.snippets))
}

async fn read_file(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Result<Response, StatusCode> {
    let target = safe_path(&state.project_root(), &path)?;
    let content = tokio::fs::read(target)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let mime = match FsPath::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "md" => "text/markdown; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    };
    Ok(([(header::CONTENT_TYPE, mime)], Body::from(content)).into_response())
}

async fn save_file(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Json(request): Json<SaveRequest>,
) -> Result<StatusCode, StatusCode> {
    let target = safe_path(&state.project_root(), &path)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    tokio::fs::write(target, request.content)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rename_file(
    State(state): State<AppState>,
    Json(request): Json<RenameRequest>,
) -> Result<StatusCode, StatusCode> {
    let from = safe_path(&state.project_root(), &request.from)?;
    let to = safe_path(&state.project_root(), &request.to)?;
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    tokio::fs::rename(from, to)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_folder(
    State(state): State<AppState>,
    Json(request): Json<FolderRequest>,
) -> Result<StatusCode, StatusCode> {
    let target = safe_path(&state.project_root(), &request.path)?;
    tokio::fs::create_dir_all(target)
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(StatusCode::CREATED)
}

async fn delete_file(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let target = safe_path(&state.project_root(), &path)?;
    let metadata = tokio::fs::metadata(&target)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if metadata.is_dir() {
        tokio::fs::remove_dir(target)
            .await
            .map_err(|_| StatusCode::BAD_REQUEST)?;
    } else {
        tokio::fs::remove_file(target)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

fn copy_site(source: &FsPath, target: &FsPath) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".dreamcraft" || name == ".git" {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = target.join(name);
        if kind.is_dir() {
            copy_site(&from, &to)?;
        } else if kind.is_file() {
            fs::copy(from, to)?;
        }
    }
    Ok(())
}

async fn create_release(root: &FsPath) -> Result<String, StatusCode> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .as_millis();
    let id = format!(
        "{}-{}",
        now,
        RELEASE_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let source = root.to_path_buf();
    let release = root.join(".dreamcraft").join("releases").join(&id);
    tokio::task::spawn_blocking(move || copy_site(&source, &release))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(id)
}

async fn list_snapshots(
    State(state): State<AppState>,
) -> Result<Json<Vec<SnapshotEntry>>, StatusCode> {
    let releases = state.project_root().join(".dreamcraft").join("releases");
    let entries = tokio::task::spawn_blocking(move || {
        let mut snapshots = Vec::new();
        let Ok(items) = fs::read_dir(&releases) else {
            return Ok(snapshots);
        };
        for item in items {
            let item = item?;
            if !item.file_type()?.is_dir() {
                continue;
            }
            let id = item.file_name().to_string_lossy().into_owned();
            if !id.chars().all(|ch| ch.is_ascii_digit() || ch == '-') {
                continue;
            }
            let created_ms = id
                .split('-')
                .next()
                .and_then(|part| part.parse().ok())
                .unwrap_or_default();
            let files = collect_site_files(&item.path())?;
            let mut bytes = 0;
            for file in &files {
                bytes += fs::metadata(file)?.len();
            }
            snapshots.push(SnapshotEntry {
                id,
                created_ms,
                files: files.len(),
                bytes,
            });
        }
        snapshots.sort_by(|left, right| right.id.cmp(&left.id));
        Ok::<_, std::io::Error>(snapshots)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(entries))
}

async fn create_snapshot(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let id = create_release(&state.project_root()).await?;
    Ok(Json(serde_json::json!({ "id": id })))
}

async fn restore_snapshot(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<AiError>)> {
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_digit() || ch == '-') {
        return Err(ai_error(
            StatusCode::BAD_REQUEST,
            "That snapshot identifier is invalid.",
        ));
    }
    let source = state
        .project_root()
        .join(".dreamcraft")
        .join("releases")
        .join(&id);
    if !tokio::fs::try_exists(&source).await.unwrap_or(false) {
        return Err(ai_error(
            StatusCode::NOT_FOUND,
            "That snapshot no longer exists.",
        ));
    }
    let backup_id = create_release(&state.project_root()).await.map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not snapshot the current site before restoring.",
        )
    })?;
    let root = state.project_root().clone();
    let stage_id = backup_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let stage_parent = root.join(".dreamcraft").join("restore-staging");
        fs::create_dir_all(&stage_parent)?;
        let stage = stage_parent.join(&stage_id);
        copy_site(&source, &stage)?;
        let files = collect_site_files(&stage)?;
        let paths: Vec<String> = files
            .iter()
            .filter_map(|path| path.strip_prefix(&stage).ok())
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let name = entry.file_name();
            if name == ".dreamcraft" || name == ".git" {
                continue;
            }
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                if path.is_dir() {
                    fs::remove_dir(path)?;
                } else {
                    fs::remove_file(path)?;
                }
            } else if kind.is_dir() {
                fs::remove_dir_all(path)?;
            } else {
                fs::remove_file(path)?;
            }
        }
        copy_site(&stage, &root)?;
        fs::remove_dir_all(&stage)?;
        Ok::<_, std::io::Error>((paths, files.len()))
    })
    .await
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The snapshot restore worker stopped unexpectedly.",
        )
    })?
    .map_err(|_| {
        ai_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not restore the snapshot. The pre-restore backup is {backup_id}."),
        )
    })?;
    Ok(Json(
        serde_json::json!({ "snapshot": id, "backup": backup_id, "files": result.1, "paths": result.0 }),
    ))
}

async fn publish(State(state): State<AppState>) -> Result<Json<PublishResult>, StatusCode> {
    let id = create_release(&state.project_root()).await?;
    Ok(Json(PublishResult {
        url: format!("/published/{id}/index.html"),
    }))
}

async fn published_file(
    State(state): State<AppState>,
    Path((id, path)): Path<(String, String)>,
) -> Result<Response, StatusCode> {
    if !id.chars().all(|ch| ch.is_ascii_digit() || ch == '-') {
        return Err(StatusCode::BAD_REQUEST);
    }
    let target = safe_path(
        &state
            .project_root()
            .join(".dreamcraft")
            .join("releases")
            .join(&id),
        &path,
    )?;
    let bytes = tokio::fs::read(&target)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let prefix = format!("/published/{id}");
    let content = match target.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("css") => Body::from(
            rewrite_css_root_urls(&String::from_utf8_lossy(&bytes), &prefix).into_bytes(),
        ),
        Some(extension)
            if extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm") =>
        {
            Body::from(rewrite_html_root_urls(
                &String::from_utf8_lossy(&bytes),
                &prefix,
            ))
        }
        _ => Body::from(bytes),
    };
    let mime = mime_for(&target);
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header("X-Content-Type-Options", "nosniff");
    if mime.starts_with("text/html") {
        response = response.header(
            "Content-Security-Policy",
            "sandbox allow-scripts allow-forms allow-modals",
        );
    }
    Ok(response
        .body(content)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?)
}

async fn published_index(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, StatusCode> {
    published_file(State(state), Path((id, "index.html".to_string()))).await
}

fn project_root_css_url(value: &str, prefix: &str) -> Option<String> {
    let value = value.trim();
    (value.starts_with('/') && !value.starts_with("//") && !value.starts_with(prefix))
        .then(|| format!("{prefix}{value}"))
}

#[cfg(test)]
fn rewrite_css_project_root_urls(css: &str) -> String {
    rewrite_css_root_urls(css, "/site")
}

fn rewrite_css_root_urls(css: &str, prefix: &str) -> String {
    let mut output = String::with_capacity(css.len());
    let mut index = 0;
    while index < css.len() {
        let rest = &css[index..];
        if rest.starts_with("/*") {
            let end = rest
                .find("*/")
                .map(|end| index + end + 2)
                .unwrap_or(css.len());
            output.push_str(&css[index..end]);
            index = end;
            continue;
        }
        if rest
            .get(..4)
            .is_some_and(|token| token.eq_ignore_ascii_case("url("))
        {
            let content_start = index + 4;
            let mut quote = None;
            let mut close = None;
            for (offset, character) in css[content_start..].char_indices() {
                if let Some(open_quote) = quote {
                    if character == open_quote {
                        quote = None;
                    }
                } else if matches!(character, '\'' | '"') {
                    quote = Some(character);
                } else if character == ')' {
                    close = Some(content_start + offset);
                    break;
                }
            }
            if let Some(close) = close {
                let raw = css[content_start..close].trim();
                let (quote, value) = match raw.chars().next() {
                    Some(quote @ ('\'' | '"')) if raw.ends_with(quote) && raw.len() >= 2 => (
                        Some(quote),
                        &raw[quote.len_utf8()..raw.len() - quote.len_utf8()],
                    ),
                    _ => (None, raw),
                };
                if let Some(rewritten) = project_root_css_url(value, prefix) {
                    output.push_str("url(");
                    if let Some(quote) = quote {
                        output.push(quote);
                    }
                    output.push_str(&rewritten);
                    if let Some(quote) = quote {
                        output.push(quote);
                    }
                    output.push(')');
                } else {
                    output.push_str(&css[index..=close]);
                }
                index = close + 1;
                continue;
            }
        }
        if rest
            .get(..7)
            .is_some_and(|token| token.eq_ignore_ascii_case("@import"))
        {
            let mut cursor = index + 7;
            while cursor < css.len() && css.as_bytes()[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if let Some(quote @ ('\'' | '"')) = css[cursor..].chars().next() {
                let content_start = cursor + quote.len_utf8();
                if let Some(offset) = css[content_start..].find(quote) {
                    let close = content_start + offset;
                    if let Some(rewritten) =
                        project_root_css_url(&css[content_start..close], prefix)
                    {
                        output.push_str(&css[index..content_start]);
                        output.push_str(&rewritten);
                        output.push(quote);
                        index = close + quote.len_utf8();
                        continue;
                    }
                }
            }
        }
        if matches!(rest.chars().next(), Some('\'' | '"')) {
            let quote = rest.chars().next().expect("string quote exists");
            let mut escaped = false;
            let mut end = None;
            for (offset, character) in rest[quote.len_utf8()..].char_indices() {
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == quote {
                    end = Some(index + quote.len_utf8() + offset + quote.len_utf8());
                    break;
                }
            }
            let end = end.unwrap_or(css.len());
            output.push_str(&css[index..end]);
            index = end;
            continue;
        }
        let character = rest
            .chars()
            .next()
            .expect("index stays on a character boundary");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

async fn serve_site_file(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Result<Response, StatusCode> {
    serve_project_file(
        state.project_root(),
        &path,
        "/site",
        "/api/preview/live-version",
    )
    .await
}

async fn serve_project_file(
    root: PathBuf,
    path: &str,
    url_prefix: &str,
    version_url: &str,
) -> Result<Response, StatusCode> {
    let canonical_root = tokio::fs::canonicalize(&root)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let target = safe_path(&root, &path)?;
    let mut target = tokio::fs::canonicalize(&target)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !target.starts_with(&canonical_root) {
        return Err(StatusCode::FORBIDDEN);
    }
    if tokio::fs::metadata(&target)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?
        .is_dir()
    {
        target.push("index.html");
        target = tokio::fs::canonicalize(target)
            .await
            .map_err(|_| StatusCode::NOT_FOUND)?;
        if !target.starts_with(&canonical_root) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    let bytes = tokio::fs::read(&target)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let content = match target.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("css") => Body::from(
            rewrite_css_root_urls(&String::from_utf8_lossy(&bytes), url_prefix).into_bytes(),
        ),
        Some(extension)
            if extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm") =>
        {
            let html = rewrite_html_root_urls(&String::from_utf8_lossy(&bytes), url_prefix);
            let script = format!(
                r#"<script>(()=>{{let revision='';async function check(){{try{{const response=await fetch('{version_url}',{{cache:'no-store'}});if(!response.ok)return;const next=(await response.text()).trim();if(revision&&next!==revision){{location.reload();return}}revision=next}}catch{{}}}}check();setInterval(check,1200)}})();</script>"#
            );
            let html = if let Some(index) = html.to_ascii_lowercase().rfind("</body>") {
                format!("{}{}{}", &html[..index], script, &html[index..])
            } else {
                format!("{html}{script}")
            };
            Body::from(html)
        }
        _ => Body::from(bytes),
    };
    Ok((
        [
            (header::CONTENT_TYPE, mime_for(&target)),
            (header::CACHE_CONTROL, "no-store"),
        ],
        content,
    )
        .into_response())
}

#[cfg(test)]
fn rewrite_html_project_root_urls(html: &str) -> String {
    rewrite_html_root_urls(html, "/site")
}

fn rewrite_html_root_urls(html: &str, prefix: &str) -> String {
    let pattern =
        regex::Regex::new(r#"(?i)(\b(?:href|src|poster|action|data)\s*=\s*["'])/([^"']*)"#)
            .expect("the fixed root-relative HTML URL pattern is valid");
    pattern
        .replace_all(html, |captures: &regex::Captures<'_>| {
            let path = &captures[2];
            if path.starts_with('/')
                || path.starts_with(prefix.trim_start_matches('/'))
                || path.starts_with("api/")
            {
                captures[0].to_owned()
            } else {
                let path = if path.is_empty() { "index.html" } else { path };
                format!("{}{prefix}/{path}", &captures[1])
            }
        })
        .into_owned()
}

async fn upload_multipart(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<StatusCode, StatusCode> {
    let mut count = 0;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?
    {
        if let Some(name) = field.file_name().map(str::to_owned) {
            let name = name.replace('\\', "/");
            let target = safe_path(&state.project_root(), &format!("assets/{name}"))?;
            let bytes = field.bytes().await.map_err(|_| StatusCode::BAD_REQUEST)?;
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            }
            tokio::fs::write(target, bytes)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            count += 1;
        }
    }
    if count == 0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(StatusCode::NO_CONTENT)
}

fn mime_for(path: &FsPath) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn local_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| reqwest::Url::parse(value).ok())
    else {
        return false;
    };
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| reqwest::Url::parse(&format!("http://{value}")).ok())
    else {
        return false;
    };
    origin.scheme() == "http"
        && origin.path() == "/"
        && origin.query().is_none()
        && origin.fragment().is_none()
        && origin.username().is_empty()
        && origin.password().is_none()
        && matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        && origin.host_str() == host.host_str()
        && origin.port_or_known_default() == host.port_or_known_default()
}

fn project_info(path: &FsPath, name: Option<String>) -> ProjectInfo {
    let name = name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let source = fs::read_to_string(path.join("index.html")).ok()?;
            let lowercase = source.to_ascii_lowercase();
            let title_start = lowercase.find("<title")?;
            let title_content = title_start + source[title_start..].find('>')? + 1;
            let title_end = title_content + lowercase[title_content..].find("</title")?;
            let title = source[title_content..title_end]
                .split(['—', '–'])
                .next()?
                .trim();
            (!title.is_empty()).then(|| title.to_string())
        })
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Website")
                .to_string()
        });
    ProjectInfo {
        name,
        path: path_string(path),
    }
}

fn path_string(path: &FsPath) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    if let Some(normalized) = value.strip_prefix(r"\\?\") {
        return normalized.to_string();
    }
    value.into_owned()
}

async fn save_workspace(state: &AppState) -> Result<(), StatusCode> {
    let workspace = state
        .workspace
        .read()
        .expect("workspace lock poisoned")
        .clone();
    let directory = state.app_root.join(".dreamcraft");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let bytes =
        serde_json::to_vec_pretty(&workspace).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(directory.join("workspace.json"), bytes)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn projects(State(state): State<AppState>) -> Result<Json<serde_json::Value>, StatusCode> {
    let current = path_string(&state.project_root());
    let mut workspace = state
        .workspace
        .read()
        .expect("workspace lock poisoned")
        .clone();
    workspace.current = current;
    Ok(Json(
        serde_json::to_value(workspace).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
    ))
}

async fn open_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<OpenProjectRequest>,
) -> Result<Json<ProjectInfo>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let selected = tokio::fs::canonicalize(&request.path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !tokio::fs::metadata(&selected)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?
        .is_dir()
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let info = project_info(&selected, None);
    stop_testing_server(&state).await;
    stop_device_preview(&state).await;
    {
        let mut workspace = state.workspace.write().expect("workspace lock poisoned");
        workspace.current = info.path.clone();
        if let Some(existing) = workspace
            .projects
            .iter_mut()
            .find(|item| item.path.eq_ignore_ascii_case(&info.path))
        {
            existing.name = info.name.clone();
        } else {
            workspace.projects.push(info.clone());
        }
        *state.root.write().expect("project root lock poisoned") = selected;
    }
    save_workspace(&state).await?;
    Ok(Json(info))
}

async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CreateProjectRequest>,
) -> Result<Json<ProjectInfo>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let starter = match request.starter.as_str() {
        "studio" => include_str!("../assets/starters/studio.html"),
        "product" => include_str!("../assets/starters/product.html"),
        "journal" => include_str!("../assets/starters/journal.html"),
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    let requested = PathBuf::from(request.path.trim());
    if requested.file_name().is_none() || requested.exists() {
        return Err(StatusCode::CONFLICT);
    }
    let parent = requested.parent().ok_or(StatusCode::BAD_REQUEST)?;
    let parent = tokio::fs::canonicalize(parent)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let directory = parent.join(requested.file_name().ok_or(StatusCode::BAD_REQUEST)?);
    tokio::fs::create_dir(&directory)
        .await
        .map_err(|_| StatusCode::CONFLICT)?;
    if let Err(error) = tokio::fs::write(directory.join("index.html"), starter).await {
        let _ = tokio::fs::remove_dir(&directory).await;
        return Err(if error.kind() == std::io::ErrorKind::PermissionDenied {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        });
    }
    let selected = tokio::fs::canonicalize(&directory)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let info = project_info(&selected, Some(request.name));
    stop_testing_server(&state).await;
    {
        let mut workspace = state.workspace.write().expect("workspace lock poisoned");
        workspace.current = info.path.clone();
        workspace
            .projects
            .retain(|item| !item.path.eq_ignore_ascii_case(&info.path));
        workspace.projects.push(info.clone());
        *state.root.write().expect("project root lock poisoned") = selected;
    }
    save_workspace(&state).await?;
    Ok(Json(info))
}

async fn create_bootstrap_starter(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if !local_origin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let root = state.project_root();
    let css = EmbeddedAssets::get("vendor/bootstrap/bootstrap.min.css")
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let js = EmbeddedAssets::get("vendor/bootstrap/bootstrap.bundle.min.js")
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut vendor = PathBuf::from("vendor/bootstrap-5.3.8");
    let mut suffix = 2;
    loop {
        let folder = root.join(&vendor);
        if !folder.exists() {
            tokio::fs::create_dir_all(&folder)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            tokio::fs::write(folder.join("bootstrap.min.css"), &css.data)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            tokio::fs::write(folder.join("bootstrap.bundle.min.js"), &js.data)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            tokio::fs::write(
                folder.join("LICENSE"),
                include_bytes!("../assets/vendor/bootstrap/LICENSE"),
            )
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            break;
        }
        let folder = root.join(&vendor);
        let css_path = folder.join("bootstrap.min.css");
        let js_path = folder.join("bootstrap.bundle.min.js");
        if tokio::fs::read(&css_path).await.ok().as_deref() == Some(css.data.as_ref())
            && tokio::fs::read(&js_path).await.ok().as_deref() == Some(js.data.as_ref())
        {
            break;
        }
        vendor = PathBuf::from(format!("vendor/bootstrap-5.3.8-{suffix}"));
        suffix += 1;
        if suffix > 1000 {
            return Err(StatusCode::CONFLICT);
        }
    }
    let mut page = "bootstrap-starter.html".to_owned();
    let mut suffix = 2;
    while root.join(&page).exists() {
        page = format!("bootstrap-starter-{suffix}.html");
        suffix += 1;
        if suffix > 1000 {
            return Err(StatusCode::CONFLICT);
        }
    }
    let vendor_url = vendor.to_string_lossy().replace('\\', "/");
    let html = format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="A responsive web design studio page built with the local Bootstrap framework.">
  <title>DreamCraft Studio · Bootstrap starter</title>
  <link href="{vendor_url}/bootstrap.min.css" rel="stylesheet">
  <style>
    :root {{ color-scheme: light; }}
    body {{ background: #f5f4f1; color: #22221f; }}
    .site-nav {{ background: rgba(245,244,241,.94); backdrop-filter: blur(12px); }}
    .hero {{ padding: clamp(5rem, 12vw, 10rem) 0 6rem; }}
    .eyebrow {{ letter-spacing: .14em; text-transform: uppercase; font-size: .75rem; font-weight: 700; color: #59644d; }}
    .hero-title {{ max-width: 880px; letter-spacing: -.06em; line-height: .98; }}
    .project-card {{ border: 0; background: #e7e7e0; min-height: 270px; }}
    .project-card:nth-child(2) {{ background: #e9dfd3; }}
    .project-card:nth-child(3) {{ background: #dbe5e0; }}
    .project-number {{ font-variant-numeric: tabular-nums; }}
    .section-rule {{ border-color: rgba(34,34,31,.18); }}
  </style>
</head>
<body>
  <nav class="navbar navbar-expand-lg site-nav border-bottom sticky-top" aria-label="Main navigation">
    <div class="container py-2">
      <a class="navbar-brand fw-bold" href="#top">DreamCraft<span class="text-success">.</span></a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#studioNav" aria-controls="studioNav" aria-expanded="false" aria-label="Toggle navigation"><span class="navbar-toggler-icon"></span></button>
      <div class="collapse navbar-collapse" id="studioNav">
        <ul class="navbar-nav ms-auto gap-lg-3">
          <li class="nav-item"><a class="nav-link" href="#work">Selected work</a></li>
          <li class="nav-item"><a class="nav-link" href="#approach">Approach</a></li>
          <li class="nav-item"><a class="nav-link" href="#contact">Contact</a></li>
        </ul>
      </div>
    </div>
  </nav>
  <main id="top">
    <section class="container hero">
      <p class="eyebrow mb-4">Independent digital studio · Halifax, Canada</p>
      <h1 class="display-1 fw-semibold hero-title">Thoughtful websites for people moving ideas forward.</h1>
      <div class="row mt-5 align-items-end">
        <div class="col-lg-7"><p class="fs-4 text-secondary mb-0">We bring clear strategy, considered design, and dependable technology together to make the web more useful.</p></div>
        <div class="col-lg-5 text-lg-end mt-4 mt-lg-0"><a class="btn btn-dark btn-lg rounded-pill px-4" href="#work">Explore our work <span aria-hidden="true">↘</span></a></div>
      </div>
    </section>
    <section class="container pb-5" id="work" aria-labelledby="work-title">
      <div class="d-flex justify-content-between align-items-end border-bottom section-rule pb-3 mb-4"><div><p class="eyebrow mb-2">Selected projects</p><h2 class="h1 mb-0" id="work-title">Made with purpose.</h2></div><span class="text-secondary small">01 — 03</span></div>
      <div class="row g-3">
        <div class="col-md-6 col-xl-4"><article class="card project-card rounded-4 p-4"><div class="d-flex justify-content-between"><span class="eyebrow">Culture · 2025</span><span class="project-number">01</span></div><div class="mt-auto"><h3 class="h2">Common Ground</h3><p class="mb-0 text-secondary">A welcoming digital home for a neighborhood arts collective.</p></div></article></div>
        <div class="col-md-6 col-xl-4"><article class="card project-card rounded-4 p-4"><div class="d-flex justify-content-between"><span class="eyebrow">Commerce · 2025</span><span class="project-number">02</span></div><div class="mt-auto"><h3 class="h2">Good Measure</h3><p class="mb-0 text-secondary">A calm, considered storefront for everyday essentials.</p></div></article></div>
        <div class="col-md-6 col-xl-4"><article class="card project-card rounded-4 p-4"><div class="d-flex justify-content-between"><span class="eyebrow">Climate · 2024</span><span class="project-number">03</span></div><div class="mt-auto"><h3 class="h2">Tidal Futures</h3><p class="mb-0 text-secondary">Clear tools that help coastal communities plan for change.</p></div></article></div>
      </div>
    </section>
    <section class="container py-5 my-4" id="approach" aria-labelledby="approach-title">
      <div class="row g-5"><div class="col-lg-5"><p class="eyebrow">How we work</p><h2 class="display-5 fw-semibold" id="approach-title">Good work starts with listening.</h2></div><div class="col-lg-7"><div class="accordion accordion-flush" id="studioApproach">
        <div class="accordion-item bg-transparent"><h3 class="accordion-header"><button class="accordion-button collapsed bg-transparent" type="button" data-bs-toggle="collapse" data-bs-target="#stepListen" aria-expanded="false" aria-controls="stepListen">01 · Understand the opportunity</button></h3><div id="stepListen" class="accordion-collapse collapse" data-bs-parent="#studioApproach"><div class="accordion-body text-secondary">We learn about your audience, goals, and the details that make your work distinct before shaping a direction.</div></div></div>
        <div class="accordion-item bg-transparent"><h3 class="accordion-header"><button class="accordion-button collapsed bg-transparent" type="button" data-bs-toggle="collapse" data-bs-target="#stepDesign" aria-expanded="false" aria-controls="stepDesign">02 · Design with intention</button></h3><div id="stepDesign" class="accordion-collapse collapse" data-bs-parent="#studioApproach"><div class="accordion-body text-secondary">We turn the strategy into an accessible visual system and responsive page layouts that are easy to navigate.</div></div></div>
        <div class="accordion-item bg-transparent"><h3 class="accordion-header"><button class="accordion-button collapsed bg-transparent" type="button" data-bs-toggle="collapse" data-bs-target="#stepBuild" aria-expanded="false" aria-controls="stepBuild">03 · Build for the long term</button></h3><div id="stepBuild" class="accordion-collapse collapse" data-bs-parent="#studioApproach"><div class="accordion-body text-secondary">We build, review, and refine the finished experience so it remains understandable and maintainable after launch.</div></div></div>
      </div></div></div>
    </section>
    <section class="container py-5 border-top section-rule" id="contact"><div class="row align-items-end"><div class="col-lg-8"><p class="eyebrow">A considered process</p><h2 class="display-4 fw-semibold mb-0">Make the next<br>step a good one.</h2></div><div class="col-lg-4 text-lg-end mt-4"><a class="btn btn-outline-dark btn-lg rounded-pill px-4" href="#approach">See how we work</a></div></div></section>
  </main>
  <footer class="container py-4 border-top section-rule d-flex flex-wrap justify-content-between gap-2 small text-secondary"><span>DreamCraft Studio · Independent by design.</span><a class="link-secondary" href="#top">Back to top ↑</a></footer>
  <script src="{vendor_url}/bootstrap.bundle.min.js"></script>
</body>
</html>
"##
    );
    tokio::fs::write(root.join(&page), html)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        serde_json::json!({"path": page, "vendor": vendor_url}),
    ))
}

#[cfg(windows)]
fn run_native_desktop(address: &str, smoke_exit: bool) -> Result<(), String> {
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
        platform::run_return::EventLoopExtRunReturn,
        window::{Icon, ResizeDirection, Theme, WindowBuilder, WindowId},
    };
    use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder};

    #[derive(Clone, Copy)]
    enum DesktopEvent {
        SplashLoaded,
        EditorLoadStarted,
        EditorLoaded,
        EditorReady,
        WindowMinimize,
        WindowToggleMaximize,
        WindowClose,
        WindowDrag,
        WindowResize(ResizeDirection),
    }

    fn webcraft_window_icon() -> Option<Icon> {
        fn segment_distance(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
            let dx = bx - ax;
            let dy = by - ay;
            let length_squared = dx * dx + dy * dy;
            let position = (((px - ax) * dx + (py - ay) * dy) / length_squared).clamp(0.0, 1.0);
            let nearest_x = ax + position * dx;
            let nearest_y = ay + position * dy;
            ((px - nearest_x).powi(2) + (py - nearest_y).powi(2)).sqrt()
        }

        const SIZE: u32 = 128;
        // A regular, centered star keeps its proportions when Windows scales
        // this square image for the taskbar and window switcher.
        let points = [
            (64.0, 108.0),
            (92.0, 21.0),
            (18.0, 75.0),
            (110.0, 75.0),
            (36.0, 21.0),
        ];
        let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
        for y in 0..SIZE {
            for x in 0..SIZE {
                let x = x as f32 + 0.5;
                let y = y as f32 + 0.5;
                let nearest_x = x.clamp(35.0, 93.0);
                let nearest_y = y.clamp(35.0, 93.0);
                if (x - nearest_x).powi(2) + (y - nearest_y).powi(2) > 23.0_f32.powi(2) {
                    continue;
                }
                let offset = ((y as u32 * SIZE + x as u32) * 4) as usize;
                let blend = ((x + y) / 256.0).clamp(0.0, 1.0);
                rgba[offset] = (190.0 - blend * 111.0) as u8;
                rgba[offset + 1] = (145.0 - blend * 80.0) as u8;
                rgba[offset + 2] = (255.0 - blend * 77.0) as u8;
                rgba[offset + 3] = 255;
                let mut star_distance = f32::INFINITY;
                for index in 0..points.len() {
                    let (ax, ay) = points[index];
                    let (bx, by) = points[(index + 1) % points.len()];
                    star_distance = star_distance.min(segment_distance(x, y, ax, ay, bx, by));
                }
                // A small coverage ramp keeps the thin mark crisp when the
                // 128px source is scaled down to taskbar size.
                let coverage = (3.0 - star_distance).clamp(0.0, 1.0);
                rgba[offset] = (rgba[offset] as f32 * (1.0 - coverage) + 255.0 * coverage) as u8;
                rgba[offset + 1] =
                    (rgba[offset + 1] as f32 * (1.0 - coverage) + 250.0 * coverage) as u8;
                rgba[offset + 2] =
                    (rgba[offset + 2] as f32 * (1.0 - coverage) + 255.0 * coverage) as u8;
            }
        }
        Icon::from_rgba(rgba, SIZE, SIZE).ok()
    }

    fn update_splash(webview: Option<&WebView>, progress: u8, status: &str) {
        if let Some(webview) = webview {
            let status =
                serde_json::to_string(status).unwrap_or_else(|_| "\"Loading DreamCraft\"".into());
            let _ =
                webview.evaluate_script(&format!("window.setStartupProgress({progress},{status})"));
        }
    }

    let mut event_loop = EventLoopBuilder::<DesktopEvent>::with_user_event().build();
    let proxy: EventLoopProxy<DesktopEvent> = event_loop.create_proxy();
    let splash_window = WindowBuilder::new()
        .with_title("DreamCraft")
        .with_inner_size(LogicalSize::new(450.0, 300.0))
        .with_resizable(false)
        .with_decorations(false)
        .with_always_on_top(true)
        .with_visible(false)
        .with_theme(Some(Theme::Dark))
        .build(&event_loop)
        .map_err(|error| format!("Could not create the DreamCraft startup window: {error}"))?;
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        let _ = splash_window.set_skip_taskbar(true);
        splash_window.set_undecorated_shadow(true);
    }

    let profile_dir = application_data_dir().join("webview");
    fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("Could not create the DreamCraft desktop profile: {error}"))?;
    let mut web_context = WebContext::new(Some(profile_dir));
    let splash_proxy = proxy.clone();
    let splash_webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(&format!("{address}/splash"))
        .with_background_color((16, 17, 23, 255))
        .with_on_page_load_handler(move |event, _| {
            if matches!(event, PageLoadEvent::Finished) {
                let _ = splash_proxy.send_event(DesktopEvent::SplashLoaded);
            }
        })
        .build(&splash_window)
        .map_err(|error| format!("Could not initialize the DreamCraft startup view: {error}"))?;

    let main_window = WindowBuilder::new()
        .with_title("DreamCraft — Web Design Studio")
        .with_inner_size(LogicalSize::new(1480.0, 960.0))
        .with_min_inner_size(LogicalSize::new(980.0, 640.0))
        .with_window_icon(webcraft_window_icon())
        .with_decorations(false)
        .with_visible(false)
        .with_theme(Some(Theme::Dark))
        .build(&event_loop)
        .map_err(|error| format!("Could not create the DreamCraft editor window: {error}"))?;
    let main_window_id: WindowId = main_window.id();
    let splash_window_id: WindowId = splash_window.id();
    let allowed_origin = reqwest::Url::parse(address)
        .map_err(|error| format!("Invalid DreamCraft desktop URL: {error}"))?
        .origin()
        .ascii_serialization();
    let page_proxy = proxy.clone();
    let ready_proxy = proxy.clone();
    let window_proxy = proxy.clone();
    let main_webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(address)
        .with_background_color((12, 13, 18, 255))
        .with_navigation_handler(move |url| {
            reqwest::Url::parse(&url)
                .map(|url| url.origin().ascii_serialization() == allowed_origin)
                .unwrap_or(false)
        })
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_on_page_load_handler(move |event, _| {
            let event = match event {
                PageLoadEvent::Started => Some(DesktopEvent::EditorLoadStarted),
                PageLoadEvent::Finished => Some(DesktopEvent::EditorLoaded),
            };
            if let Some(event) = event { let _ = page_proxy.send_event(event); }
        })
        .with_ipc_handler(move |request| {
            let event = match request.body().as_str() {
                "dreamcraft-ready" => Some(DesktopEvent::EditorReady),
                "window:minimize" => Some(DesktopEvent::WindowMinimize),
                "window:toggle-maximize" => Some(DesktopEvent::WindowToggleMaximize),
                "window:close" => Some(DesktopEvent::WindowClose),
                "window:drag" => Some(DesktopEvent::WindowDrag),
                "window:resize:north" => Some(DesktopEvent::WindowResize(ResizeDirection::North)),
                "window:resize:south" => Some(DesktopEvent::WindowResize(ResizeDirection::South)),
                "window:resize:east" => Some(DesktopEvent::WindowResize(ResizeDirection::East)),
                "window:resize:west" => Some(DesktopEvent::WindowResize(ResizeDirection::West)),
                "window:resize:north-east" => Some(DesktopEvent::WindowResize(ResizeDirection::NorthEast)),
                "window:resize:north-west" => Some(DesktopEvent::WindowResize(ResizeDirection::NorthWest)),
                "window:resize:south-east" => Some(DesktopEvent::WindowResize(ResizeDirection::SouthEast)),
                "window:resize:south-west" => Some(DesktopEvent::WindowResize(ResizeDirection::SouthWest)),
                _ => None,
            };
            if let Some(event) = event {
                let sender = if matches!(event, DesktopEvent::EditorReady) { &ready_proxy } else { &window_proxy };
                let _ = sender.send_event(event);
            }
        })
        .build(&main_window)
        .map_err(|error| format!("Could not initialize the DreamCraft editor view. Confirm the Microsoft Edge WebView2 Runtime is installed: {error}"))?;

    update_splash(Some(&splash_webview), 18, "DreamCraft engine ready");
    desktop_log("DREAMCRAFT_DESKTOP_STARTED");
    let mut splash_window = Some(splash_window);
    let mut splash_webview = Some(splash_webview);
    let main_window = Some(main_window);
    let mut _main_webview = Some(main_webview);
    let mut smoke_exit_at = None;
    let mut splash_visible_at = None;
    let mut splash_close_at = None;
    let mut editor_ready = false;
    let mut editor_revealed = false;
    let _ = event_loop.run_return(move |event, _, control_flow| {
        if splash_close_at.is_some_and(|deadline| Instant::now() >= deadline) {
            splash_window.take();
            splash_webview.take();
            splash_close_at = None;
            if smoke_exit {
                smoke_exit_at = Some(Instant::now() + Duration::from_millis(500));
            }
        }
        if let Some(deadline) = smoke_exit_at {
            if Instant::now() >= deadline {
                desktop_log("DREAMCRAFT_DESKTOP_SMOKE_CLOSED");
                *control_flow = ControlFlow::Exit;
                return;
            }
            *control_flow = ControlFlow::WaitUntil(deadline);
        } else if let Some(deadline) = splash_close_at {
            *control_flow = ControlFlow::WaitUntil(deadline);
        } else {
            *control_flow = ControlFlow::Wait;
        }
        match event {
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested,
                ..
            } if window_id == main_window_id || window_id == splash_window_id => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(DesktopEvent::SplashLoaded) => {
                let visible_at = Instant::now();
                splash_visible_at = Some(visible_at);
                if let Some(window) = splash_window.as_ref() {
                    window.set_visible(true);
                }
                update_splash(splash_webview.as_ref(), 24, "Preparing your workspace");
                if editor_ready && !editor_revealed {
                    if let Some(window) = main_window.as_ref() {
                        window.set_visible(true);
                        window.set_focus();
                    }
                    update_splash(splash_webview.as_ref(), 100, "Ready");
                    desktop_log("DREAMCRAFT_DESKTOP_READY");
                    editor_revealed = true;
                    splash_close_at = Some(visible_at + Duration::from_millis(1800));
                }
            }
            Event::UserEvent(DesktopEvent::EditorLoadStarted) => {
                update_splash(splash_webview.as_ref(), 48, "Loading the editor window")
            }
            Event::UserEvent(DesktopEvent::EditorLoaded) => {
                update_splash(splash_webview.as_ref(), 76, "Preparing your project tools")
            }
            Event::UserEvent(DesktopEvent::EditorReady) => {
                editor_ready = true;
                if let Some(visible_at) = splash_visible_at {
                    if !editor_revealed {
                        if let Some(window) = main_window.as_ref() {
                            window.set_visible(true);
                            window.set_focus();
                        }
                        update_splash(splash_webview.as_ref(), 100, "Ready");
                        desktop_log("DREAMCRAFT_DESKTOP_READY");
                        editor_revealed = true;
                        splash_close_at = Some(visible_at + Duration::from_millis(1800));
                    }
                }
            }
            Event::UserEvent(DesktopEvent::WindowMinimize) => {
                if let Some(window) = main_window.as_ref() {
                    window.set_minimized(true);
                }
            }
            Event::UserEvent(DesktopEvent::WindowToggleMaximize) => {
                if let Some(window) = main_window.as_ref() {
                    window.set_maximized(!window.is_maximized());
                }
            }
            Event::UserEvent(DesktopEvent::WindowClose) => *control_flow = ControlFlow::Exit,
            Event::UserEvent(DesktopEvent::WindowDrag) => {
                if let Some(window) = main_window.as_ref() {
                    let _ = window.drag_window();
                }
            }
            Event::UserEvent(DesktopEvent::WindowResize(direction)) => {
                if let Some(window) = main_window.as_ref() {
                    let _ = window.drag_resize_window(direction);
                }
            }
            _ => {}
        }
    });
    desktop_log("DREAMCRAFT_DESKTOP_CLOSED");
    Ok(())
}

#[tokio::main]
async fn main() {
    sqlx::any::install_default_drivers();
    let root = application_data_dir();
    fs::create_dir_all(&root).expect("could not create DreamCraft application data folder");
    let default_project = root.join("sites").join("Starter");
    fs::create_dir_all(&default_project).expect("could not create starter project");
    initialize_embedded_starter(&default_project)
        .expect("could not initialize the starter website");
    let workspace_file = root.join(".dreamcraft").join("workspace.json");
    let saved_workspace = fs::read(&workspace_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Workspace>(&bytes).ok());
    let project = saved_workspace
        .as_ref()
        .map(|workspace| PathBuf::from(&workspace.current))
        .filter(|path| path.is_dir())
        .unwrap_or(default_project);
    let canonical_project = fs::canonicalize(&project).expect("could not resolve active project");
    let mut workspace = saved_workspace.unwrap_or_else(|| Workspace {
        current: String::new(),
        projects: Vec::new(),
    });
    let info = project_info(&canonical_project, None);
    workspace.current = info.path.clone();
    if !workspace
        .projects
        .iter()
        .any(|item| item.path.eq_ignore_ascii_case(&info.path))
    {
        workspace.projects.push(info);
    }
    let state = AppState {
        root: Arc::new(std::sync::RwLock::new(canonical_project)),
        app_root: Arc::new(root.clone()),
        workspace: Arc::new(std::sync::RwLock::new(workspace)),
        ai: Arc::new(RwLock::new(None)),
        deploy: Arc::new(RwLock::new(None)),
        webdav: Arc::new(RwLock::new(None)),
        ftp: Arc::new(RwLock::new(None)),
        testing_server: Arc::new(AsyncMutex::new(None)),
        device_preview: Arc::new(AsyncMutex::new(None)),
        external_database: Arc::new(RwLock::new(None)),
    };
    let app = Router::new()
        .route("/api/projects", get(projects))
        .route("/api/projects/open", post(open_project))
        .route("/api/projects/create", post(create_project))
        .route("/api/folders", get(browse_folders))
        .route("/api/bootstrap/create", post(create_bootstrap_starter))
        .route(
            "/api/testing/settings",
            get(testing_settings).put(update_testing_settings),
        )
        .route("/api/testing/start", post(start_testing_server))
        .route("/api/testing/status", get(testing_server_status))
        .route("/api/testing/stop", post(stop_testing_server_endpoint))
        .route("/api/device-preview/status", get(device_preview_status))
        .route("/api/device-preview/start", post(start_device_preview))
        .route(
            "/api/device-preview/stop",
            post(stop_device_preview_endpoint),
        )
        .route("/api/files", get(files))
        .route("/api/preprocessors/sass", post(build_sass))
        .route("/api/database/files", get(database_files))
        .route("/api/database/create", post(database_create))
        .route("/api/database/schema", post(database_schema))
        .route("/api/database/query", post(database_query))
        .route(
            "/api/database/remote/connection",
            get(remote_database_connection)
                .post(remote_database_connect)
                .delete(remote_database_disconnect),
        )
        .route("/api/database/remote/schema", post(remote_database_schema))
        .route("/api/database/remote/query", post(remote_database_query))
        .route("/api/browsers", get(external_browser_list))
        .route("/api/preview/live-version", get(live_preview_version))
        .route("/api/preview/open-external", post(open_external_preview))
        .route("/api/preview/browser-test", post(run_browser_test))
        .route("/api/snippets", get(get_snippets).put(update_snippets))
        .route("/api/rename", post(rename_file))
        .route("/api/folder", post(create_folder))
        .route("/api/upload", post(upload_multipart))
        .route("/api/publish", post(publish))
        .route("/api/snapshots", get(list_snapshots).post(create_snapshot))
        .route("/api/snapshots/{id}/restore", post(restore_snapshot))
        .route(
            "/api/deploy/settings",
            get(deploy_settings).put(update_deploy_settings),
        )
        .route("/api/deploy/publish", post(deploy_sftp))
        .route("/api/deploy/list", post(sftp_list))
        .route("/api/deploy/sync", post(sftp_sync))
        .route("/api/deploy/sync-upload", post(sftp_sync_upload))
        .route("/api/deploy/delete", post(sftp_delete_remote))
        .route("/api/deploy/rename", post(sftp_rename_remote))
        .route(
            "/api/ftp/settings",
            get(ftp_settings).put(update_ftp_settings),
        )
        .route("/api/ftp/test", post(test_ftp_connection))
        .route("/api/ftp/publish", post(publish_ftp))
        .route("/api/ftp/compare", post(compare_ftp))
        .route("/api/ftp/sync", post(sync_ftp_download))
        .route("/api/ftp/sync-upload", post(sync_ftp_upload))
        .route("/api/ftp/delete", post(ftp_delete_remote))
        .route("/api/ftp/rename", post(ftp_rename_remote))
        .route(
            "/api/webdav/settings",
            get(webdav_settings).put(update_webdav_settings),
        )
        .route("/api/webdav/test", post(test_webdav_connection))
        .route("/api/webdav/publish", post(publish_webdav))
        .route("/api/webdav/compare", post(webdav_compare))
        .route("/api/webdav/sync", post(webdav_sync))
        .route("/api/webdav/sync-upload", post(webdav_sync_upload))
        .route("/api/webdav/delete", post(webdav_delete_remote))
        .route("/api/webdav/rename", post(webdav_rename_remote))
        .route("/api/git/status", get(git_status))
        .route("/api/git/init", post(git_init))
        .route("/api/git/stage", post(git_stage))
        .route("/api/git/unstage", post(git_unstage))
        .route("/api/git/commit", post(git_commit))
        .route("/api/git/action", post(git_action))
        .route("/api/git/branch", post(git_branch))
        .route("/api/git/tag", post(git_tag))
        .route("/api/git/revert", post(git_revert))
        .route("/api/git/remote", post(git_remote))
        .route("/api/git/diff/{*path}", get(git_diff))
        .route("/api/ai/settings", get(ai_settings).put(update_ai_settings))
        .route("/api/ai/test", post(test_ai_connection))
        .route("/api/ai/chat", post(ai_chat))
        .route("/splash", get(embedded_splash))
        .route(
            "/api/file/{*path}",
            get(read_file).put(save_file).delete(delete_file),
        )
        .route("/published/{id}/{*path}", get(published_file))
        .route("/published/{id}", get(published_index))
        .route("/site/{*path}", get(serve_site_file))
        .route("/", get(embedded_index))
        .route("/{*path}", get(embedded_asset))
        .with_state(state.clone());
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:4387").await {
        Ok(listener) => listener,
        Err(_) => tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("could not bind a local DreamCraft port"),
    };
    let address = format!(
        "http://{}",
        listener.local_addr().expect("listener address unavailable")
    );
    if std::env::var_os("DREAMCRAFT_NO_BROWSER").is_some() {
        println!("DreamCraft is ready at {address}");
        axum::serve(listener, app)
            .await
            .expect("server stopped unexpectedly");
        return;
    }

    #[cfg(windows)]
    {
        let smoke_exit = std::env::var_os("DREAMCRAFT_DESKTOP_SMOKE").is_some();
        let (shutdown, shutdown_receiver) = tokio::sync::oneshot::channel();
        let shutdown_state = state.clone();
        let server = tokio::spawn(async move {
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_receiver.await;
                })
                .await;
            if let Err(error) = result {
                eprintln!("DreamCraft server stopped: {error}");
            }
            stop_testing_server(&shutdown_state).await;
            stop_device_preview(&shutdown_state).await;
        });
        desktop_log(&format!("DreamCraft desktop is starting at {address}"));
        if let Err(error) = run_native_desktop(&address, smoke_exit) {
            desktop_log(&format!("DreamCraft desktop could not start: {error}"));
        }
        let _ = shutdown.send(());
        let _ = server.await;
    }

    #[cfg(not(windows))]
    {
        println!("DreamCraft is ready at {address}");
        let _ = webbrowser::open(&address);
        axum::serve(listener, app)
            .await
            .expect("server stopped unexpectedly");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_git_state(root: &FsPath) -> AppState {
        AppState {
            root: Arc::new(std::sync::RwLock::new(root.to_path_buf())),
            app_root: Arc::new(root.to_path_buf()),
            workspace: Arc::new(std::sync::RwLock::new(Workspace {
                current: root.to_string_lossy().into_owned(),
                projects: Vec::new(),
            })),
            ai: Arc::new(RwLock::new(None)),
            deploy: Arc::new(RwLock::new(None)),
            webdav: Arc::new(RwLock::new(None)),
            ftp: Arc::new(RwLock::new(None)),
            testing_server: Arc::new(AsyncMutex::new(None)),
            device_preview: Arc::new(AsyncMutex::new(None)),
            external_database: Arc::new(RwLock::new(None)),
        }
    }

    #[tokio::test]
    async fn git_branch_tag_and_revert_workflows_pass_in_an_isolated_repo() {
        if Command::new("git").arg("--version").output().await.is_err() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "DreamCraft Tests"],
            vec!["config", "user.email", "dreamcraft-test@example.invalid"],
        ] {
            git_output(root, &args).await.unwrap();
        }
        tokio::fs::write(root.join("index.html"), "<!doctype html>\n")
            .await
            .unwrap();
        git_output(root, &["add", "index.html"]).await.unwrap();
        git_output(root, &["commit", "-m", "Initial commit"])
            .await
            .unwrap();

        let state = isolated_git_state(root);
        let _ = git_branch(
            State(state.clone()),
            Json(GitBranchRequest {
                action: "create".into(),
                name: "feature/layout".into(),
            }),
        )
        .await
        .unwrap();
        assert!(
            git_command(
                root,
                &["rev-parse", "--verify", "refs/heads/feature/layout"]
            )
            .await
            .unwrap()
            .status
            .success()
        );
        tokio::fs::write(root.join("feature.txt"), "feature\n")
            .await
            .unwrap();
        git_output(root, &["add", "feature.txt"]).await.unwrap();
        git_output(root, &["commit", "-m", "Feature change"])
            .await
            .unwrap();

        let _ = git_branch(
            State(state.clone()),
            Json(GitBranchRequest {
                action: "switch".into(),
                name: "main".into(),
            }),
        )
        .await
        .unwrap();
        let _ = git_branch(
            State(state.clone()),
            Json(GitBranchRequest {
                action: "merge".into(),
                name: "feature/layout".into(),
            }),
        )
        .await
        .unwrap();
        assert!(root.join("feature.txt").exists());

        let feature_hash = git_output(root, &["rev-parse", "--short", "HEAD"])
            .await
            .unwrap()
            .trim()
            .to_owned();
        let _ = git_tag(
            State(state.clone()),
            Json(GitTagRequest {
                action: "create".into(),
                name: "v1.0.0".into(),
                message: Some("First release".into()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            git_tag(
                State(state.clone()),
                Json(GitTagRequest {
                    action: "create".into(),
                    name: "v1.0.0".into(),
                    message: None,
                })
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::CONFLICT
        );
        let _ = git_revert(
            State(state.clone()),
            Json(GitRevertRequest {
                hash: feature_hash.clone(),
            }),
        )
        .await
        .unwrap();
        assert!(!root.join("feature.txt").exists());

        let Json(status) = git_status(State(state.clone())).await.unwrap();
        assert_eq!(status["branch"], "main");
        assert!(
            status["tags"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tag| tag == "v1.0.0")
        );
        assert!(
            status["branches"]
                .as_array()
                .unwrap()
                .iter()
                .any(|branch| branch == "feature/layout")
        );
        assert_eq!(
            git_branch(
                State(state.clone()),
                Json(GitBranchRequest {
                    action: "create".into(),
                    name: "bad..branch".into()
                })
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            git_branch(
                State(state.clone()),
                Json(GitBranchRequest {
                    action: "create".into(),
                    name: "feature/layout".into()
                })
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::CONFLICT
        );
        let _ = git_tag(
            State(state.clone()),
            Json(GitTagRequest {
                action: "delete".into(),
                name: "v1.0.0".into(),
                message: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            git_revert(
                State(state),
                Json(GitRevertRequest {
                    hash: "not-a-commit".into()
                })
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn project_preview_rewrites_only_root_relative_css_assets() {
        let input = r#"@import "/theme.css"; .hero{background:url('/assets/hero image.png');mask:url(//cdn.example/mask.svg)}/* url(/ignored.png) */ .x::after{content:"url(/text.png)"}"#;
        let output = rewrite_css_project_root_urls(input);
        assert!(output.contains("@import \"/site/theme.css\""));
        assert!(output.contains("url('/site/assets/hero image.png')"));
        assert!(output.contains("url(//cdn.example/mask.svg)"));
        assert!(output.contains("/* url(/ignored.png) */"));
        assert!(output.contains("content:\"url(/text.png)\""));
    }

    #[test]
    fn sftp_listing_keeps_names_with_spaces_and_distinguishes_folders() {
        assert_eq!(
            sftp_listing_name("-rw-r--r-- 1 owner group 42 Oct 21 12:00 hero image.webp"),
            Some(("hero image.webp".into(), "file", 42))
        );
        assert_eq!(
            sftp_listing_name("drwxr-xr-x 2 owner group 0 Oct 21 12:00 images"),
            Some(("images".into(), "directory", 0))
        );
        assert_eq!(
            sftp_listing_name("lrwxrwxrwx 1 owner group 7 Oct 21 12:00 link -> target"),
            None
        );
    }

    #[test]
    fn remote_paths_reject_traversal_and_controls() {
        assert!(valid_remote_relative("pages/home.html", false));
        assert!(valid_remote_relative("", true));
        assert!(!valid_remote_relative("../secrets.txt", false));
        assert!(!valid_remote_relative("images/../../secrets.txt", false));
        assert!(!valid_remote_relative("pages\\home.html", false));
        assert!(!valid_remote_relative("bad\nname.html", false));
    }

    #[test]
    fn remote_file_management_excludes_application_state() {
        assert!(remote_management_path("pages/about.html"));
        assert!(remote_management_path("folder/hero image.webp"));
        assert!(!remote_management_path(".git/config"));
        assert!(!remote_management_path("assets/.dreamcraft/releases/file"));
        assert!(!remote_management_path("../outside.html"));
    }

    #[test]
    fn ftp_mlsd_parsing_preserves_spaces_and_file_metadata() {
        let file = suppaftp::list::ListParser::parse_mlsd(
            "type=file;size=73;modify=20261021153000; hero image.webp",
        )
        .expect("valid MLSD line");
        assert_eq!(file.name(), "hero image.webp");
        assert!(file.is_file());
        assert_eq!(file.size(), 73);

        let directory =
            suppaftp::list::ListParser::parse_mlsd("type=dir;modify=20261021153000; assets")
                .expect("valid MLSD directory");
        assert_eq!(directory.name(), "assets");
        assert!(directory.is_directory());
    }

    #[test]
    fn sqlite_database_sql_supports_schema_parameters_and_results() {
        let database_path = std::env::temp_dir().join(format!(
            "dreamcraft-db-test-{}-{}.sqlite",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let connection = Connection::open(&database_path).expect("open test database");
        connection
            .execute_batch("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO people(name) VALUES ('Ada');")
            .expect("create test schema and record");
        let inserted = execute_database_statement(
            &connection,
            "INSERT INTO people(name) VALUES (?1)",
            &[SqlValue::Text("Grace".into())],
        )
        .expect("execute parameterized insert");
        assert_eq!(inserted["changes"], 1);
        let selected = execute_database_statement(
            &connection,
            "SELECT id, name FROM people WHERE name = ?1",
            &[SqlValue::Text("Grace".into())],
        )
        .expect("execute parameterized select");
        assert_eq!(selected["columns"], serde_json::json!(["id", "name"]));
        assert_eq!(selected["rows"][0][1], "Grace");
        assert_eq!(
            database_sql_value(&serde_json::json!(null)).unwrap(),
            SqlValue::Null
        );
        assert!(execute_database_statement(&connection, "SELECT * FROM missing", &[]).is_err());
        drop(connection);
        std::fs::remove_file(database_path).expect("remove test database");
    }

    #[test]
    fn embedded_app_and_starter_are_present_in_release_inputs() {
        assert!(EmbeddedAssets::get("index.html").is_some());
        assert!(EmbeddedAssets::get("app.js").is_some());
        assert!(EmbeddedAssets::get("php-scaffolder.mjs").is_some());
        assert!(EmbeddedAssets::get("vendor/codemirror/mode/php/php.js").is_some());
        let compatibility = EmbeddedAssets::get("vendor/browser-compat/index.json")
            .expect("the bundled MDN compatibility index is embedded");
        let index: serde_json::Value = serde_json::from_slice(&compatibility.data)
            .expect("the bundled MDN compatibility index is valid JSON");
        assert_eq!(index["metadata"]["packageVersion"], "8.1.6");
        assert!(index["css"]["properties"]["display.grid"].is_array());
        assert!(index["html"]["elements"]["dialog"].is_array());
        assert!(index["javascript"]["builtins"]["Promise.allSettled"].is_array());
        assert!(EmbeddedStarter::get("index.html").is_some());
    }

    #[test]
    fn remote_database_urls_validate_engines_and_encode_credentials() {
        let request = RemoteDatabaseRequest {
            engine: "mysql".into(),
            name: "Design DB".into(),
            host: "db.example.test".into(),
            port: 3307,
            database: "studio data".into(),
            username: "designer".into(),
            password: "p@ss/word".into(),
            tls: true,
        };
        let url = reqwest::Url::parse(&remote_database_url(&request).unwrap()).unwrap();
        assert_eq!(url.scheme(), "mysql");
        assert_eq!(url.host_str(), Some("db.example.test"));
        assert_eq!(url.port(), Some(3307));
        assert_eq!(url.path(), "/studio%20data");
        assert_eq!(url.password(), Some("p%40ss%2Fword"));
        let (tls_parameter, tls_value) = url.query_pairs().next().unwrap();
        assert_eq!(
            (tls_parameter.as_ref(), tls_value.as_ref()),
            ("ssl-mode", "REQUIRED")
        );

        let invalid = RemoteDatabaseRequest {
            engine: "sqlite".into(),
            ..request
        };
        assert_eq!(
            remote_database_url(&invalid).unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        let invalid_host = RemoteDatabaseRequest {
            engine: "postgres".into(),
            host: "bad\nhost".into(),
            ..invalid
        };
        assert_eq!(
            remote_database_url(&invalid_host).unwrap_err(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn testing_server_receives_remote_database_secrets_only_as_runtime_environment() {
        let environment = external_database_environment_values(
            "postgres",
            "db.example.test",
            5432,
            "cms",
            "cms_runtime",
            "session-secret",
            true,
        );
        let environment = environment
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            environment.get("DREAMCRAFT_DB_ENGINE").map(String::as_str),
            Some("postgres")
        );
        assert_eq!(
            environment.get("DREAMCRAFT_DB_PORT").map(String::as_str),
            Some("5432")
        );
        assert_eq!(
            environment
                .get("DREAMCRAFT_DB_PASSWORD")
                .map(String::as_str),
            Some("session-secret")
        );
        assert_eq!(
            environment.get("DREAMCRAFT_DB_TLS").map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn external_preview_is_limited_to_local_published_snapshots() {
        let origin = "http://127.0.0.1:4387";
        let valid = validate_external_preview_target(
            "http://127.0.0.1:4387/published/abc123/index.html",
            origin,
        )
        .expect("local published snapshots can be opened externally");
        assert_eq!(valid.path(), "/published/abc123/index.html");
        let live =
            validate_external_preview_target("http://127.0.0.1:4387/site/index.html", origin)
                .expect("live project pages can be opened externally");
        assert_eq!(live.path(), "/site/index.html");
        assert_eq!(
            validate_external_preview_target("https://example.com/published/site.html", origin)
                .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            validate_external_preview_target("http://127.0.0.1:4387/api/files", origin)
                .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            validate_external_preview_target("http://127.0.0.1:4387/site/../api/files", origin)
                .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            validate_external_preview_target(
                "http://127.0.0.1:4387/published/../api/files",
                origin
            )
            .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn live_preview_rewrites_root_links_and_tracks_project_changes() {
        let html = r#"<link href="/styles/site.css"><img src="/images/hero.png"><a href="//example.com">External</a>"#;
        let rewritten = rewrite_html_project_root_urls(html);
        assert!(rewritten.contains("href=\"/site/styles/site.css\""));
        assert!(rewritten.contains("src=\"/site/images/hero.png\""));
        assert!(rewritten.contains("href=\"//example.com\""));

        let project = tempfile::tempdir().expect("create isolated preview project");
        fs::write(project.path().join("index.html"), "first version").expect("write page");
        let first = project_revision(project.path()).expect("hash first version");
        fs::write(
            project.path().join("index.html"),
            "second version is longer",
        )
        .expect("update page");
        let second = project_revision(project.path()).expect("hash updated version");
        assert_ne!(
            first, second,
            "saved project changes must trigger a browser reload"
        );
    }

    #[test]
    fn published_preview_keeps_root_assets_inside_the_snapshot() {
        let html = r#"<link href="/styles.css?v=42"><script src="/script.js"></script><a href="/">Home</a><a href="//cdn.example.test/app.css">CDN</a>"#;
        let rewritten = rewrite_html_root_urls(html, "/published/123-4");
        assert!(rewritten.contains("href=\"/published/123-4/styles.css?v=42\""));
        assert!(rewritten.contains("src=\"/published/123-4/script.js\""));
        assert!(rewritten.contains("href=\"/published/123-4/index.html\""));
        assert!(rewritten.contains("href=\"//cdn.example.test/app.css\""));

        let css = r#"@import "/theme.css";.hero{background:url('/assets/hero.png')}"#;
        let rewritten = rewrite_css_root_urls(css, "/published/123-4");
        assert!(rewritten.contains("@import \"/published/123-4/theme.css\""));
        assert!(rewritten.contains("url('/published/123-4/assets/hero.png')"));
    }

    #[tokio::test]
    async fn connected_device_preview_is_token_scoped_and_read_only() {
        let project = tempfile::tempdir().expect("create device-preview site");
        fs::create_dir_all(project.path().join("css")).expect("create stylesheet folder");
        fs::write(
            project.path().join("index.html"),
            "<html><head><link href=\"/css/site.css\"></head><body>Device view</body></html>",
        )
        .expect("write device page");
        fs::write(
            project.path().join("css/site.css"),
            "body { background: url('/images/paper.png'); }",
        )
        .expect("write device stylesheet");
        let state = DevicePreviewState {
            root: Arc::new(std::sync::RwLock::new(project.path().to_path_buf())),
            token: "test-session".into(),
        };
        let page = device_preview_file(
            State(state.clone()),
            Path(("test-session".into(), "index.html".into())),
        )
        .await
        .expect("serve token-protected device page");
        let page_bytes = axum::body::to_bytes(page.into_body(), 1024 * 1024)
            .await
            .expect("read device page");
        let page_text = String::from_utf8(page_bytes.to_vec()).expect("device page is UTF-8");
        assert!(page_text.contains("href=\"/preview/test-session/css/site.css\""));
        assert!(page_text.contains("/preview/test-session/live-version"));
        let stylesheet = device_preview_file(
            State(state.clone()),
            Path(("test-session".into(), "css/site.css".into())),
        )
        .await
        .expect("serve token-protected stylesheet");
        let css = axum::body::to_bytes(stylesheet.into_body(), 1024 * 1024)
            .await
            .expect("read device stylesheet");
        assert!(
            String::from_utf8_lossy(&css).contains("url('/preview/test-session/images/paper.png')")
        );
        let denied = device_preview_file(
            State(state),
            Path(("wrong-session".into(), "index.html".into())),
        )
        .await;
        assert_eq!(denied.unwrap_err(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn runtime_browser_test_accepts_only_detectable_chromium_families() {
        assert!(chromium_browser_id("edge"));
        assert!(chromium_browser_id("chrome"));
        assert!(chromium_browser_id("chromium"));
        assert!(chromium_browser_id("brave"));
        assert!(!chromium_browser_id("firefox"));
        assert!(!chromium_browser_id("safari"));
        assert!(!chromium_browser_id("arbitrary"));
    }

    #[test]
    fn local_origin_tracks_the_bound_loopback_port() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "http://127.0.0.1:54321".parse().unwrap());
        headers.insert(header::HOST, "127.0.0.1:54321".parse().unwrap());
        assert!(local_origin(&headers));
        headers.insert(header::ORIGIN, "http://127.0.0.1:4387".parse().unwrap());
        assert!(!local_origin(&headers));
        headers.insert(header::ORIGIN, "https://127.0.0.1:54321".parse().unwrap());
        headers.insert(header::HOST, "127.0.0.1:54321".parse().unwrap());
        assert!(!local_origin(&headers));
    }
}
