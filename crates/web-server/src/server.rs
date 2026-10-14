use crate::{auth::Auth, error::AppError, state::AppState};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{convert::Infallible, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::services::{ServeDir, ServeFile};
use vrcx_0_application_core::{GuiRuntimeMode, RuntimeEventSink};

#[derive(Clone)]
pub struct WebState {
    pub app: Arc<AppState>,
    pub auth: Arc<Auth>,
    pub events: broadcast::Sender<(String, Value)>,
    pub files: Arc<crate::files::Files>,
}
pub type ApiError = (StatusCode, Json<Value>);
pub fn error(status: StatusCode, message: impl ToString) -> ApiError {
    (
        status,
        Json(json!({"code":"web", "message":message.to_string()})),
    )
}
pub fn require_auth(state: &WebState, headers: &HeaderMap) -> Result<(), ApiError> {
    if state.auth.authenticated(headers) {
        Ok(())
    } else if state.auth.password_required() {
        Err(error(StatusCode::UNAUTHORIZED, "Website login required"))
    } else {
        Err(error(StatusCode::FORBIDDEN, "Invalid LAN request"))
    }
}
pub fn require_mutation(state: &WebState, headers: &HeaderMap) -> Result<(), ApiError> {
    require_auth(state, headers)?;
    if state.auth.validate_request(headers) {
        Ok(())
    } else {
        Err(error(StatusCode::FORBIDDEN, "Invalid request origin"))
    }
}

struct EventSink(broadcast::Sender<(String, Value)>);
impl RuntimeEventSink for EventSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.send((event.to_owned(), payload));
    }
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let lan_mode = match std::env::var("VRCX_WEB_LAN_MODE")
        .unwrap_or_default()
        .as_str()
    {
        "1" | "true" => true,
        "" | "0" | "false" => false,
        _ => return Err("VRCX_WEB_LAN_MODE must be 0, 1, false or true".into()),
    };
    let origin =
        std::env::var("VRCX_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:8080".into());
    if !lan_mode && origin.trim().is_empty() {
        return Err("Set VRCX_WEB_ORIGIN or enable VRCX_WEB_LAN_MODE for LAN HTTP access".into());
    }
    let password = if let Ok(file) = std::env::var("VRCX_WEB_PASSWORD_FILE") {
        std::fs::read_to_string(file)?
    } else {
        match std::env::var("VRCX_WEB_PASSWORD") {
            Ok(password) => password,
            Err(std::env::VarError::NotPresent) => String::new(),
            Err(error) => return Err(error.into()),
        }
    };
    let auth = Arc::new(Auth::with_lan_mode(
        password.trim_end_matches(['\r', '\n']),
        &origin,
        lan_mode,
    )?);
    drop(password);
    let paths = vrcx_0_platform::app_paths::resolve_app_data_dir()?;
    let files = Arc::new(crate::files::Files::new(&paths.current_dir)?);
    let app = Arc::new(AppState::new(
        paths,
        None,
        Arc::new(vrcx_0_application_core::NoopUpdaterPort),
        Arc::new(crate::Executor),
    )?);
    let (events, _) = broadcast::channel(1024);
    app.runtime_host()
        .set_runtime_event_sink(EventSink(events.clone()));
    app.runtime_host()
        .set_runtime_host_actions(WebHostActions(Arc::downgrade(&app)));
    app.runtime_host().start_data_services();
    let state = WebState {
        app: app.clone(),
        auth: auth.clone(),
        events,
        files,
    };
    let dist = PathBuf::from(std::env::var("VRCX_WEB_DIST").unwrap_or_else(|_| "dist".into()));
    if !dist.join("index.html").is_file() {
        return Err(format!("Frontend not built: {}", dist.display()).into());
    }
    let router = router(state).fallback_service(
        ServeDir::new(&dist).not_found_service(ServeFile::new(dist.join("index.html"))),
    );
    let bind = std::env::var("VRCX_WEB_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let public_origin = if lan_mode {
        "LAN HTTP (request Host)"
    } else {
        &origin
    };
    tracing::info!(%bind, origin = public_origin, lan_mode, "VRCX-0 web server ready");
    let runtime_app = app.clone();
    tokio::spawn(async move {
        match runtime_app.runtime_host().database_upgrade().run().await {
            Ok(_) => {
                if let Err(error) = runtime_app
                    .runtime_host()
                    .start_gui_backend_runtime(GuiRuntimeMode::Background)
                    .await
                {
                    tracing::warn!(%error, "Open the website to complete VRChat login");
                }
            }
            Err(error) => tracing::error!(%error, "Database requires attention in the website"),
        }
    });
    axum::serve(listener, router).with_graceful_shutdown(async move {
        #[cfg(unix)]
        {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {}, _ = crate::RESTART.notified() => {} }
        }
        #[cfg(not(unix))]
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = crate::RESTART.notified() => {} }
        auth.shutdown();
        // Flush the shared runtime before waiting for HTTP clients to disconnect.
        // An idle browser connection must not defer saving persistent state.
        let result = tokio::task::spawn_blocking(move || {
            app.runtime_host().stop_for_application_exit("web-server-stop", || {})
        }).await;
        if let Err(error) = result {
            tracing::error!(%error, "Runtime shutdown task failed");
        }
    }).await?;
    Ok(())
}

