use crate::server::{error, require_auth, require_mutation, ApiError, WebState};
use axum::{
    extract::{Multipart, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

pub struct Files {
    root: PathBuf,
    images: PathBuf,
    completed: Mutex<HashSet<String>>,
}
impl Files {
    pub fn new(data: &Path) -> std::io::Result<Self> {
        let root = data.join("web-files");
        std::fs::create_dir_all(&root)?;
        let images = data.join("ImageCache");
        Ok(Self {
            root: root.canonicalize()?,
            images,
            completed: Mutex::new(HashSet::new()),
        })
    }
    pub fn allocate(&self, name: &str) -> std::io::Result<PathBuf> {
        let name = Path::new(name)
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.is_empty() && *n != "." && *n != "..")
            .unwrap_or("download");
        let token = vrcx_0_local_server::generate_token().map_err(std::io::Error::other)?;
        let directory = self.root.join(token);
        std::fs::create_dir(&directory)?;
        Ok(directory.join(name))
    }
    fn readable(&self, path: &str) -> std::io::Result<PathBuf> {
        let path = Path::new(path).canonicalize()?;
        let image_allowed = self
            .images
            .canonicalize()
            .ok()
            .is_some_and(|root| path.starts_with(root));
        if !path.is_file() || (!path.starts_with(&self.root) && !image_allowed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "File is not a browser resource",
            ));
        }
        Ok(path)
    }
    pub fn command_completed(&self, args: &Value) {
        match args {
            Value::String(path) if self.readable(path).is_ok() => {
                self.completed.lock().unwrap().insert(path.clone());
            }
            Value::Object(object) => {
                for value in object.values() {
                    self.command_completed(value);
                }
            }
            Value::Array(array) => {
                for value in array {
                    self.command_completed(value);
                }
            }
            _ => {}
        }
    }
}
pub async fn upload(
    State(state): State<WebState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    require_mutation(&state, &headers)?;
    let mut field = multipart
        .next_field()
        .await
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Missing file"))?;
    let path = state
        .files
        .allocate(field.file_name().unwrap_or("upload"))
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    file.flush()
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    state.app.runtime_host().register_host_file_access(&path);
    Ok(Json(json!({"path":path})))
}
#[derive(Deserialize)]
pub struct Reserve {
    name: String,
    #[serde(default)]
    directory: bool,
}
pub async fn reserve(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(input): Json<Reserve>,
) -> Result<Json<Value>, ApiError> {
    require_mutation(&state, &headers)?;
    let path = state
        .files
        .allocate(&input.name)
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    if input.directory {
        tokio::fs::create_dir(&path)
            .await
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    state.app.runtime_host().register_host_file_access(&path);
    Ok(Json(json!({"path":path})))
}
#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
    #[serde(default)]
    download: bool,
}
pub async fn list(
    State(state): State<WebState>,
    headers: HeaderMap,
    Query(query): Query<FileQuery>,
) -> Result<Json<Value>, ApiError> {
    require_auth(&state, &headers)?;
    let root = tokio::fs::canonicalize(&query.path)
        .await
        .map_err(|_| error(StatusCode::NOT_FOUND, "Folder unavailable"))?;
    if !root.starts_with(&state.files.root) {
        return Err(error(StatusCode::NOT_FOUND, "Folder unavailable"));
    }
    let mut entries = tokio::fs::read_dir(root)
        .await
        .map_err(|_| error(StatusCode::NOT_FOUND, "Folder unavailable"))?;
    let mut files = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
    {
        let path = entry.path();
        if state.files.readable(&path.to_string_lossy()).is_ok() {
            files.push(json!({"name": entry.file_name().to_string_lossy(), "path":path}));
        }
    }
    Ok(Json(json!(files)))
}
pub async fn ready(
    State(state): State<WebState>,
    headers: HeaderMap,
    Query(query): Query<FileQuery>,
) -> Result<Json<Value>, ApiError> {
    require_auth(&state, &headers)?;
    let backup = state.app.runtime_host().profile_backup().current_status();
    if backup.state != vrcx_0_application::profile::ProfileBackupState::Running
        && backup.last_outcome.is_some_and(|outcome| {
            outcome.succeeded
                && outcome.file_name.as_deref()
                    == Path::new(&query.path)
                        .file_name()
                        .and_then(|name| name.to_str())
        })
    {
        state
            .files
            .command_completed(&Value::String(query.path.clone()));
    }
    Ok(Json(
        json!({"ready":state.files.completed.lock().unwrap().contains(&query.path) && state.files.readable(&query.path).is_ok()}),
    ))
}

