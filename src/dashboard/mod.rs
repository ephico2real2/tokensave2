//! `tokensave dashboard`: a local web page of the tokens AI coding agents
//! spent and the tokens tokensave saved, served from `global.db` (inkcast
//! #227, S3).
//!
//! - **One per machine:** a lock in tokensave's data folder ([`instance`]),
//!   plus a port check: a second `start` reports the running one, and a port
//!   another program holds is refused with its number named.
//! - **Local only:** the server binds a loopback address; any other `bind`
//!   is refused at start-up ([`config`]).
//! - **Read only API:** every query runs on a read-only connection to
//!   `global.db` ([`api::open_read_only`]); no request writes it.
//! - **Fresh figures:** one background task runs the same ingest as
//!   `tokensave cost`, every `refresh_seconds`, on a connection of its own
//!   ([`refresh_loop`]). It stops with the server. The page asks again at the
//!   same interval. Cursor's sync stays a command: it calls Cursor's servers.
//! - **API:** the endpoints of the mockup's datasets ([`api`]), their
//!   parameters checked by [`params`].
//! - **Page:** the files under `dashboard/dist/`, embedded at compile time
//!   ([`assets`]) and served by [`http`].

pub mod api;
pub mod assets;
pub mod config;
pub mod http;
pub mod instance;
pub mod params;
mod sql;

use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use config::DashboardConfig;
use instance::{Instance, State};

/// How long `start` waits for a server started in the background.
const START_TIMEOUT: Duration = Duration::from_secs(10);
/// How long `stop` waits for the server to end.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// A dashboard command that could not do what it was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardError(pub String);

impl std::fmt::Display for DashboardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DashboardError {}

impl From<config::ConfigError> for DashboardError {
    fn from(error: config::ConfigError) -> Self {
        Self(error.0)
    }
}

/// tokensave's data folder (`TOKENSAVE_HOME`, else `~/.tokensave`).
pub fn data_home() -> Result<PathBuf, DashboardError> {
    crate::data_home::tokensave_home(crate::agents::home_dir())
        .ok_or_else(|| DashboardError("cannot find the home folder".to_string()))
}

/// What `start` found or did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Started {
    /// This call started it.
    Now(Instance),
    /// It was running already.
    Already(Instance),
}

/// Refuses a port another program answers on. Binding alone does not tell:
/// with `SO_REUSEADDR`, macOS lets a loopback bind share a port that another
/// program holds on every address.
fn check_port_free(bind: IpAddr, port: u16) -> Result<(), DashboardError> {
    let address = SocketAddr::new(bind, port);
    if TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok() {
        return Err(port_busy(bind, port));
    }
    Ok(())
}

fn port_busy(bind: IpAddr, port: u16) -> DashboardError {
    DashboardError(format!(
        "port {port} on {bind} is in use by another program; choose another with \
         --port or `port` in dashboard.toml"
    ))
}

/// Runs the server in this process until it is asked to stop (Ctrl-C,
/// `SIGTERM`, `tokensave dashboard stop`). Returns the running dashboard
/// instead when one holds the lock. `announce` is told the address once the
/// server listens.
pub async fn run_foreground(
    home: &Path,
    config: &DashboardConfig,
    announce: impl FnOnce(&Instance),
) -> Result<Option<Instance>, DashboardError> {
    let io = |error: std::io::Error| DashboardError(format!("{}: {error}", home.display()));
    let claim = match instance::claim(home).map_err(io)? {
        Ok(claim) => claim,
        Err(State::Running(running)) => return Ok(Some(running)),
        Err(_) => match instance::wait_for(home, START_TIMEOUT, |s| matches!(s, State::Running(_)))
        {
            State::Running(running) => return Ok(Some(running)),
            _ => {
                return Err(DashboardError(
                    "another dashboard holds the lock but did not start".to_string(),
                ))
            }
        },
    };
    check_port_free(config.bind, config.port)?;
    let listener = tokio::net::TcpListener::bind((config.bind, config.port))
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AddrInUse => port_busy(config.bind, config.port),
            _ => DashboardError(format!(
                "cannot listen on {}:{}: {error}",
                config.bind, config.port
            )),
        })?;
    let port = listener.local_addr().map_err(io)?.port();
    let running = Instance {
        pid: std::process::id(),
        bind: config.bind.to_string(),
        port,
        started_at: now(),
    };
    claim.record(&running).map_err(io)?;
    announce(&running);

    if config.refresh_seconds > 0 {
        if let (Some(user_home), Some(codex)) = (crate::agents::home_dir(), codex_home()) {
            tokio::spawn(refresh_loop(
                home.join("global.db"),
                user_home,
                codex,
                Duration::from_secs(u64::from(config.refresh_seconds)),
            ));
        }
    }

    let server = Arc::new(http::Server::new(
        api::Context {
            db_path: home.join("global.db"),
            bind: config.bind,
            port,
            default_range_days: config.default_range_days,
            refresh_seconds: config.refresh_seconds,
            page_version: assets::version(assets::ASSETS),
            home: crate::agents::home_dir(),
            codex_home: codex_home(),
            now,
        },
        assets::ASSETS,
    ));
    http::serve(listener, server, shutdown_signal()).await;
    drop(claim);
    Ok(None)
}