struct WebHostActions(std::sync::Weak<AppState>);
impl vrcx_0_runtime_host_desktop::RuntimeHostActions for WebHostActions {
    fn focus_main_window(&self) {}
    fn set_tray_icon_notification(&self, _: bool) {}
    fn refresh_tray_menu(&self) {}
    fn vrchat_auth_failed(
        &self,
        failure: &vrcx_0_application_core::RuntimeVrchatAuthFailurePayload,
    ) {
        use vrcx_0_runtime_host_desktop::auth_failure::*;
        let Some(app) = self.0.upgrade() else { return };
        if !is_actionable_runtime_auth_failure(failure) {
            return;
        }
        let failure = failure.clone();
        tokio::spawn(async move {
            let runtime = app.runtime_host();
            if runtime_auth_failure_matches_scope(&runtime.auth_scope_snapshot(), &failure)
                && runtime_auth_failure_transport_matches(
                    runtime.active_realtime_transport().as_ref(),
                    failure.realtime_transport.as_ref(),
                )
            {
                runtime
                    .recover_background_auth_after_failure(failure.reason)
                    .await;
            }
        });
    }
}

pub fn router(state: WebState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/api/session", get(session))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route(
            "/api/invoke/{command}",
            post(invoke).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/api/events", get(events))
        .route(
            "/api/files/upload",
            post(crate::files::upload).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route(
            "/api/files/directory",
            post(crate::files::upload_directory).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route(
            "/api/files/folders",
            get(crate::files::folders).post(crate::files::create_folder),
        )
        .route(
            "/api/files/folders/select",
            post(crate::files::select_folder),
        )
        .route("/api/files/reserve", post(crate::files::reserve))
        .route("/api/files/read", get(crate::files::read))
        .route("/api/files/list", get(crate::files::list))
        .route("/api/files/ready", get(crate::files::ready))
        .route(
            "/api/{*rest}",
            get(|| async { StatusCode::NOT_FOUND }).post(|| async { StatusCode::NOT_FOUND }),
        )
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                response
                    .headers_mut()
                    .insert("x-content-type-options", "nosniff".parse().unwrap());
                response
                    .headers_mut()
                    .insert("x-frame-options", "DENY".parse().unwrap());
                response
                    .headers_mut()
                    .insert("referrer-policy", "same-origin".parse().unwrap());
                response
            },
        ))
        .with_state(state)
}

