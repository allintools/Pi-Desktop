#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use base64::Engine;
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};
use uuid::Uuid;

mod ownership;
mod protocol;
type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Target {
    kind: String,
    distro: Option<String>,
    user: Option<String>,
    node: Option<String>,
    pi: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    path: String,
    target: Target,
    trusted: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    project_id: String,
    name: String,
    cwd: String,
    file: String,
    mode: String,
    worktree: bool,
    branch: String,
    pinned: bool,
    archived: bool,
    updated: u64,
    #[serde(default)]
    runtime_state: String,
}
struct Process {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    busy: AtomicBool,
    target: Target,
    mode: String,
    pid_file: Option<String>,
    session_file: Mutex<Option<String>>,
    environment: Mutex<String>,
}
struct Terminal {
    target: Target,
    pid_file: Option<String>,
    session_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn PtyChild + Send + Sync>,
}
struct Backend {
    ownership: ownership::Job,
    start_lock: Mutex<()>,
    db: Mutex<Connection>,
    processes: Mutex<HashMap<String, Arc<Process>>>,
    queue: Mutex<VecDeque<(String, Value)>>,
    terminals: Mutex<HashMap<String, Terminal>>,
    jobs: Mutex<HashMap<String, Arc<Process>>>,
    helper: PathBuf,
    exiting: AtomicBool,
    events: Mutex<EventQueue>,
}
#[derive(Default)]
struct EventQueue {
    records: Vec<Value>,
    sequences: HashMap<String, u64>,
}
fn register_owned(b: &Backend, file: &str, t: &Target) -> Result<()> {
    b.db.lock()
        .unwrap()
        .execute(
            "INSERT OR REPLACE INTO owned_wsl(file,target) VALUES(?,?)",
            params![file, serde_json::to_string(t).unwrap()],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn unregister_owned(b: &Backend, file: &str) {
    let _ =
        b.db.lock()
            .unwrap()
            .execute("DELETE FROM owned_wsl WHERE file=?", [file]);
}
fn cleanup_owned(b: &Backend) {
    let items: Vec<(String, String)> = {
        let db = b.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT file,target FROM owned_wsl").unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    };
    for (file, json) in items {
        if let Ok(target) = serde_json::from_str(&json) {
            kill_wsl_group(&target, &Some(file.clone()));
        }
        unregister_owned(b, &file);
    }
}
fn record_run(app: &tauri::AppHandle, id: &str, status: &str) {
    let b = app.state::<Backend>();
    if let Ok(mut s) = session(&b, id) {
        s.runtime_state = status.into();
        s.updated = now();
        let _ = save_session(&b, &s);
    }
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn hidden(cmd: &mut Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
}
fn validate_target(t: &Target) -> Result<()> {
    if t.kind != "windows" && t.kind != "wsl" {
        return Err("无效执行环境".into());
    }
    if t.kind == "wsl"
        && (t.distro.as_deref().unwrap_or("").is_empty()
            || t.user
                .as_deref()
                .is_some_and(|s| s.starts_with('-') || s.contains('\0')))
    {
        return Err("请选择发行版和有效用户".into());
    }
    Ok(())
}
fn project(b: &Backend, id: &str) -> Result<Project> {
    let db = b.db.lock().unwrap();
    let text: String = db
        .query_row("SELECT data FROM projects WHERE id=?", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
fn session(b: &Backend, id: &str) -> Result<Session> {
    let db = b.db.lock().unwrap();
    let text: String = db
        .query_row("SELECT data FROM sessions WHERE id=?", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
fn save_session(b: &Backend, s: &Session) -> Result<()> {
    b.db.lock().unwrap().execute("INSERT INTO sessions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![s.id,serde_json::to_string(s).unwrap()]).map_err(|e|e.to_string())?;
    Ok(())
}
fn helper_source(b: &Backend, t: &Target, input: &mut ChildStdin) -> Result<()> {
    if t.kind == "wsl" {
        let source = base64::engine::general_purpose::STANDARD
            .encode(std::fs::read(&b.helper).map_err(|e| e.to_string())?);
        writeln!(input, "{source}").map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn helper_command(b: &Backend, t: &Target) -> Result<(Command, Option<String>)> {
    validate_target(t)?;
    let mut cmd;
    let pid_file = if t.kind == "wsl" {
        Some(format!("/tmp/pi-desktop-helper-{}.pid", Uuid::new_v4()))
    } else {
        None
    };
    if t.kind == "windows" {
        cmd = Command::new(t.node.as_deref().unwrap_or("node"));
        // Tauri's installed resource directory is a verbatim Windows path.
        // Node's entry-point resolver cannot handle its \\?\ prefix.
        let helper = b.helper.to_string_lossy();
        let helper = if let Some(unc) = helper.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            helper.strip_prefix(r"\\?\").unwrap_or(&helper).to_string()
        };
        cmd.arg(helper);
    } else {
        cmd = Command::new("wsl.exe");
        cmd.args(["--distribution", t.distro.as_deref().unwrap()]);
        if let Some(user) = &t.user {
            if !user.is_empty() {
                cmd.args(["--user", user]);
            }
        }
        // Source and requests use stdin, avoiding Windows' 32K command-line limit.
        let script = r#"let buffer='';process.stdin.setEncoding('utf8');const first=chunk=>{buffer+=chunk;const i=buffer.indexOf('\n');if(i<0)return;process.stdin.off('data',first);process.stdin.pause();const source=buffer.slice(0,i),rest=buffer.slice(i+1);import('data:text/javascript;base64,'+source).then(m=>{m.serve();if(rest)process.stdin.emit('data',rest);process.stdin.resume()}).catch(e=>{process.stderr.write(e.message);process.exit(1)})};process.stdin.on('data',first)"#;
        cmd.args([
            "--exec",
            "setsid",
            "--wait",
            "sh",
            "-c",
            "umask 077; export PI_DESKTOP_OWNER=\"$1\"; echo $$ > \"$1\"; shift; exec \"$@\"",
            "pi-desktop",
            pid_file.as_deref().unwrap(),
            t.node.as_deref().unwrap_or("node"),
            "--input-type=module",
            "-e",
            &script,
        ]);
    }
    hidden(&mut cmd);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(file) = &pid_file {
        register_owned(b, file, t)?;
    }
    Ok((cmd, pid_file))
}
fn call_helper(b: &Backend, t: &Target, action: &str, args: Value) -> Result<Value> {
    let (mut cmd, pid_file) = helper_command(b, t)?;
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动此环境中的 Node：{e}"))?;
    b.ownership.attach(&child)?;
    let mut input = child.stdin.take().unwrap();
    helper_source(b, t, &mut input)?;
    writeln!(input, "{}", json!({"target":t,"action":action,"args":args}))
        .map_err(|e| e.to_string())?;
    drop(input);
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut reader = stderr;
        let mut retained = Vec::new();
        let mut bytes = [0; 4096];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 {
                break;
            }
            let keep = n.min(65536usize.saturating_sub(retained.len()));
            retained.extend_from_slice(&bytes[..keep]);
        }
        String::from_utf8_lossy(&retained).into_owned()
    });
    let mut data = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if v.get("ok").is_some() {
                data = Some(v)
            }
        }
    }
    let _ = child.wait();
    if let Some(file) = pid_file {
        unregister_owned(b, &file);
    }
    let err = err_thread.join().unwrap_or_default();
    let v = data.ok_or_else(|| {
        format!(
            "环境未返回有效结果。{}",
            err.chars().take(400).collect::<String>()
        )
    })?;
    if v["ok"] == true {
        Ok(v["data"].clone())
    } else {
        Err(v["error"].as_str().unwrap_or("操作失败").into())
    }
}
fn event(app: &tauri::AppHandle, id: &str, _proc: &Process, kind: &str, payload: Value) {
    let b = app.state::<Backend>();
    let mut events = b.events.lock().unwrap();
    let sequence = events.sequences.entry(id.into()).or_default();
    *sequence += 1;
    let sequence = *sequence;
    events
        .records
        .push(json!({"sessionId":id,"sequence":sequence,"kind":kind,"payload":payload}));
}
fn create_process(
    mut child: Child,
    target: Target,
    mode: String,
    pid_file: Option<String>,
) -> (
    Arc<Process>,
    std::process::ChildStdout,
    std::process::ChildStderr,
) {
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    (
        Arc::new(Process {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            busy: AtomicBool::new(false),
            target,
            mode,
            pid_file,
            session_file: Mutex::new(None),
            environment: Mutex::new(String::new()),
        }),
        stdout,
        stderr,
    )
}
fn write_rpc(proc: &Process, value: &Value) -> Result<()> {
    let mut input = proc.stdin.lock().unwrap();
    writeln!(input, "{value}").map_err(|e| e.to_string())?;
    input.flush().map_err(|e| e.to_string())
}
fn rpc_wait(proc: &Process, mut value: Value) -> Result<Value> {
    let id = Uuid::new_v4().to_string();
    value["id"] = json!(id);
    let (tx, rx) = mpsc::channel();
    proc.pending.lock().unwrap().insert(id.clone(), tx);
    if let Err(e) = write_rpc(proc, &value) {
        proc.pending.lock().unwrap().remove(&id);
        return Err(e);
    }
    let response = rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "pi 响应超时。可重连会话后重试。".to_string());
    proc.pending.lock().unwrap().remove(&id);
    let v = response?;
    if v["success"] == true {
        Ok(v["data"].clone())
    } else {
        Err(v["error"].as_str().unwrap_or("pi 操作失败").into())
    }
}
fn next_queued(app: &tauri::AppHandle) {
    let b = app.state::<Backend>();
    if b.exiting.load(Ordering::SeqCst) {
        return;
    }
    let entries = b.processes.lock().unwrap();
    if entries
        .values()
        .filter(|p| p.busy.load(Ordering::SeqCst))
        .count()
        >= 4
    {
        return;
    }
    let item = b.queue.lock().unwrap().pop_front();
    if let Some((id, v)) = item {
        if let Some(p) = entries.get(&id) {
            p.busy.store(true, Ordering::SeqCst);
            record_run(app, &id, "running");
            if write_rpc(p, &v).is_err() {
                p.busy.store(false, Ordering::SeqCst);
            } else {
                event(app, &id, p, "queued_started", json!({}));
            }
        }
    }
}
fn read_process(
    app: tauri::AppHandle,
    id: String,
    proc: Arc<Process>,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    job: bool,
) {
    let a = app.clone();
    let p = proc.clone();
    let sid = id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = [0; 4096];
        let mut total = 0;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if total < 65536 {
                        event(
                            &a,
                            &sid,
                            &p,
                            "diagnostic",
                            json!({"text":String::from_utf8_lossy(&buf[..n])}),
                        );
                        total += n;
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut bytes = Vec::new();
        loop {
            let v = match protocol::record(&mut reader, &mut bytes, 32 * 1024 * 1024) {
                Ok(Some(v)) => v,
                Ok(None) | Err(protocol::Error::Io) => break,
                Err(protocol::Error::Invalid) => {
                    event(
                        &app,
                        &id,
                        &proc,
                        "protocol_error",
                        json!({"message":"pi 返回了无效或未完成的 JSONL"}),
                    );
                    continue;
                }
                Err(protocol::Error::TooLong) => {
                    event(
                        &app,
                        &id,
                        &proc,
                        "protocol_error",
                        json!({"message":"pi 协议记录超过 32 MB 限制"}),
                    );
                    stop_process(&proc);
                    break;
                }
            };
            {
                if v["type"] == "response" {
                    if let Some(key) = v["id"].as_str() {
                        if let Some(tx) = proc.pending.lock().unwrap().remove(key) {
                            let _ = tx.send(v.clone());
                        }
                    }
                    if v["command"] == "prompt"
                        && (v["success"] == false || v["data"]["disposition"] == "handled")
                    {
                        proc.busy.store(false, Ordering::SeqCst);
                        record_run(&app, &id, "idle");
                        next_queued(&app);
                    }
                }
                let b = app.state::<Backend>();
                let current = {
                    let map = if job {
                        b.jobs.lock().unwrap()
                    } else {
                        b.processes.lock().unwrap()
                    };
                    map.get(&id).is_some_and(|p| Arc::ptr_eq(p, &proc))
                };
                if !current {
                    continue;
                }
                event(&app, &id, &proc, if job { "job" } else { "pi" }, v.clone());
                if v["type"] == "agent_start" {
                    record_run(&app, &id, "running");
                }
                if v["type"] == "agent_settled" {
                    record_run(&app, &id, "idle");
                    proc.busy.store(false, Ordering::SeqCst);
                    if !app.state::<Backend>().exiting.load(Ordering::SeqCst) {
                        use tauri_plugin_notification::NotificationExt;
                        let _ = app
                            .notification()
                            .builder()
                            .title("Pi Desktop")
                            .body("任务已完成，打开工作台查看结果。 ")
                            .show();
                    }
                    next_queued(&app);
                }
            }
        }
        proc.busy.store(false, Ordering::SeqCst);
        proc.pending.lock().unwrap().clear();
        let b = app.state::<Backend>();
        let mut map = if job {
            b.jobs.lock().unwrap()
        } else {
            b.processes.lock().unwrap()
        };
        if map.get(&id).is_some_and(|p| Arc::ptr_eq(p, &proc)) {
            map.remove(&id);
            b.queue.lock().unwrap().retain(|(sid, _)| sid != &id);
            event(&app, &id, &proc, "exit", json!({}));
        }
        drop(map);
        if let Some(file) = &proc.pid_file {
            unregister_owned(&b, file);
        }
        next_queued(&app);
    });
}
fn kill_wsl_group(target: &Target, pid_file: &Option<String>) {
    if target.kind == "wsl" {
        if let Some(file) = &pid_file {
            let mut cmd = Command::new("wsl.exe");
            cmd.args(["-d", target.distro.as_deref().unwrap()]);
            if let Some(u) = &target.user {
                if !u.is_empty() {
                    cmd.args(["-u", u]);
                }
            }
            let script="if [ -f \"$1\" ]; then p=$(cat \"$1\"); case $p in ''|*[!0-9]*) exit 1;; esac; if ! tr '\\0' '\\n' < \"/proc/$p/environ\" 2>/dev/null | grep -Fqx -- \"PI_DESKTOP_OWNER=$1\"; then rm -f -- \"$1\"; exit 0; fi; kill -TERM -- -\"$p\" 2>/dev/null || kill -TERM \"$p\" 2>/dev/null; sleep 0.1; kill -KILL -- -\"$p\" 2>/dev/null || true; rm -f -- \"$1\"; fi";
            cmd.args(["--exec", "sh", "-c", script, "pi-desktop", file]);
            hidden(&mut cmd);
            let _ = cmd.status();
        }
    }
}
fn stop_process(proc: &Process) {
    let _ = write_rpc(proc, &json!({"type":"clear_queue"}));
    let _ = write_rpc(proc, &json!({"type":"abort"}));
    kill_wsl_group(&proc.target, &proc.pid_file);
    let mut child = proc.child.lock().unwrap();
    if child.try_wait().ok().flatten().is_none() {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("taskkill.exe");
            cmd.args(["/PID", &child.id().to_string(), "/T", "/F"]);
            hidden(&mut cmd);
            let _ = cmd.status();
        }
        let _ = child.kill();
    }
    let _ = child.wait();
}
fn open_runtime(app: &tauri::AppHandle, id: &str) -> Result<Arc<Process>> {
    let b = app.state::<Backend>();
    let _start_guard = b.start_lock.lock().unwrap();
    if let Some(p) = b.processes.lock().unwrap().get(id) {
        return Ok(p.clone());
    }
    let s = session(&b, id)?;
    let p = project(&b, &s.project_id)?;
    if !p.trusted {
        return Err("请先信任此项目".into());
    }
    let info = call_helper(&b, &p.target, "detect", json!({}))?;
    if info["ready"] != true {
        return Err(info["error"].as_str().unwrap_or("运行环境未就绪").into());
    }
    let environment = format!(
        "{}:{}:{}",
        p.target.kind,
        p.target.distro.as_deref().unwrap_or("").to_lowercase(),
        info["home"].as_str().unwrap_or("")
    );
    let file_key = if p.target.kind == "windows" {
        s.file.to_lowercase()
    } else {
        s.file.clone()
    };
    if b.processes.lock().unwrap().values().any(|proc| {
        *proc.environment.lock().unwrap() == environment
            && proc.session_file.lock().unwrap().as_deref() == Some(file_key.as_str())
    }) {
        return Err("此 pi 会话文件已在另一个任务中运行".into());
    }
    if s.mode == "plan" {
        call_helper(&b, &p.target, "plan.check", json!({"cwd":s.cwd}))?;
    }
    let node = info["node"].as_str().ok_or("未找到 Node")?;
    let pi = info["pi"].as_str().ok_or("未找到 pi")?;
    let mut args = vec![
        pi.to_string(),
        "--mode".into(),
        "rpc".into(),
        "--session".into(),
        s.file.clone(),
        "--approve".into(),
    ];
    if s.mode == "plan" {
        args.extend(["--no-extensions","--no-mcp","--tools","read,grep,find,ls","--append-system-prompt","You are in planning mode. Only inspect files and produce a concrete plan; do not execute commands or modify project files."].map(String::from));
    }
    let mut cmd;
    let pid_file;
    if p.target.kind == "windows" {
        cmd = Command::new(node);
        cmd.args(&args).current_dir(&s.cwd);
        pid_file = None;
    } else {
        cmd = Command::new("wsl.exe");
        cmd.args(["-d", p.target.distro.as_deref().unwrap()]);
        if let Some(user) = &p.target.user {
            if !user.is_empty() {
                cmd.args(["-u", user]);
            }
        }
        cmd.args(["--cd", &s.cwd]);
        let file = format!("/tmp/pi-desktop-{id}.pid");
        cmd.args([
            "--exec",
            "setsid",
            "--wait",
            "sh",
            "-c",
            "umask 077; export PI_DESKTOP_OWNER=\"$1\"; echo $$ > \"$1\"; shift; exec \"$@\"",
            "pi-desktop",
            &file,
            node,
        ]);
        cmd.args(&args);
        register_owned(&b, &file, &p.target)?;
        pid_file = Some(file);
    }
    hidden(&mut cmd);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    b.ownership.attach(&child)?;
    let (proc, out, err) = create_process(child, p.target, s.mode, pid_file);
    *proc.session_file.lock().unwrap() = Some(file_key);
    *proc.environment.lock().unwrap() = environment;
    b.processes.lock().unwrap().insert(id.into(), proc.clone());
    read_process(app.clone(), id.into(), proc.clone(), out, err, false);
    Ok(proc)
}
#[tauri::command]
fn metadata(b: State<Backend>) -> Result<Value> {
    let db = b.db.lock().unwrap();
    let read = |table: &str| -> Result<Vec<Value>> {
        let mut stmt = db
            .prepare(&format!("SELECT data FROM {table}"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    };
    let layout = db
        .query_row("SELECT data FROM layout WHERE id=1", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    Ok(json!({"projects":read("projects")?,"sessions":read("sessions")?,"layout":layout}))
}
#[tauri::command]
fn layout_save(b: State<Backend>, value: Value) -> Result<()> {
    let layout = json!({"collapsed":value["collapsed"].as_bool().unwrap_or(false),"panel":value["panel"].as_bool().unwrap_or(true),"width":value["width"].as_f64().unwrap_or(420.0).clamp(300.0,720.0)});
    b.db.lock().unwrap().execute("INSERT INTO layout(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![layout.to_string()]).map_err(|e|e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn project_save(app: tauri::AppHandle, value: Project) -> Result<Project> {
    tauri::async_runtime::spawn_blocking(move||{let b=app.state::<Backend>();validate_target(&value.target)?;let inspected=call_helper(&b,&value.target,"project.inspect",json!({"path":value.path}))?;let mut p=value;p.path=inspected["path"].as_str().unwrap().into();if p.id.is_empty(){p.id=Uuid::new_v4().to_string();}b.db.lock().unwrap().execute("INSERT INTO projects(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![p.id,serde_json::to_string(&p).unwrap()]).map_err(|e|e.to_string())?;Ok(p)}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn session_update(app: tauri::AppHandle, id: String, patch: Value) -> Result<Session> {
    tauri::async_runtime::spawn_blocking(move || {
        let b = app.state::<Backend>();
        let mut s = session(&b, &id)?;
        if let Some(v) = patch["pinned"].as_bool() {
            s.pinned = v
        }
        if let Some(v) = patch["archived"].as_bool() {
            s.archived = v
        }
        if let Some(v) = patch["name"].as_str() {
            s.name = v.into()
        }
        if let Some(v) = patch["mode"].as_str() {
            if v != "plan" && v != "execute" {
                return Err("模式无效".into());
            }
            if b.processes
                .lock()
                .unwrap()
                .get(&id)
                .is_some_and(|p| p.busy.load(Ordering::SeqCst))
            {
                return Err("请先停止会话再切换模式".into());
            }
            let old = b.processes.lock().unwrap().remove(&id);
            if let Some(proc) = old {
                stop_process(&proc)
            }
            s.mode = v.into()
        }
        s.updated = now();
        save_session(&b, &s)?;
        Ok(s)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn new_session(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
    isolated: bool,
    mode: String,
    existing: Option<String>,
    fork: Option<String>,
    entry_id: Option<String>,
) -> Result<Session> {
    tauri::async_runtime::spawn_blocking(move||{
 let b=app.state::<Backend>();let p=project(&b,&project_id)?;let detected=call_helper(&b,&p.target,"detect",json!({}))?;if detected["ready"]!=true{return Err(detected["error"].as_str().unwrap_or("运行环境未就绪").into())}if !p.trusted{return Err("请先信任项目".into())}if mode!="plan"&&mode!="execute"{return Err("模式无效".into())}let id=Uuid::new_v4().to_string();let mut cwd=p.path.clone();let mut worktree=false;let mut branch=String::new();
 if isolated&&existing.is_none(){let inspect=call_helper(&b,&p.target,"project.inspect",json!({"path":p.path}))?;if inspect["gitRoot"].as_str().is_some_and(|s|!s.is_empty()){let w=call_helper(&b,&p.target,"git.worktree",json!({"cwd":p.path,"id":&id[..8]}))?;cwd=w["cwd"].as_str().unwrap().into();branch=w["branch"].as_str().unwrap().into();worktree=true;}}
 let result=if let Some(file)=existing{let list=call_helper(&b,&p.target,"session.list",json!({"cwd":p.path}))?;let found=list.as_array().unwrap().iter().find(|s|s["file"]==file).ok_or("会话不属于此项目")?;if b.db.lock().unwrap().query_row("SELECT COUNT(*) FROM sessions WHERE json_extract(data,'$.file')=? AND json_extract(data,'$.projectId')=?",params![file,p.id],|r|r.get::<_,i64>(0)).unwrap_or(0)>0{return Err("该历史会话已导入，请从侧栏打开".into())}cwd=found["cwd"].as_str().unwrap_or(&p.path).into();found.clone()}else if let Some(source)=fork{let original=session(&b,&source)?;if original.project_id!=p.id{return Err("只能从当前项目分支".into())}if b.processes.lock().unwrap().get(&source).is_some_and(|p|p.busy.load(Ordering::SeqCst)){return Err("请先停止来源会话".into())}if !isolated{cwd=original.cwd.clone();branch=original.branch.clone();}call_helper(&b,&p.target,"session.fork",json!({"cwd":cwd,"file":original.file,"entryId":entry_id}))?}else{call_helper(&b,&p.target,"session.create",json!({"cwd":cwd,"name":name}))?};
 let s=Session{id,project_id:p.id,name:if name.is_empty(){result["name"].as_str().unwrap_or("新任务").into()}else{name},cwd,file:result["file"].as_str().ok_or("pi 未返回会话路径")?.into(),mode,worktree,branch,pinned:false,archived:false,updated:now(),runtime_state:"idle".into()};save_session(&b,&s)?;Ok(s)
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn request(
    app: tauri::AppHandle,
    action: String,
    project_id: Option<String>,
    session_id: Option<String>,
    target: Option<Target>,
    args: Value,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let b = app.state::<Backend>();
        let allowed = [
            "detect",
            "project.inspect",
            "session.list",
            "session.history",
            "session.rename",
            "file.list",
            "file.read",
            "file.write",
            "git.status",
            "git.diff",
            "git.stage",
            "git.unstage",
            "git.commit",
            "git.checkout",
            "git.cherryPick",
            "git.cherryAbort",
            "git.cherryContinue",
            "git.worktreeRemove",
            "config.read",
            "config.save",
            "resource.list",
            "resource.read",
            "resource.toggle",
            "resource.remove",
            "package.install",
            "package.remove",
            "mcp.check",
            "mcp.logout",
            "auth.list",
            "auth.logout",
        ];
        if !allowed.contains(&action.as_str()) {
            return Err("不支持的操作".into());
        }
        let mut a = args;
        let mut t = target.unwrap_or(Target {
            kind: "windows".into(),
            ..Default::default()
        });
        if let Some(id) = session_id {
            let s = session(&b, &id)?;
            let p = project(&b, &s.project_id)?;
            t = p.target;
            a["cwd"] = json!(s.cwd);
            a["file"] = json!(s.file);
            if !p.trusted && action != "detect" {
                return Err("请先信任项目".into());
            }
            if action == "git.worktreeRemove" {
                let processes = b.processes.lock().unwrap();
                if processes.keys().any(|sid| {
                    session(&b, sid)
                        .is_ok_and(|other| other.cwd == s.cwd && other.project_id == s.project_id)
                }) {
                    return Err("此工作区仍有已连接会话，请先全部断开".into());
                }
                drop(processes);
                if b.terminals.lock().unwrap().values().any(|term| {
                    session(&b, &term.session_id)
                        .is_ok_and(|other| other.cwd == s.cwd && other.project_id == s.project_id)
                }) {
                    return Err("此工作区仍有交互终端，请先关闭终端".into());
                }
                a["root"] = json!(p.path);
            }
        } else if let Some(id) = project_id {
            let p = project(&b, &id)?;
            t = p.target;
            a["cwd"] = json!(p.path);
            if !p.trusted && action != "detect" && action != "project.inspect" {
                return Err("请先信任项目".into());
            }
        } else if !["detect", "auth.list", "auth.logout"].contains(&action.as_str()) {
            return Err("请先选择项目".into());
        }
        call_helper(&b, &t, &action, a)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn runtime_open(app: tauri::AppHandle, id: String) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = open_runtime(&app, &id)?;
        let state = rpc_wait(&p, json!({"type":"get_state"}))?;
        Ok(json!({"state":state,"busy":p.busy.load(Ordering::SeqCst)}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn rpc(app: tauri::AppHandle, id: String, command: Value) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let proc = open_runtime(&app, &id)?;
        let kind = command["type"].as_str().ok_or("无效 RPC 命令")?;
        let allowed = [
            "prompt",
            "steer",
            "follow_up",
            "abort",
            "clear_queue",
            "get_state",
            "get_messages",
            "set_model",
            "get_available_models",
            "set_thinking_level",
            "get_available_thinking_levels",
            "compact",
            "set_auto_compaction",
            "set_auto_retry",
            "abort_retry",
            "get_session_stats",
            "get_fork_messages",
            "get_tree",
            "set_session_name",
            "get_commands",
            "extension_ui_response",
        ];
        if !allowed.contains(&kind) {
            return Err("此 RPC 操作未开放".into());
        }
        if proc.mode == "plan" && ["prompt", "steer", "follow_up"].contains(&kind) {
            let message = command["message"].as_str().unwrap_or("");
            if message
                .lines()
                .any(|l| l.trim_start().starts_with('/') || l.trim_start().starts_with('!'))
            {
                return Err("规划模式不允许斜杠或 shell 命令".into());
            }
        }
        if kind == "clear_queue" {
            let b = app.state::<Backend>();
            let mut queue = b.queue.lock().unwrap();
            let waiting = queue.iter().any(|(sid, _)| sid == &id);
            queue.retain(|(sid, _)| sid != &id);
            drop(queue);
            if waiting {
                record_run(&app, &id, "idle");
                event(&app, &id, &proc, "queue_cleared", json!({}));
            }
        }
        if kind == "abort" {
            let b = app.state::<Backend>();
            b.queue.lock().unwrap().retain(|(sid, _)| sid != &id);
            let _ = rpc_wait(&proc, json!({"type":"clear_queue"}));
        }
        if kind == "prompt" && !proc.busy.load(Ordering::SeqCst) {
            let b = app.state::<Backend>();
            let map = b.processes.lock().unwrap();
            if map
                .values()
                .filter(|p| p.busy.load(Ordering::SeqCst))
                .count()
                >= 4
            {
                let mut queue = b.queue.lock().unwrap();
                if queue.iter().any(|(sid, _)| sid == &id) {
                    return Err("此会话已有排队消息".into());
                }
                queue.push_back((id.clone(), command));
                event(&app, &id, &proc, "queued", json!({}));
                record_run(&app, &id, "queued");
                return Ok(json!({"disposition":"queued"}));
            }
            proc.busy.store(true, Ordering::SeqCst);
            record_run(&app, &id, "running");
        }
        if kind == "extension_ui_response" {
            write_rpc(&proc, &command)?;
            return Ok(json!({}));
        }
        let result = rpc_wait(&proc, command.clone());
        if result.is_err() && kind == "prompt" {
            proc.busy.store(false, Ordering::SeqCst);
            next_queued(&app)
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn runtime_close(app: tauri::AppHandle, id: String) -> Result<()> {
    let b = app.state::<Backend>();
    b.queue.lock().unwrap().retain(|(s, _)| s != &id);
    let proc = b.processes.lock().unwrap().remove(&id);
    if let Some(p) = proc {
        stop_process(&p)
    }
    Ok(())
}
#[tauri::command]
async fn distributions() -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["--list", "--quiet"]);
        hidden(&mut cmd);
        let out = cmd.output().map_err(|e| e.to_string())?;
        let text = if out.stdout.contains(&0) {
            String::from_utf16_lossy(
                &out.stdout
                    .chunks_exact(2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                    .collect::<Vec<_>>(),
            )
        } else {
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        Ok(text
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn terminal_open(app: tauri::AppHandle, session_id: String) -> Result<String> {
    let b = app.state::<Backend>();
    let s = session(&b, &session_id)?;
    let p = project(&b, &s.project_id)?;
    if !p.trusted {
        return Err("请先信任项目".into());
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 90,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let pid_file = if p.target.kind == "wsl" {
        Some(format!("/tmp/pi-desktop-terminal-{id}.pid"))
    } else {
        None
    };
    let mut command = if p.target.kind == "windows" {
        let mut c = CommandBuilder::new("powershell.exe");
        c.args(["-NoLogo"]);
        c.cwd(&s.cwd);
        c
    } else {
        let mut c = CommandBuilder::new("wsl.exe");
        c.args(["-d", p.target.distro.as_deref().unwrap()]);
        if let Some(u) = &p.target.user {
            if !u.is_empty() {
                c.args(["-u", &u]);
            }
        }
        c.args([
            "--cd",
            &s.cwd,
            "--exec",
            "setsid",
            "--wait",
            "sh",
            "-c",
            "umask 077; export PI_DESKTOP_OWNER=\"$1\"; echo $$ > \"$1\"; exec bash -il",
            "pi-desktop",
            pid_file.as_deref().unwrap(),
        ]);
        c
    };
    command.env("TERM", "xterm-256color");
    if let Some(file) = &pid_file {
        register_owned(&b, file, &p.target)?;
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| e.to_string())?;
    if let Some(pid) = child.process_id() {
        b.ownership.attach_pid(pid);
    }
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    b.terminals.lock().unwrap().insert(
        id.clone(),
        Terminal {
            target: p.target,
            pid_file,
            session_id: session_id.clone(),
            master: pair.master,
            writer,
            child,
        },
    );
    let sid = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _=app.emit("terminal-data",json!({"id":sid,"data":base64::engine::general_purpose::STANDARD.encode(&buf[..n])}));
                }
            }
        }
        let _ = app.emit("terminal-exit", json!({"id":sid}));
    });
    Ok(id)
}
#[tauri::command]
fn terminal_write(b: State<Backend>, id: String, data: String) -> Result<()> {
    let mut terminals = b.terminals.lock().unwrap();
    let t = terminals.get_mut(&id).ok_or("终端已关闭")?;
    t.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn terminal_resize(b: State<Backend>, id: String, cols: u16, rows: u16) -> Result<()> {
    b.terminals
        .lock()
        .unwrap()
        .get(&id)
        .ok_or("终端已关闭")?
        .master
        .resize(PtySize {
            cols: cols.max(2),
            rows: rows.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn terminal_close(app: tauri::AppHandle, id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let b = app.state::<Backend>();
        let terminal = b.terminals.lock().unwrap().remove(&id);
        if let Some(t) = terminal {
            if let Some(file) = &t.pid_file {
                unregister_owned(&b, file);
            }
            stop_terminal(t);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn stop_terminal(t: Terminal) {
    let Terminal {
        target,
        pid_file,
        master,
        mut writer,
        mut child,
        ..
    } = t;
    let _ = writer.write_all(b"\x1b[1;1R");
    let _ = writer.flush();
    std::thread::sleep(Duration::from_millis(40));
    kill_wsl_group(&target, &pid_file);
    if let Some(pid) = child.process_id() {
        let mut cmd = Command::new("taskkill.exe");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hidden(&mut cmd);
        let _ = cmd.status();
    }
    let _ = child.kill();
    drop(writer);
    drop(master);
}

#[tauri::command]
fn auth_start(
    app: tauri::AppHandle,
    project_id: String,
    provider: String,
    auth_type: String,
) -> Result<String> {
    let b = app.state::<Backend>();
    let project = project(&b, &project_id)?;
    let (mut cmd, pid_file) = helper_command(&b, &project.target)?;
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    b.ownership.attach(&child)?;
    let req = json!({"target":project.target,"action":if auth_type=="mcp"{"mcp.login"}else{"auth.login"},"args":{"provider":provider,"type":auth_type,"cwd":project.path}});
    helper_source(&b, &project.target, child.stdin.as_mut().unwrap())?;
    writeln!(child.stdin.as_mut().unwrap(), "{req}").map_err(|e| e.to_string())?;
    let (proc, out, err) = create_process(child, project.target, "auth".into(), pid_file);
    let id = Uuid::new_v4().to_string();
    b.jobs.lock().unwrap().insert(id.clone(), proc.clone());
    read_process(app, id.clone(), proc, out, err, true);
    Ok(id)
}
#[tauri::command]
fn auth_response(b: State<Backend>, job_id: String, id: String, value: String) -> Result<()> {
    let jobs = b.jobs.lock().unwrap();
    let p = jobs.get(&job_id).ok_or("认证已结束")?;
    write_rpc(p, &json!({"id":id,"value":value}))
}
#[tauri::command]
fn auth_cancel(b: State<Backend>, job_id: String) {
    let old = b.jobs.lock().unwrap().remove(&job_id);
    if let Some(proc) = old {
        stop_process(&proc)
    }
}
#[tauri::command]
fn open_url(url: String) -> Result<()> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "浏览器地址无效")?;
    if parsed.scheme() != "https"
        && !(parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err("仅允许 HTTPS 或本机浏览器地址".into());
    }
    let mut cmd = Command::new("rundll32.exe");
    cmd.args(["url.dll,FileProtocolHandler", &url]);
    hidden(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}
fn shutdown(app: &tauri::AppHandle) {
    let b = app.state::<Backend>();
    b.exiting.store(true, Ordering::SeqCst);
    let processes: Vec<_> = b
        .processes
        .lock()
        .unwrap()
        .drain()
        .map(|(_, p)| p)
        .collect();
    for p in processes {
        stop_process(&p)
    }
    let jobs: Vec<_> = b.jobs.lock().unwrap().drain().map(|(_, p)| p).collect();
    for p in jobs {
        stop_process(&p)
    }
    let terminals: Vec<_> = b
        .terminals
        .lock()
        .unwrap()
        .drain()
        .map(|(_, t)| t)
        .collect();
    for t in terminals {
        stop_terminal(t)
    }
    cleanup_owned(&b);
}
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    shutdown(&app);
    app.exit(0)
}
fn main() {
    tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}})).plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_notification::init()).setup(|app|{
 let dir=if cfg!(debug_assertions){std::env::var_os("PI_DESKTOP_DATA_DIR").map(PathBuf::from).unwrap_or(app.path().app_data_dir()?)}else{app.path().app_data_dir()?};std::fs::create_dir_all(&dir)?;let db=Connection::open(dir.join("metadata.sqlite3"))?;db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owned_wsl(file TEXT PRIMARY KEY,target TEXT NOT NULL); CREATE TABLE IF NOT EXISTS layout(id INTEGER PRIMARY KEY,data TEXT NOT NULL);")?;
 let helper=if cfg!(debug_assertions){PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bridge/helper.mjs")}else{app.path().resource_dir()?.join("bridge/helper.mjs")};
 app.manage(Backend{ownership:ownership::Job::new().map_err(std::io::Error::other)?,start_lock:Mutex::new(()),db:Mutex::new(db),processes:Mutex::new(HashMap::new()),queue:Mutex::new(VecDeque::new()),terminals:Mutex::new(HashMap::new()),jobs:Mutex::new(HashMap::new()),helper,exiting:AtomicBool::new(false),events:Mutex::new(EventQueue::default())});
 cleanup_owned(&app.state::<Backend>());
 let handle=app.handle().clone();std::thread::spawn(move||loop{std::thread::sleep(Duration::from_millis(16));let b=handle.state::<Backend>();let events=std::mem::take(&mut b.events.lock().unwrap().records);if !events.is_empty(){let _=handle.emit("desktop-events",events);}if b.exiting.load(Ordering::SeqCst){break}});
 let show=MenuItem::with_id(app,"show","打开 Pi Desktop",true,None::<&str>)?;let exit=MenuItem::with_id(app,"exit","停止任务并退出",true,None::<&str>)?;let menu=Menu::with_items(app,&[&show,&exit])?;
 TrayIconBuilder::new().icon(app.default_window_icon().unwrap().clone()).tooltip("Pi Desktop").menu(&menu).on_menu_event(|app,e|match e.id.as_ref(){"show"=>{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}},"exit"=>{shutdown(app);app.exit(0)},_=>{}}).on_tray_icon_event(|tray,event|{if let TrayIconEvent::DoubleClick{..}=event{if let Some(w)=tray.app_handle().get_webview_window("main"){let _=w.show();let _=w.set_focus();}}}).build(app)?;
 Ok(())}).on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{if !window.app_handle().state::<Backend>().exiting.load(Ordering::SeqCst){api.prevent_close();let _=window.hide();}}}).invoke_handler(tauri::generate_handler![quit,metadata,layout_save,project_save,session_update,new_session,request,runtime_open,rpc,runtime_close,distributions,terminal_open,terminal_write,terminal_resize,terminal_close,auth_start,auth_response,auth_cancel,open_url]).run(tauri::generate_context!()).expect("Pi Desktop failed to start");
}
