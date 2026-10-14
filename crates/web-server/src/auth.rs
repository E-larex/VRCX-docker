use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use vrcx_0_local_server::{generate_token, tokens_match};

const SESSION_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
pub const COOKIE: &str = "vrcx_web_session";

pub struct Auth {
    salt: String,
    password_hash: Option<[u8; 32]>,
    sessions: Mutex<HashMap<String, Instant>>,
    next_attempt: Mutex<Instant>,
    pub origin: String,
    pub secure: bool,
    lan_mode: bool,
    accepting_requests: AtomicBool,
}

impl Auth {
    pub fn new(password: &str, origin: &str) -> Result<Self, String> {
        Self::with_lan_mode(password, origin, false)
    }

    pub fn with_lan_mode(password: &str, origin: &str, lan_mode: bool) -> Result<Self, String> {
        if password.len() < 12 && !(lan_mode && password.is_empty()) {
            return Err("The website password must contain at least 12 characters".into());
        }
        // LAN mode accepts the private IP used by the browser, without a fixed domain.
        let parsed = url::Url::parse(if lan_mode { "http://localhost" } else { origin })
            .map_err(|e| e.to_string())?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("VRCX_WEB_ORIGIN must be the public HTTP(S) origin, without a path".into());
        }
        let salt = generate_token().map_err(|e| e.to_string())?;
        let mut password_hash = [0; 32];
        let password_hash = if password.is_empty() {
            None
        } else {
            argon2::Argon2::default()
                .hash_password_into(password.as_bytes(), salt.as_bytes(), &mut password_hash)
                .map_err(|e| e.to_string())?;
            Some(password_hash)
        };
        Ok(Self {
            salt,
            password_hash,
            sessions: Mutex::new(HashMap::new()),
            next_attempt: Mutex::new(Instant::now()),
            origin: parsed.origin().ascii_serialization(),
            secure: parsed.scheme() == "https",
            lan_mode,
            accepting_requests: AtomicBool::new(true),
        })
    }

    pub fn validate_request(&self, headers: &HeaderMap) -> bool {
        headers.get("x-vrcx-web").is_some_and(|h| h == "1")
            && headers
                .get("origin")
                .and_then(|h| h.to_str().ok())
                .is_some_and(|o| {
                    if self.lan_mode {
                        valid_lan_origin(o, headers)
                    } else {
                        o == self.origin
                    }
                })
    }

    pub fn password_required(&self) -> bool {
        self.password_hash.is_some()
    }

    pub fn login(&self, password: &str) -> Result<String, &'static str> {
        if !self.accepting_requests.load(Ordering::Acquire) {
            return Err("Website is shutting down");
        }
        let expected = self
            .password_hash
            .as_ref()
            .ok_or("Website password authentication is disabled")?;
        {
            let mut next = self.next_attempt.lock().unwrap();
            if Instant::now() < *next {
                return Err("Please wait before trying again");
            }
            *next = Instant::now() + Duration::from_secs(1);
        }
        if password.len() > 1024 {
            return Err("Invalid password");
        }
        let mut hash = [0; 32];
        argon2::Argon2::default()
            .hash_password_into(password.as_bytes(), self.salt.as_bytes(), &mut hash)
            .map_err(|_| "Invalid password")?;
        if !tokens_match(&hex_digest(&hash), &hex_digest(expected)) {
            return Err("Invalid password");
        }
        let token = generate_token().map_err(|_| "Unable to create session")?;
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, expiry| *expiry > Instant::now());
        if sessions.len() >= 32 {
            return Err("Too many website sessions; log out on another device");
        }
        sessions.insert(hex_digest(token.as_bytes()), Instant::now() + SESSION_AGE);
        Ok(token)
    }

    pub fn authenticated(&self, headers: &HeaderMap) -> bool {
        if !self.accepting_requests.load(Ordering::Acquire) {
            return false;
        }
        if self.password_required() {
            cookie(headers).is_some_and(|token| self.valid_token(token))
        } else {
            // Without a cookie gate, validate LAN authority on reads as well as writes.
            let Some(host) = headers.get("host").and_then(|h| h.to_str().ok()) else {
                return false;
            };
            let Ok(url) = url::Url::parse(&format!("http://{host}")) else {
                return false;
            };
            valid_lan_origin(&url.origin().ascii_serialization(), headers)
                && headers.get("origin").is_none_or(|origin| {
                    origin
                        .to_str()
                        .is_ok_and(|origin| valid_lan_origin(origin, headers))
                })
                && headers
                    .get("sec-fetch-site")
                    .is_none_or(|site| site == "same-origin" || site == "none")
        }
    }
    pub fn valid_token(&self, token: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(&hex_digest(token.as_bytes()))
            .is_some_and(|expiry| *expiry > Instant::now())
    }
    pub fn logout(&self, headers: &HeaderMap) {
        if let Some(token) = cookie(headers) {
            self.sessions
                .lock()
                .unwrap()
                .remove(&hex_digest(token.as_bytes()));
        }
    }
    pub fn shutdown(&self) {
        // Cookie-free SSE connections must terminate during graceful shutdown too.
        self.accepting_requests.store(false, Ordering::Release);
        self.sessions.lock().unwrap().clear();
    }
    pub fn cookie_header(&self, token: &str) -> String {
        format!(
            "{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{}",
            if token.is_empty() {
                0
            } else {
                SESSION_AGE.as_secs()
            },
            if self.secure { "; Secure" } else { "" }
        )
    }
}

