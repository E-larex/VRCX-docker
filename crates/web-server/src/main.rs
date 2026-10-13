//! Standalone HTTP host. No Tauri application or display server is constructed.
#![allow(dead_code, unused_imports, unused_variables, non_snake_case)]
extern crate self as tauri;

use std::{ops::Deref, sync::Arc};

mod auth;
#[path = "../../../src-tauri/src/desktop_notification_activation.rs"]
mod desktop_notification_activation;
#[path = "../../../src-tauri/src/error.rs"]
mod error;
mod files;
mod server;
#[path = "../../../src-tauri/src/state.rs"]
mod state;

mod commands {
    include!(concat!(env!("OUT_DIR"), "/commands.rs"));
}

pub struct State<'a, T>(pub &'a T);
impl<T> Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}
impl<'a, T> State<'a, T> {
    pub fn inner(&self) -> &'a T {
        self.0
    }
}
pub mod async_runtime {
    pub use tokio::{spawn, task::spawn_blocking};
}

#[derive(Clone)]
pub struct AppHandle;
static RESTART: tokio::sync::Notify = tokio::sync::Notify::const_new();
impl AppHandle {
    pub fn request_restart(&self) {
        RESTART.notify_one();
    }
}

mod bootstrap {
    pub fn app_update_build_label() -> String {
        "web".into()
    }
    pub fn app_update_build_badge() -> String {
        "Web".into()
    }
    pub fn app_update_check_disabled() -> bool {
        true
    }
}

struct Executor;
struct Task(tokio::task::JoinHandle<()>);
impl vrcx_0_application_core::RuntimeTaskExecutor for Executor {
    fn spawn(
        &self,
        task: vrcx_0_application_core::RuntimeTask,
    ) -> Box<dyn vrcx_0_application_core::RuntimeTaskHandle> {
        Box::new(Task(tokio::spawn(task)))
    }
}
impl vrcx_0_application_core::RuntimeTaskHandle for Task {
    fn abort(&self) {
        self.0.abort();
    }
    fn is_finished(&self) -> bool {
        self.0.is_finished()
    }
    fn join_or_abort(&mut self, timeout: std::time::Duration) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            self.0.abort();
            return;
        };
        if handle.runtime_flavor() != tokio::runtime::RuntimeFlavor::MultiThread {
            self.0.abort();
            return;
        }
        tokio::task::block_in_place(|| {
            handle.block_on(async {
                if tokio::time::timeout(timeout, &mut self.0).await.is_err() {
                    self.0.abort();
                    let _ = tokio::time::timeout(std::time::Duration::from_millis(50), &mut self.0)
                        .await;
                }
            })
        });
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    server::run().await
}