async fn session(
    State(state): State<WebState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    if !state.auth.password_required() {
        require_auth(&state, &headers)?;
    }
    Ok(Json(json!({
        "authenticated": state.auth.authenticated(&headers),
        "passwordRequired": state.auth.password_required()
    })))
}
#[derive(Deserialize)]
struct Login {
    password: String,
}
async fn login(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> Result<Response, ApiError> {
    if !state.auth.validate_request(&headers) {
        return Err(error(StatusCode::FORBIDDEN, "Invalid request origin"));
    }
    if !state.auth.password_required() {
        require_auth(&state, &headers)?;
        return Ok(Json(json!({"authenticated":true})).into_response());
    }
    let auth = state.auth.clone();
    let token = tokio::task::spawn_blocking(move || auth.login(&input.password))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        .map_err(|e| error(StatusCode::UNAUTHORIZED, e))?;
    Ok((
        [(header::SET_COOKIE, state.auth.cookie_header(&token))],
        Json(json!({"authenticated":true})),
    )
        .into_response())
}
async fn logout(State(state): State<WebState>, headers: HeaderMap) -> Result<Response, ApiError> {
    require_mutation(&state, &headers)?;
    state.auth.logout(&headers);
    Ok((
        [(header::SET_COOKIE, state.auth.cookie_header(""))],
        Json(json!({"authenticated":state.auth.authenticated(&headers)})),
    )
        .into_response())
}

async fn invoke(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(command): Path<String>,
    Json(args): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_mutation(&state, &headers)?;
    let command_args = args.clone();
    let result = match command.as_str() {
        command if command.starts_with("app__privacy_lock_") => {
            let app = state.app.clone();
            let command = command.to_owned();
            tokio::task::spawn_blocking(move || privacy_command(&app, &command, &args))
                .await
                .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
        "app__get_file_base64" => crate::files::base64(&state, &args).await,
        "app__resize_image_to_fit_limits" => {
            let media = state.app.runtime_host().media().clone();
            let data = args["base64data"].as_str().unwrap_or_default().to_owned();
            tokio::task::spawn_blocking(move || {
                media
                    .resize_image_to_fit_limits(&data)
                    .map(Value::String)
                    .map_err(AppError::from)
            })
            .await
            .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
        "app__backend_runtime_combined_snapshot_get" => Ok(serde_json::to_value(
            state.app.runtime_host().backend_runtime_combined_snapshot(),
        )
        .unwrap()),
        "app__backend_runtime_snapshot" => {
            Ok(serde_json::to_value(state.app.runtime_host().backend_runtime_snapshot()).unwrap())
        }
        _ => {
            crate::commands::dispatch(
                state.app.clone(),
                &command,
                if args.is_null() { json!({}) } else { args },
            )
            .await
        }
    };
    let mut result = result.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::to_value(e).unwrap()),
        )
    })?;
    state.files.command_completed(&command_args);
    if command == "app__get_host_capabilities" {
        mask_capabilities(&mut result);
    }
    if command == "app__startup_bootstrap_snapshot_get" {
        mask_capabilities(&mut result["hostCapabilities"]);
    }
    Ok(Json(result))
}

fn privacy_command(app: &AppState, command: &str, args: &Value) -> Result<Value, AppError> {
    let lock = app.runtime_host().privacy_lock();
    let text = |key: &str| {
        args[key]
            .as_str()
            .ok_or_else(|| AppError::Custom(format!("Missing {key}")))
    };
    let outcome = match command {
        "app__privacy_lock_setup_request_take" => return Ok(json!(lock.take_setup_request())),
        "app__privacy_lock_engage" => lock.engage(),
        "app__privacy_lock_unlock" => lock.unlock(text("password")?),
        "app__privacy_lock_password_set" => lock.set_password(text("password")?),
        "app__privacy_lock_password_change" => {
            lock.change_password(text("currentPassword")?, text("newPassword")?)
        }
        "app__privacy_lock_password_clear" => {
            lock.clear_with_account_password(text("accountPassword")?)
        }
        _ => return Err(AppError::Custom("Unknown privacy lock command".into())),
    }?;
    Ok(serde_json::to_value(outcome)?)
}

fn mask_capabilities(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        for (key, capability) in object {
            if capability.is_object()
                && !matches!(
                    key.as_str(),
                    "localDatabase" | "websocketRuntime" | "runtimeRealtimeTransport"
                )
            {
                *capability = json!({"supported":false,"enabled":false,"available":false,"reason":"Unavailable in the web host"});
            }
        }
    }
}

