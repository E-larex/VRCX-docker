//! Compile the existing, explicitly selected command modules into the web host.
//! Only transport annotations are removed; command bodies and wire types stay upstream-owned.
use heck::ToLowerCamelCase;
use quote::{format_ident, quote};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};
use syn::{FnArg, Item, Pat, ReturnType, Type};

fn main() {
    let source =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../src-tauri/src/commands");
    let mut routes = Vec::new();
    let mut manifest = BTreeMap::new();
    let modules = module(&source.join("mod.rs"), &[], &mut routes, &mut manifest);
    check_command_manifest(&manifest);
    let output = quote! {
        #modules
        pub async fn dispatch(state: std::sync::Arc<crate::state::AppState>, command: &str, args: serde_json::Value) -> Result<serde_json::Value, crate::error::AppError> {
            match command {
                #(#routes)*
                _ => Err(crate::error::AppError::Custom(format!("Command is unavailable in the web host: {command}"))),
            }
        }
    };
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("commands.rs"),
        output.to_string(),
    )
    .unwrap();
}

fn check_command_manifest(actual: &BTreeMap<String, String>) {
    let manifest_path =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("commands.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!("cargo:rerun-if-env-changed=VRCX_WEB_UPDATE_COMMAND_MANIFEST");
    if env::var("VRCX_WEB_UPDATE_COMMAND_MANIFEST").as_deref() == Ok("1") {
        fs::write(
            &manifest_path,
            format!("{}\n", serde_json::to_string_pretty(actual).unwrap()),
        )
        .unwrap();
        return;
    }
    let approved: BTreeMap<String, String> = serde_json::from_str(
        &fs::read_to_string(&manifest_path).expect("Missing reviewed Web command manifest"),
    )
    .expect("Invalid reviewed Web command manifest");
    let mut changes = Vec::new();
    for (name, signature) in actual {
        match approved.get(name) {
            None => changes.push(format!("added: {name}")),
            Some(previous) if previous != signature => changes.push(format!("changed: {name}")),
            _ => {}
        }
    }
    for name in approved.keys() {
        if !actual.contains_key(name) {
            changes.push(format!("removed: {name}"));
        }
    }
    assert!(changes.is_empty(), "Web command manifest requires review:\n{}\nReview desktop dependencies and file access, then run VRCX_WEB_UPDATE_COMMAND_MANIFEST=1 cargo check --locked -p vrcx-0-web and commit commands.json. See DEVELOPMENT.md.", changes.join("\n"));
}

fn selected(path: &[String]) -> bool {
    let key = path.join("/");
    if path.len() <= 1 {
        return !matches!(key.as_str(), "asset_bundle" | "log_watcher");
    }
    match path[0].as_str() {
        "vrchat" => true,
        "local" => !matches!(path[1].as_str(), "game_log"),
        "application" => !matches!(
            path[1].as_str(),
            "background_mode"
                | "deep_link"
                | "desktop_notification"
                | "desktop_widget"
                | "privacy_lock"
                | "registry_backup"
                | "vr_overlay"
        ),
        "host" => matches!(
            path[1].as_str(),
            "error_log"
                | "fonts"
                | "legacy_migration"
                | "startup_bootstrap"
                | "paths"
                | "host_capabilities"
                | "overlay_notifications"
                | "media"
        ),
        _ => true,
    }
}

fn module(
    file: &Path,
    path: &[String],
    routes: &mut Vec<proc_macro2::TokenStream>,
    manifest: &mut BTreeMap<String, String>,
) -> proc_macro2::TokenStream {
    println!("cargo:rerun-if-changed={}", file.display());
    let source = fs::read_to_string(file).unwrap();
    let source = source
        .replace("#[tauri::command(async)]", "#[web_command]")
        .replace("#[tauri::command]", "#[web_command]")
        .replace("#[specta::specta]", "");
    let parsed = syn::parse_file(&source).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
    let mut items = Vec::new();
    for mut item in parsed.items {
        if let Item::Mod(m) = &mut item {
            if m.ident == "tests" {
                continue;
            }
            if m.content.is_none() {
                let mut child = path.to_vec();
                child.push(m.ident.to_string());
                if !selected(&child) {
                    continue;
                }
                let base = if file.file_name().unwrap() == "mod.rs" {
                    file.parent().unwrap().to_path_buf()
                } else {
                    file.with_extension("")
                };
                let flat = base.join(format!("{}.rs", m.ident));
                let child_file = if flat.exists() {
                    flat
                } else {
                    base.join(m.ident.to_string()).join("mod.rs")
                };
                let body = module(&child_file, &child, routes, manifest);
                let name = &m.ident;
                items.push(quote! { pub mod #name { #body } });
                continue;
            }
        }
        if let Item::Fn(f) = &mut item {
            if f.sig.ident == "app__save_image_file" {
                continue;
            }
            let command = f.attrs.iter().any(|a| a.path().is_ident("web_command"));
            f.attrs.retain(|a| !a.path().is_ident("web_command"));
            if command {
                let name = f.sig.ident.clone();
                let signature = &f.sig;
                let description = format!("{}: {}", path.join("/"), quote!(#signature));
                assert!(
                    manifest.insert(name.to_string(), description).is_none(),
                    "Duplicate Web command: {name}"
                );
                let wrapper = format_ident!("web_{}", name);
                let mut fields = Vec::new();
                let mut arguments = Vec::new();
                for input in &f.sig.inputs {
                    let FnArg::Typed(arg) = input else {
                        panic!("unsupported command receiver")
                    };
                    let Pat::Ident(pat) = arg.pat.as_ref() else {
                        panic!("unsupported command argument")
                    };
                    let ident = &pat.ident;
                    let Type::Path(ty_path) = arg.ty.as_ref() else {
                        panic!("unsupported command type")
                    };
                    let last = &ty_path.path.segments.last().unwrap().ident;
                    if last == "State" {
                        arguments.push(quote!(crate::State(&state)));
                    } else if last == "AppHandle" {
                        arguments.push(quote!(crate::AppHandle));
                    } else {
                        let ty = &arg.ty;
                        let wire = ident.to_string().to_lower_camel_case();
                        fields.push(quote! { #[serde(rename = #wire)] #ident: #ty });
                        arguments.push(quote!(input.#ident));
                    }
                }
                let call = if f.sig.asyncness.is_some() {
                    quote!(#name(#(#arguments),*).await)
                } else {
                    quote!(#name(#(#arguments),*))
                };
                let fallible = matches!(&f.sig.output, ReturnType::Type(_, ty) if matches!(ty.as_ref(), Type::Path(p) if p.path.segments.last().unwrap().ident == "Result"));
                let value = if fallible { quote!(#call?) } else { call };
                let body = quote! {
                    #[derive(serde::Deserialize)] struct Input { #(#fields),* }
                    let input: Input = serde_json::from_value(args)?;
                    let _ = &input;
                    Ok(serde_json::to_value(#value)?)
                };
                let body = if f.sig.asyncness.is_some() {
                    body
                } else {
                    quote! { tokio::task::spawn_blocking(move || { #body }).await.map_err(|e| crate::error::AppError::Custom(e.to_string()))? }
                };
                items.push(quote! {
                    pub async fn #wrapper(state: std::sync::Arc<crate::state::AppState>, args: serde_json::Value) -> Result<serde_json::Value, crate::error::AppError> { #body }
                });
                let parts: Vec<_> = path.iter().map(|p| format_ident!("{p}")).collect();
                let wire = name.to_string();
                routes.push(quote! { #wire => #(#parts::)* #wrapper(state, args).await, });
            }
        }
        // Inner module attributes aren't needed in generated modules.
        items.push(quote!(#item));
    }
    // Lifecycle callbacks request a controlled server restart, never a desktop window.
    if path == ["host"] {
        items.push(
            quote! { pub mod window { pub fn stop_runtime_services(_: &crate::AppHandle) {} } },
        );
    }
    quote! { #(#items)* }
}