/// The current unix time, in seconds.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

/// Reads new agent logs into `global.db` now and every `every`, until the
/// server ends. A failed open is logged once and tried again at the next tick:
/// a hook or a `tokensave cost` can hold the database for a moment.
async fn refresh_loop(db_path: PathBuf, home: PathBuf, codex_home: PathBuf, every: Duration) {
    let mut ticker = tokio::time::interval(every);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut failing = false;
    loop {
        ticker.tick().await;
        let opened = refresh_once(&db_path, &home, &codex_home).await;
        if !opened && !failing {
            eprintln!(
                "refresh: cannot open {}; trying again at the next tick",
                db_path.display()
            );
        }
        failing = !opened;
    }
}

/// One ingest into the database at `db_path`. False when it would not open.
async fn refresh_once(db_path: &Path, home: &Path, codex_home: &Path) -> bool {
    let Some(db) = crate::global_db::GlobalDb::open_at(db_path).await else {
        return false;
    };
    crate::accounting::parser::ingest_sources(&db, home, codex_home).await;
    true
}

/// Codex's data folder, as the ingest finds it.
fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::agents::home_dir().map(|home| home.join(".codex")))
}

/// Completes on Ctrl-C, and on `SIGTERM` where there are signals.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = terminate.recv() => {}
                    _ = tokio::signal::ctrl_c() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Starts the server in the background, as a process of its own that
/// outlives this one, or reports the one already running.
pub fn start_background(home: &Path, config: &DashboardConfig) -> Result<Started, DashboardError> {
    match instance::state(home) {
        State::Running(running) => return Ok(Started::Already(running)),
        State::Starting => {
            if let State::Running(running) =
                instance::wait_for(home, START_TIMEOUT, |s| matches!(s, State::Running(_)))
            {
                return Ok(Started::Already(running));
            }
        }
        State::Stopped => {}
    }
    check_port_free(config.bind, config.port)?;

    let io = |error: std::io::Error| DashboardError(format!("cannot start the dashboard: {error}"));
    std::fs::create_dir_all(home).map_err(io)?;
    let log_path = home.join(instance::LOG_FILE);
    let log = std::fs::File::create(&log_path).map_err(io)?;
    let exe = std::env::current_exe().map_err(io)?;
    let mut command = Command::new(exe);
    command
        .args(["dashboard", "start", "--foreground", "--port"])
        .arg(config.port.to_string())
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(io)?)
        .stderr(log);
    detach(&mut command);
    #[cfg(windows)]
    keep_own_handles();
    let mut child = command.spawn().map_err(io)?;
    let pid = child.id();

    let started = instance::wait_for(home, START_TIMEOUT, |s| match s {
        State::Running(running) => running.pid == pid,
        _ => false,
    });
    match started {
        State::Running(running) if running.pid == pid => Ok(Started::Now(running)),
        // Another `start` won the race; this child reported it and exited.
        State::Running(running) => Ok(Started::Already(running)),
        _ => {
            let exited = child.try_wait().ok().flatten().is_some();
            if !exited {
                let _ = child.kill();
            }
            let output = std::fs::read_to_string(&log_path).unwrap_or_default();
            let output = output.trim();
            Err(DashboardError(if output.is_empty() {
                format!(
                    "the dashboard did not start within {} s",
                    START_TIMEOUT.as_secs()
                )
            } else {
                output.trim_start_matches("Error: ").to_string()
            }))
        }
    }
}

/// Puts a background server in a process group of its own (Unix) or
/// detaches it from the console (Windows), so the terminal's Ctrl-C does not
/// reach it.
fn detach(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        command.creation_flags(0x0000_0008 | 0x0000_0200);
    }
}

