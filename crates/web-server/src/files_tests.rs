use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[derive(Clone, Copy)]
enum TestAuth {
    SignedIn,
    MissingCookie,
    ForeignOrigin,
    MissingMarker,
}

struct TestServer {
    router: axum::Router,
    state: WebState,
    cookie: String,
    data: PathBuf,
}
impl TestServer {
    fn new() -> Self {
        let data = std::env::temp_dir().join(format!(
            "vrcx-folders-{}",
            vrcx_0_local_server::generate_token().unwrap()
        ));
        std::fs::create_dir_all(&data).unwrap();
        let app = Arc::new(
            crate::state::AppState::new(
                vrcx_0_platform::app_paths::AppDataDirResolution {
                    current_dir: data.clone(),
                    default_dir: data.clone(),
                    persisted_dir: None,
                    cli_dir: Some(data.clone()),
                    source: vrcx_0_platform::app_paths::AppDataDirSource::Cli,
                },
                None,
                Arc::new(vrcx_0_application_core::NoopUpdaterPort),
                Arc::new(crate::Executor),
            )
            .unwrap(),
        );
        let auth = Arc::new(
            crate::auth::Auth::new("synthetic-folder-test", "http://localhost:8080").unwrap(),
        );
        let cookie = format!(
            "{}={}",
            crate::auth::COOKIE,
            auth.login("synthetic-folder-test").unwrap()
        );
        let state = WebState {
            app,
            auth,
            events: tokio::sync::broadcast::channel(16).0,
            files: Arc::new(Files::new(&data).unwrap()),
        };
        Self {
            router: crate::server::router(state.clone()),
            state,
            cookie,
            data,
        }
    }
    async fn send(
        &self,
        method: &str,
        url: &str,
        content_type: &str,
        body: String,
        auth: TestAuth,
    ) -> (StatusCode, Value) {
        let origin = if matches!(auth, TestAuth::ForeignOrigin) {
            "https://attacker.example"
        } else {
            "http://localhost:8080"
        };
        let mut request = Request::builder()
            .method(method)
            .uri(url)
            .header("content-type", content_type)
            .header("origin", origin);
        if !matches!(auth, TestAuth::MissingCookie) {
            request = request.header("cookie", &self.cookie);
        }
        if !matches!(auth, TestAuth::MissingMarker) {
            request = request.header("x-vrcx-web", "1");
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    async fn json(&self, method: &str, url: &str, body: Value) -> (StatusCode, Value) {
        self.send(
            method,
            url,
            "application/json",
            body.to_string(),
            TestAuth::SignedIn,
        )
        .await
    }
    async fn upload(&self, query: &str, files: &[(&str, &str)]) -> (StatusCode, Value) {
        let mut body = String::new();
        for (name, data) in files {
            body.push_str(&format!("--test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n{data}\r\n"));
        }
        body.push_str("--test-boundary--\r\n");
        self.send(
            "POST",
            &format!("/api/files/directory?{query}"),
            "multipart/form-data; boundary=test-boundary",
            body,
            TestAuth::SignedIn,
        )
        .await
    }
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.state
            .app
            .runtime_host()
            .stop_for_application_exit("folder test", || {});
        std::fs::remove_dir_all(&self.data).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn background_sources_cannot_grant_access_outside_web_files() {
    let server = TestServer::new();
    // A sibling of web-files is server data, not a browser-selectable resource.
    let outside = server.data.join("private");
    std::fs::create_dir(&outside).unwrap();
    let image = outside.join("private.png");
    std::fs::write(&image, b"synthetic image").unwrap();
    for input in [
        json!({"kind":"setCustomFolder", "folderPath":outside}),
        json!({"kind":"setCustomFiles", "paths":[image]}),
    ] {
        let (status, _) = server
            .json(
                "POST",
                "/api/invoke/app__background_image_configure",
                json!({"input":input}),
            )
            .await;
        assert!(status.is_client_error());
        let (status, body) = server
            .json(
                "POST",
                "/api/invoke/app__crop_print_image",
                json!({"path":image}),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["message"]
                .as_str()
                .unwrap()
                .contains("File access denied"),
            "{body}"
        );
    }
    // Persisted or other upstream grants must not widen the Web boundary either.
    server
        .state
        .app
        .runtime_host()
        .register_host_file_access(&outside);
    let (_, body) = server
        .json(
            "POST",
            "/api/invoke/app__crop_print_image",
            json!({"path":image}),
        )
        .await;
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("File access denied"),
        "{body}"
    );

    let allowed = server.data.join("web-files/backgrounds");
    std::fs::create_dir(&allowed).unwrap();
    let allowed_image = allowed.join("image.png");
    std::fs::write(&allowed_image, b"synthetic image").unwrap();
    for input in [
        json!({"kind":"setCustomFolder", "folderPath":allowed}),
        json!({"kind":"setCustomFiles", "paths":[allowed_image]}),
    ] {
        assert_eq!(
            server
                .json(
                    "POST",
                    "/api/invoke/app__background_image_configure",
                    json!({"input":input})
                )
                .await
                .0,
            StatusCode::OK
        );
    }
    #[cfg(unix)]
    {
        let link = allowed.join("outside");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        for input in [
            json!({"kind":"setCustomFolder", "folderPath":link}),
            json!({"kind":"setCustomFiles", "paths":[link.join("private.png")]}),
            json!({"kind":"setCustomFiles", "paths":[allowed_image, image]}),
        ] {
            assert!(server
                .json(
                    "POST",
                    "/api/invoke/app__background_image_configure",
                    json!({"input":input})
                )
                .await
                .0
                .is_client_error());
        }
    }
    assert_eq!(std::fs::read(&image).unwrap(), b"synthetic image");
}

#[tokio::test(flavor = "multi_thread")]
async fn folders_create_browse_select_and_upload_without_overwriting() {
    let server = TestServer::new();
    let (status, created) = server
        .json(
            "POST",
            "/api/files/folders",
            json!({"parent":"", "name":"我的 备份"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let parent = server.data.join("web-files/我的 备份");
    assert_eq!(created["path"], parent.to_str().unwrap());
    assert_eq!(
        server
            .json(
                "POST",
                "/api/files/folders",
                json!({"parent":"我的 备份", "name":"nested"})
            )
            .await
            .0,
        StatusCode::OK
    );
    let (status, listing) = server
        .json("GET", "/api/files/folders?path=", Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listing["directories"],
        json!([{"name":"我的 备份", "path":"我的 备份"}])
    );
    let query: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("path", "")
        .append_pair("initialPath", parent.to_str().unwrap())
        .finish();
    let (_, listing) = server
        .json("GET", &format!("/api/files/folders?{query}"), Value::Null)
        .await;
    assert_eq!(listing["path"], "我的 备份");
    assert_eq!(listing["directories"][0]["name"], "nested");
    let (_, listing) = server
        .json(
            "GET",
            "/api/files/folders?path=&initialPath=/etc",
            Value::Null,
        )
        .await;
    assert_eq!(listing["path"], "");
    let (status, selected) = server
        .json(
            "POST",
            "/api/files/folders/select",
            json!({"path":"我的 备份/nested"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(selected["path"], parent.join("nested").to_str().unwrap());
    let restored = Files::new(&server.data).unwrap();
    assert_eq!(
        restored.directory("我的 备份/nested").unwrap(),
        parent.join("nested")
    );

    let (a, b) = tokio::join!(
        server.json(
            "POST",
            "/api/files/folders",
            json!({"parent":"", "name":"race"})
        ),
        server.json(
            "POST",
            "/api/files/folders",
            json!({"parent":"", "name":"race"})
        )
    );
    assert!([a.0, b.0].contains(&StatusCode::OK));
    assert!([a.0, b.0].contains(&StatusCode::CONFLICT));
    assert_eq!(
        server
            .upload(
                "parent=race&name=images",
                &[("sub/pic.txt", "image contents")]
            )
            .await
            .0,
        StatusCode::OK
    );
    let file = server.data.join("web-files/race/images/sub/pic.txt");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "image contents");
    assert_eq!(
        server
            .upload("parent=race&name=images", &[("sub/pic.txt", "replacement")])
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "image contents");
    assert_eq!(
        server
            .upload(
                "parent=race&name=broken",
                &[("ok.txt", "partial"), ("../escape.txt", "bad")]
            )
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert!(!server.data.join("web-files/race/broken").exists());
    assert!(!server.data.join("web-files/race/escape.txt").exists());
    assert_eq!(
        server.upload("parent=race&name=empty", &[]).await.0,
        StatusCode::BAD_REQUEST
    );
    assert!(!server.data.join("web-files/race/empty").exists());
    for query in ["", "parent=", "name=test"] {
        assert_eq!(
            server.upload(query, &[("file.txt", "test")]).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    // The removed directory-reservation interface must not silently accept old requests.
    assert_eq!(
        server
            .json(
                "POST",
                "/api/files/reserve",
                json!({"name":"folder", "directory":true})
            )
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn folder_boundaries_and_authentication_are_enforced() {
    let server = TestServer::new();
    for (method, url, body) in [
        ("GET", "/api/files/folders?path=", json!(null)),
        (
            "POST",
            "/api/files/folders",
            json!({"parent":"", "name":"test"}),
        ),
        ("POST", "/api/files/folders/select", json!({"path":"test"})),
    ] {
        assert_eq!(
            server
                .send(
                    method,
                    url,
                    "application/json",
                    body.to_string(),
                    TestAuth::MissingCookie
                )
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        if method == "POST" {
            assert_eq!(
                server
                    .send(
                        method,
                        url,
                        "application/json",
                        body.to_string(),
                        TestAuth::ForeignOrigin
                    )
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                server
                    .send(
                        method,
                        url,
                        "application/json",
                        body.to_string(),
                        TestAuth::MissingMarker
                    )
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
        }
    }
    for (auth, status) in [
        (TestAuth::MissingCookie, StatusCode::UNAUTHORIZED),
        (TestAuth::ForeignOrigin, StatusCode::FORBIDDEN),
        (TestAuth::MissingMarker, StatusCode::FORBIDDEN),
    ] {
        assert_eq!(
            server
                .send(
                    "POST",
                    "/api/files/directory?parent=&name=denied",
                    "multipart/form-data; boundary=test-boundary",
                    "--test-boundary--\r\n".into(),
                    auth
                )
                .await
                .0,
            status
        );
    }
    assert!(!server.data.join("web-files/denied").exists());
    assert_eq!(server.send("POST", "/api/files/directory?parent=&name=interrupted", "multipart/form-data; boundary=test-boundary", "--test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"partial.txt\"\r\n\r\npartial".into(), TestAuth::SignedIn).await.0, StatusCode::BAD_REQUEST);
    assert!(!server.data.join("web-files/interrupted").exists());
    for name in [
        "",
        " ",
        ".",
        "..",
        "../escape",
        "/absolute",
        "a/b",
        "a\\b",
        "a\nb",
        "a\0b",
    ] {
        assert_eq!(
            server
                .json(
                    "POST",
                    "/api/files/folders",
                    json!({"parent":"", "name":name})
                )
                .await
                .0,
            StatusCode::BAD_REQUEST,
            "{name:?}"
        );
    }
    assert_eq!(
        server
            .json(
                "POST",
                "/api/files/folders",
                json!({"name":"missing parent"})
            )
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for path in ["../", "/etc", "a/../b", "a\\b"] {
        assert!(server
            .json("POST", "/api/files/folders/select", json!({"path":path}))
            .await
            .0
            .is_client_error());
        assert!(server
            .json(
                "POST",
                "/api/files/folders",
                json!({"parent":path,"name":"escape"})
            )
            .await
            .0
            .is_client_error());
    }
    assert_eq!(
        server
            .json("POST", "/api/files/folders/select", json!({"path":""}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let root = &server.state.files.root;
    std::fs::write(root.join("file"), "keep").unwrap();
    assert_eq!(
        server
            .json(
                "POST",
                "/api/files/folders",
                json!({"parent":"", "name":"file"})
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        server
            .json("POST", "/api/files/folders/select", json!({"path":"file"}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    #[cfg(unix)]
    {
        std::fs::create_dir(root.join("inside")).unwrap();
        std::os::unix::fs::symlink(&server.data, root.join("outside-link")).unwrap();
        std::os::unix::fs::symlink(root.join("inside"), root.join("inside-link")).unwrap();
        for path in ["outside-link", "inside-link"] {
            assert_eq!(
                server
                    .json("POST", "/api/files/folders/select", json!({"path":path}))
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
            assert_eq!(
                server
                    .json(
                        "POST",
                        "/api/files/folders",
                        json!({"parent":path,"name":"escape"})
                    )
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
            assert_eq!(
                server
                    .upload(&format!("parent={path}&name=escape"), &[("file", "bad")])
                    .await
                    .0,
                StatusCode::NOT_FOUND
            );
        }
        let (_, listing) = server
            .json("GET", "/api/files/folders?path=", Value::Null)
            .await;
        assert_eq!(
            listing["directories"],
            json!([{"name":"inside","path":"inside"}])
        );
        assert!(!server.data.join("escape").exists());
    }
    let path = server
        .state
        .files
        .create_directory("", "pending", true)
        .unwrap();
    let pending = DirectoryUpload {
        files: &server.state.files,
        path: path.clone(),
        complete: false,
    };
    assert_eq!(
        server
            .json(
                "POST",
                "/api/files/folders/select",
                json!({"path":"pending"})
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        server
            .json(
                "POST",
                "/api/files/folders",
                json!({"parent":"pending", "name":"child"})
            )
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (_, listing) = server
        .json("GET", "/api/files/folders?path=", Value::Null)
        .await;
    assert!(!listing["directories"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["name"] == "pending"));
    drop(pending);
    assert!(!path.exists());
}