fn valid_lan_origin(origin: &str, headers: &HeaderMap) -> bool {
    let Ok(parsed) = url::Url::parse(origin) else {
        return false;
    };
    if parsed.scheme() != "http" || parsed.origin().ascii_serialization() != origin {
        return false;
    }
    let private_host = match parsed.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        Some(url::Host::Ipv6(ip)) => {
            ip.is_unique_local() || ip.is_loopback() || ip.is_unicast_link_local()
        }
        Some(url::Host::Domain("localhost")) => true,
        _ => false,
    };
    let Some(host) = headers.get("host").and_then(|h| h.to_str().ok()) else {
        return false;
    };
    // Compare the browser's Origin with the actual HTTP authority, not proxy headers.
    private_host
        && (origin == format!("http://{host}")
            || (parsed.port().is_none()
                && origin == format!("http://{}", host.strip_suffix(":80").unwrap_or(host))))
}

pub fn cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|entry| {
            let (name, value) = entry.trim().split_once('=')?;
            (name == COOKIE).then_some(value)
        })
}
fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_lan_mode_allows_an_empty_password() {
        assert!(Auth::new("", "http://localhost:8080").is_err());
        assert!(Auth::new("", "https://vrcx.example.com").is_err());
        assert!(Auth::with_lan_mode("short", "", true).is_err());
        let auth = Auth::with_lan_mode("", "", true).unwrap();
        assert!(!auth.password_required());
        assert!(!auth.authenticated(&HeaderMap::new()));
        assert!(auth.login("").is_err());
        assert!(auth.sessions.lock().unwrap().is_empty());
        assert!(Auth::with_lan_mode("correct-test-password", "", true)
            .unwrap()
            .password_required());
    }

    #[test]
    fn passwordless_lan_reads_need_a_local_host_and_matching_origin() {
        let auth = Auth::with_lan_mode("", "https://unused.example", true).unwrap();
        for host in [
            "localhost:8080",
            "127.0.0.1:80",
            "192.168.1.10:80",
            "10.0.0.2:8080",
            "172.16.0.2",
            "169.254.0.2",
            "[fd00::1]:8080",
            "[fe80::1]:8080",
            "[::1]:80",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("host", host.parse().unwrap());
            assert!(auth.authenticated(&headers), "{host}");
            let origin = url::Url::parse(&format!("http://{host}"))
                .unwrap()
                .origin()
                .ascii_serialization();
            headers.insert("origin", origin.parse().unwrap());
            headers.insert("sec-fetch-site", "same-origin".parse().unwrap());
            assert!(auth.authenticated(&headers), "{host}");
            headers.insert("x-vrcx-web", "1".parse().unwrap());
            assert!(auth.validate_request(&headers), "{host}");
            auth.logout(&headers);
            assert!(auth.authenticated(&headers));
            headers.insert("origin", "http://192.168.1.20:8080".parse().unwrap());
            assert!(!auth.authenticated(&headers));
            headers.remove("origin");
            headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
            assert!(!auth.authenticated(&headers));
        }
        for host in [
            "8.8.8.8:8080",
            "[2001:4860::8888]:8080",
            "attacker.example:8080",
            "localhost.attacker.example",
            "localhost/path",
            "user@localhost",
            "localhost:8080#fragment",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("host", host.parse().unwrap());
            assert!(!auth.authenticated(&headers), "{host}");
        }
    }

    #[test]
    fn shutdown_revokes_password_and_passwordless_access() {
        for password in ["", "correct-test-password"] {
            let auth = Auth::with_lan_mode(password, "", true).unwrap();
            let mut headers = HeaderMap::new();
            headers.insert("host", "localhost:8080".parse().unwrap());
            if auth.password_required() {
                let token = auth.login(password).unwrap();
                headers.insert("cookie", format!("{COOKIE}={token}").parse().unwrap());
            }
            assert!(auth.authenticated(&headers));
            auth.shutdown();
            assert!(!auth.authenticated(&headers));
            assert!(auth.login(password).is_err());
        }
    }

    #[test]
    fn session_is_required_and_logout_revokes_it() {
        let auth = Auth::new("correct-test-password", "https://vrcx.example.com").unwrap();
        let token = auth.login("correct-test-password").unwrap();
        let mut headers = HeaderMap::new();
        assert!(!auth.authenticated(&headers));
        headers.insert("cookie", format!("{COOKIE}={token}").parse().unwrap());
        assert!(auth.authenticated(&headers));
        auth.logout(&headers);
        assert!(!auth.authenticated(&headers));
        assert!(auth.cookie_header(&token).contains("Secure"));
    }
    #[test]
    fn rejects_cross_origin_and_simple_requests() {
        let auth = Auth::new("correct-test-password", "https://vrcx.example.com").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("origin", "https://vrcx.example.com".parse().unwrap());
        assert!(!auth.validate_request(&headers));
        headers.insert("x-vrcx-web", "1".parse().unwrap());
        assert!(auth.validate_request(&headers));
        headers.insert("origin", "https://another.example.com".parse().unwrap());
        assert!(!auth.validate_request(&headers));
        assert!(auth.login("incorrect-password").is_err());
    }

    #[test]
    fn lan_mode_accepts_private_http_origins_without_a_configured_domain() {
        let auth = Auth::with_lan_mode("correct-test-password", "", true).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-vrcx-web", "1".parse().unwrap());
        for authority in [
            "192.168.1.10:8080",
            "10.0.0.2",
            "172.16.0.2:9000",
            "[fd00::1]:8080",
            "[::1]:8080",
            "localhost:8080",
        ] {
            headers.insert("host", authority.parse().unwrap());
            headers.insert("origin", format!("http://{authority}").parse().unwrap());
            assert!(auth.validate_request(&headers), "{authority}");
            assert!(!auth.authenticated(&headers));
        }
        headers.insert("host", "192.168.1.10:80".parse().unwrap());
        headers.insert("origin", "http://192.168.1.10".parse().unwrap());
        assert!(auth.validate_request(&headers));
        let token = auth.login("correct-test-password").unwrap();
        headers.insert("cookie", format!("{COOKIE}={token}").parse().unwrap());
        assert!(auth.authenticated(&headers));
        assert!(!auth.cookie_header(&token).contains("; Secure"));
        // Flipping the switch works even if the old HTTPS origin remains in .env.
        let switched =
            Auth::with_lan_mode("correct-test-password", "https://vrcx.example.com", true).unwrap();
        assert!(switched.validate_request(&headers));
    }

    #[test]
    fn lan_mode_preserves_origin_checks_and_rejects_public_hosts() {
        let auth = Auth::with_lan_mode("correct-test-password", "", true).unwrap();
        for (host, origin) in [
            ("192.168.1.10:8080", "http://192.168.1.11:8080"),
            ("192.168.1.10:8080", "http://192.168.1.10:8081"),
            ("192.168.1.10:8080", "https://192.168.1.10:8080"),
            ("192.168.1.10:8080", "null"),
            ("attacker.example:8080", "http://attacker.example:8080"),
            ("8.8.8.8:8080", "http://8.8.8.8:8080"),
            ("[2001:4860::8888]:8080", "http://[2001:4860::8888]:8080"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("x-vrcx-web", "1".parse().unwrap());
            headers.insert("host", host.parse().unwrap());
            headers.insert("origin", origin.parse().unwrap());
            assert!(!auth.validate_request(&headers), "{origin}");
        }
        let mut headers = HeaderMap::new();
        headers.insert("host", "192.168.1.10:8080".parse().unwrap());
        headers.insert("origin", "http://192.168.1.10:8080".parse().unwrap());
        assert!(!auth.validate_request(&headers));
        headers.insert("x-vrcx-web", "1".parse().unwrap());
        headers.remove("host");
        assert!(!auth.validate_request(&headers));
        let original = Auth::new("correct-test-password", "https://vrcx.example.com").unwrap();
        headers.insert("host", "192.168.1.10:8080".parse().unwrap());
        assert!(!original.validate_request(&headers));
        assert!(original.cookie_header("token").contains("; Secure"));
    }
}