/// Keeps this process's standard handles from passing to the server.
///
/// Windows gives a child every inheritable handle its parent holds (std's
/// `Command` spawns with `bInheritHandles`), so the server would hold the
/// pipes of whoever captured `start`'s output for its whole life, and that
/// reader would never see their end (rust-lang/rust#54760; nextest clears the
/// same flag for its tests). `start` exits once the server runs, so its own
/// handles need not be inheritable.
#[cfg(windows)]
fn keep_own_handles() {
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: GetStdHandle takes no pointer and returns this process's
        // handle, null or INVALID_HANDLE_VALUE; SetHandleInformation changes
        // only the inherit flag of a valid handle this process owns.
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// Stops the running dashboard and waits for it to end. `Ok(None)` when
/// none was running.
pub fn stop(home: &Path) -> Result<Option<Instance>, DashboardError> {
    let running = match instance::state(home) {
        State::Stopped => return Ok(None),
        State::Running(running) => running,
        State::Starting => {
            match instance::wait_for(home, START_TIMEOUT, |s| !matches!(s, State::Starting)) {
                State::Running(running) => running,
                _ => return Ok(None),
            }
        }
    };
    if !instance::terminate(running.pid) {
        return Err(DashboardError(format!(
            "could not signal the dashboard (PID {})",
            running.pid
        )));
    }
    match instance::wait_for(home, STOP_TIMEOUT, |s| *s == State::Stopped) {
        State::Stopped => Ok(Some(running)),
        _ => Err(DashboardError(format!(
            "the dashboard (PID {}) did not stop within {} s",
            running.pid,
            STOP_TIMEOUT.as_secs()
        ))),
    }
}

/// Opens `url` in the default browser.
pub fn open_in_browser(url: &str) -> Result<(), DashboardError> {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(url);
        command
    } else if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    match command.stdin(Stdio::null()).status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(DashboardError(format!(
            "could not open {url}: the opener exited with {status}"
        ))),
        Err(error) => Err(DashboardError(format!("could not open {url}: {error}"))),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_port_that_answers_is_busy_and_names_its_number() {
        let holder = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = holder.local_addr().unwrap().port();
        let loopback = IpAddr::from([127, 0, 0, 1]);
        let error = check_port_free(loopback, port).unwrap_err();
        assert!(
            error
                .0
                .starts_with(&format!("port {port} on 127.0.0.1 is in use")),
            "{error}"
        );
        drop(holder);
        assert!(check_port_free(loopback, port).is_ok());
    }

    fn codex_log(lines: &[&str]) -> String {
        let mut text = lines.join("\n");
        text.push('\n');
        text
    }

    async fn turns_in(db_path: &Path) -> i64 {
        let Ok(db) = api::open_read_only(db_path).await else {
            return 0;
        };
        let mut rows = db
            .connection()
            .query("SELECT COUNT(*) FROM turns", ())
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
    }

    /// The server's own refresh finds a new agent turn with no command run,
    /// and a later tick finds what the log gained since.
    #[tokio::test]
    async fn the_refresh_loop_reads_new_turns_at_each_tick() {
        const META: &str = r#"{"timestamp":"2026-10-20T10:00:00.000Z","type":"session_meta","payload":{"id":"T1","session_id":"T1","cwd":"/work/r","source":"exec"}}"#;
        const CONTEXT: &str = r#"{"timestamp":"2026-10-20T10:00:01.000Z","type":"turn_context","payload":{"cwd":"/work/r","model":"claude-opus-4-6","effort":"high"}}"#;
        const FIRST: &str = r#"{"timestamp":"2026-10-20T10:00:02.000Z","type":"token_usage_record","payload":{"response_id":"r1","session_id":"T1","thread_id":"T1","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":110}}}"#;
        const NEXT: &str = r#"{"timestamp":"2026-10-20T10:00:03.000Z","type":"token_usage_record","payload":{"response_id":"r1-next","session_id":"T1","thread_id":"T1","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":110}}}"#;

        let home = tempfile::TempDir::new().unwrap();
        let sessions = home.path().join(".codex").join("sessions").join("2026");
        std::fs::create_dir_all(&sessions).unwrap();
        let log = sessions.join("rollout-a.jsonl");
        std::fs::write(&log, codex_log(&[META, CONTEXT, FIRST])).unwrap();
        let data = tempfile::TempDir::new().unwrap();
        let db_path = data.path().join("global.db");

        let task = tokio::spawn(refresh_loop(
            db_path.clone(),
            home.path().to_path_buf(),
            home.path().join(".codex"),
            Duration::from_millis(50),
        ));
        let reach = |wanted: i64| {
            let db_path = db_path.clone();
            async move {
                for _ in 0..200 {
                    if db_path.exists() && turns_in(&db_path).await == wanted {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                false
            }
        };
        assert!(reach(1).await, "the first tick reads the log");
        std::fs::write(&log, codex_log(&[META, CONTEXT, FIRST, NEXT])).unwrap();
        assert!(reach(2).await, "a later tick reads what the log gained");
        task.abort();
    }

    #[tokio::test]
    async fn a_database_that_will_not_open_is_reported_and_not_fatal() {
        let home = tempfile::TempDir::new().unwrap();
        // A file where the data folder should be.
        let blocked = home.path().join("file");
        std::fs::write(&blocked, "").unwrap();
        assert!(!refresh_once(&blocked.join("global.db"), home.path(), home.path()).await);
    }
}