#[derive(Deserialize)]
pub struct DirectoryQuery {
    #[serde(default)]
    legacy: bool,
}
pub async fn upload_directory(
    State(state): State<WebState>,
    headers: HeaderMap,
    Query(query): Query<DirectoryQuery>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    require_mutation(&state, &headers)?;
    let legacy_target = if query.legacy {
        Some(PathBuf::from(
            std::env::var("VRCX_LEGACY_DATA_DIR").map_err(|_| {
                error(
                    StatusCode::BAD_REQUEST,
                    "Configure VRCX_LEGACY_DATA_DIR before importing legacy data",
                )
            })?,
        ))
    } else {
        None
    };
    let mut root = state
        .files
        .allocate("folder")
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| error(StatusCode::BAD_REQUEST, e))?
    {
        let relative = field.file_name().unwrap_or_default().to_owned();
        let path = checked_relative(&relative).map_err(|e| error(StatusCode::BAD_REQUEST, e))?;
        if query.legacy
            && !matches!(
                relative.as_str(),
                "VRCX.sqlite3" | "VRCX.sqlite3-wal" | "VRCX.sqlite3-shm" | "VRCX.json" | "VRCX"
            )
        {
            continue;
        }
        let path = root.join(path);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        }
        let mut file = tokio::fs::File::create(path)
            .await
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| error(StatusCode::BAD_REQUEST, e))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        }
        file.flush()
            .await
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    }
    if let Some(target) = legacy_target {
        if !root.join("VRCX.sqlite3").is_file() {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Select the original VRCX data folder containing VRCX.sqlite3",
            ));
        }
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        }
        if target.exists() {
            let previous = state
                .files
                .allocate("previous-legacy-import")
                .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
            tokio::fs::rename(&target, previous)
                .await
                .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        }
        tokio::fs::rename(&root, &target)
            .await
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        root = target;
    }
    state.app.runtime_host().register_host_file_access(&root);
    Ok(Json(json!({"path":root})))
}
fn checked_relative(value: &str) -> Result<&Path, &'static str> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid relative upload path");
    }
    Ok(path)
}
pub async fn read(
    State(state): State<WebState>,
    headers: HeaderMap,
    Query(query): Query<FileQuery>,
) -> Result<Response, ApiError> {
    require_auth(&state, &headers)?;
    let path = state
        .files
        .readable(&query.path)
        .map_err(|_| error(StatusCode::NOT_FOUND, "File unavailable"))?;
    let mut response = tower_http::services::ServeFile::new(&path)
        .try_call(
            axum::http::Request::builder()
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .into_response();
    // Never execute uploaded HTML/SVG under the authenticated application origin.
    response.headers_mut().insert(
        "content-security-policy",
        "sandbox; default-src 'none'".parse().unwrap(),
    );
    if query.download {
        let name = path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .replace(['"', '\r', '\n'], "_");
        if let Ok(value) = format!("attachment; filename=\"{name}\"").parse() {
            response
                .headers_mut()
                .insert(header::CONTENT_DISPOSITION, value);
        }
    }
    Ok(response)
}
pub async fn base64(state: &WebState, args: &Value) -> Result<Value, crate::error::AppError> {
    let path = state
        .files
        .readable(args["path"].as_str().unwrap_or_default())?;
    let bytes = tokio::fs::read(path).await?;
    Ok(Value::String(
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resources_cannot_escape_the_file_root() {
        let data = std::env::temp_dir().join(format!(
            "vrcx-web-files-{}",
            vrcx_0_local_server::generate_token().unwrap()
        ));
        let files = Files::new(&data).unwrap();
        let path = files.allocate("../../escape.txt").unwrap();
        assert!(path.starts_with(data.join("web-files")));
        std::fs::write(&path, "test").unwrap();
        assert!(files.readable(path.to_str().unwrap()).is_ok());
        let secret = data.join("secret");
        std::fs::write(&secret, "secret").unwrap();
        assert!(files.readable(secret.to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            let link = files.root.join("link");
            std::os::unix::fs::symlink(&secret, &link).unwrap();
            assert!(files.readable(link.to_str().unwrap()).is_err());
        }
        std::fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn directory_uploads_reject_traversal() {
        for path in [
            "",
            "../secret",
            "/etc/passwd",
            "folder/../../secret",
            "folder\\..\\secret",
        ] {
            assert!(checked_relative(path).is_err(), "{path}");
        }
        assert!(checked_relative("images/background.png").is_ok());
    }
}