async fn events(State(state): State<WebState>, headers: HeaderMap) -> Result<Response, ApiError> {
    require_auth(&state, &headers)?;
    let mut source = state.events.subscribe();
    let (sender, receiver) = mpsc::channel(32);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(15));
        loop {
            if !state.auth.authenticated(&headers) {
                break;
            }
            let event = tokio::select! {
                _ = sender.closed() => break,
                _ = tick.tick() => { continue; },
                next = source.recv() => match next {
                    Ok((name, payload)) => Event::default().json_data(json!({"event":name,"payload":payload})).unwrap(),
                    Err(broadcast::error::RecvError::Lagged(_)) => Event::default().event("resync").data(""),
                    Err(_) => break,
                }
            };
            if !state.auth.authenticated(&headers) {
                break;
            }
            if !matches!(
                tokio::time::timeout(
                    Duration::from_secs(15),
                    sender.send(Ok::<_, Infallible>(event))
                )
                .await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
    });
    Ok(Sse::new(ReceiverStream::new(receiver))
        .keep_alive(KeepAlive::default())
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test(flavor = "multi_thread")]
    async fn authenticated_commands_use_upstream_storage_and_hide_game_capabilities() {
        let directory = std::env::temp_dir().join(format!(
            "vrcx-web-http-{}",
            vrcx_0_local_server::generate_token().unwrap()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let paths = vrcx_0_platform::app_paths::AppDataDirResolution {
            current_dir: directory.clone(),
            default_dir: directory.clone(),
            persisted_dir: None,
            cli_dir: Some(directory.clone()),
            source: vrcx_0_platform::app_paths::AppDataDirSource::Cli,
        };
        let app = Arc::new(
            AppState::new(
                paths,
                None,
                Arc::new(vrcx_0_application_core::NoopUpdaterPort),
                Arc::new(crate::Executor),
            )
            .unwrap(),
        );
        let auth = Arc::new(Auth::new("test-admin-password", "http://localhost:8080").unwrap());
        let token = auth.login("test-admin-password").unwrap();
        let cookie = format!("{}={token}", crate::auth::COOKIE);
        let (events, _) = broadcast::channel(16);
        let router = router(WebState {
            app: app.clone(),
            auth,
            events,
            files: Arc::new(crate::files::Files::new(&directory).unwrap()),
        });
        let request = |command: &str, body: Value, authenticated: bool, origin: &str| {
            let mut request = Request::post(format!("/api/invoke/{command}"))
                .header("content-type", "application/json")
                .header("origin", origin)
                .header("x-vrcx-web", "1");
            if authenticated {
                request = request.header("cookie", &cookie);
            }
            request.body(Body::from(body.to_string())).unwrap()
        };
        let response = router
            .clone()
            .oneshot(request(
                "storage__get_all",
                json!({}),
                false,
                "http://localhost:8080",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = router
            .clone()
            .oneshot(request(
                "storage__get_all",
                json!({}),
                true,
                "https://attacker.example",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = router
            .clone()
            .oneshot(request(
                "storage__set",
                json!({"key":"web-test","value":"persisted"}),
                true,
                "http://localhost:8080",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = router
            .clone()
            .oneshot(request(
                "storage__get_all",
                json!({}),
                true,
                "http://localhost:8080",
            ))
            .await
            .unwrap();
        let data: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(data["web-test"], "persisted");
        let response = router
            .clone()
            .oneshot(request(
                "app__startup_bootstrap_snapshot_get",
                json!({}),
                true,
                "http://localhost:8080",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let data: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            data["hostCapabilities"]["gameProcessMonitor"]["supported"],
            false
        );
        assert_eq!(
            data["hostCapabilities"]["runtimeRealtimeTransport"]["available"],
            true
        );
        let response = router
            .clone()
            .oneshot(request(
                "not_a_command",
                json!({}),
                true,
                "http://localhost:8080",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = router
            .clone()
            .oneshot(
                Request::get("/api/files/read?path=/etc/passwd")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let before = app.runtime_host().backend_runtime_snapshot().phase;
        let response = router
            .clone()
            .oneshot(
                Request::post("/api/logout")
                    .header("cookie", &cookie)
                    .header("origin", "http://localhost:8080")
                    .header("x-vrcx-web", "1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(app.runtime_host().backend_runtime_snapshot().phase, before);
        let response = router
            .clone()
            .oneshot(request(
                "storage__get_all",
                json!({}),
                true,
                "http://localhost:8080",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        app.runtime_host().stop_for_application_exit("test", || {});
        drop(router);
        drop(app);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn passwordless_lan_supports_commands_files_and_events_without_cookies() {
        let directory = std::env::temp_dir().join(format!(
            "vrcx-passwordless-{}",
            vrcx_0_local_server::generate_token().unwrap()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let app = Arc::new(
            AppState::new(
                vrcx_0_platform::app_paths::AppDataDirResolution {
                    current_dir: directory.clone(),
                    default_dir: directory.clone(),
                    persisted_dir: None,
                    cli_dir: Some(directory.clone()),
                    source: vrcx_0_platform::app_paths::AppDataDirSource::Cli,
                },
                None,
                Arc::new(vrcx_0_application_core::NoopUpdaterPort),
                Arc::new(crate::Executor),
            )
            .unwrap(),
        );
        let (events, _) = broadcast::channel(16);
        let files = Arc::new(crate::files::Files::new(&directory).unwrap());
        let file = files.allocate("synthetic.txt").unwrap();
        std::fs::write(&file, "synthetic file contents").unwrap();
        let auth = Arc::new(Auth::with_lan_mode("", "", true).unwrap());
        let router = router(WebState {
            app: app.clone(),
            auth: auth.clone(),
            events: events.clone(),
            files,
        });
        let request = |method: &str, uri: &str, body: Value| {
            Request::builder()
                .method(method)
                .uri(uri)
                .header("host", "localhost:8080")
                .header("origin", "http://localhost:8080")
                .header("x-vrcx-web", "1")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let response = router
            .clone()
            .oneshot(request("GET", "/api/session", Value::Null))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        let session: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            session,
            json!({"authenticated":true,"passwordRequired":false})
        );
        for endpoint in ["/api/login", "/api/logout"] {
            let response = router
                .clone()
                .oneshot(request("POST", endpoint, json!({"password":""})))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let result: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(result["authenticated"], true);
        }
        let response = router
            .clone()
            .oneshot(request(
                "POST",
                "/api/invoke/storage__set",
                json!({"key":"lan-test","value":"saved"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = router
            .clone()
            .oneshot(request("POST", "/api/invoke/storage__get_all", json!({})))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let storage: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(storage["lan-test"], "saved");
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", file.to_str().unwrap())
            .finish();
        let response = router
            .clone()
            .oneshot(request(
                "GET",
                &format!("/api/files/read?{query}"),
                Value::Null,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            b"synthetic file contents"
        );
        let response = router
            .clone()
            .oneshot(request(
                "GET",
                "/api/files/read?path=/etc/passwd",
                Value::Null,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = router
            .clone()
            .oneshot(request(
                "POST",
                "/api/files/folders",
                json!({"parent":"","name":"backups"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = router
            .clone()
            .oneshot(request("GET", "/api/events", Value::Null))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut stream = response.into_body();
        events
            .send(("lan-test".into(), json!({"value":1})))
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(2), stream.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let data = String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap();
        assert!(data.contains("lan-test"), "{data}");
        drop(stream);
        for (method, endpoint, payload) in [
            ("GET", "/api/session", Value::Null),
            ("GET", "/api/events", Value::Null),
            ("GET", "/api/files/folders?path=", Value::Null),
            ("POST", "/api/invoke/storage__get_all", json!({})),
        ] {
            for (name, value) in [
                ("host", "attacker.example:8080"),
                ("origin", "http://localhost:9000"),
                ("sec-fetch-site", "cross-site"),
            ] {
                let mut rejected = request(method, endpoint, payload.clone());
                rejected.headers_mut().insert(name, value.parse().unwrap());
                assert_eq!(
                    router.clone().oneshot(rejected).await.unwrap().status(),
                    StatusCode::FORBIDDEN,
                    "{endpoint}: {name}"
                );
            }
        }
        for missing in ["origin", "x-vrcx-web"] {
            let mut rejected = request("POST", "/api/invoke/storage__get_all", json!({}));
            rejected.headers_mut().remove(missing);
            assert_eq!(
                router.clone().oneshot(rejected).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
        let response = router
            .clone()
            .oneshot(request("GET", "/api/events", Value::Null))
            .await
            .unwrap();
        let mut stream = response.into_body();
        auth.shutdown();
        let _ = events.send(("shutdown-check".into(), Value::Null));
        assert!(tokio::time::timeout(Duration::from_secs(2), stream.frame())
            .await
            .unwrap()
            .is_none());
        drop(stream);
        app.runtime_host()
            .stop_for_application_exit("passwordless test", || {});
        drop(router);
        drop(app);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
