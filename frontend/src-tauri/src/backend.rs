//! 백엔드 프로세스 하나의 수명. `code-atlas --hosted`를 띄워 표준 출력의 첫 줄에서 주소를 읽고, 표준 입력 파이프를 쥐고 있다가
//! 닫아서 끝낸다. 백엔드가 스스로 끝나면 종료 코드와 표준 오류의 마지막 줄들을 `stopped`로 알린다.
//!
//! 띄우는 명령은 `command`가 정한다. 앱 안에 묶은 Python(`Resources/python/bin/python3`)이 있으면 그것을, 없으면 이 껍데기를
//! 빌드한 레포의 `.venv/bin/python`을 쓴다.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// 표준 입력을 닫은 뒤 백엔드가 끝나기를 기다리는 시간. 백엔드가 끝날 때 차례로 쓰는 시간을 더한 값이다: 응답하는 중인 요청을
/// 기다리는 `cli.py`의 `HOSTED_GRACE`(1초), 도는 `claude` 호출을 끝내는 `tools.py`의 `TERM_GRACE`(5초), 언어 서버를 닫는
/// `lsp.py`의 `SHUTDOWN_TIMEOUT`과 `STOP_TIMEOUT`(5초씩), 프로세스가 내려가는 여유(4초).
pub const STOP_TIMEOUT: Duration = Duration::from_secs(1 + 5 + 5 + 5 + 4);
/// `stopped`의 `detail`로 내는 표준 오류의 줄 수
const KEPT_LINES: usize = 20;
/// 백엔드가 끝난 뒤 표준 오류의 남은 줄을 기다리는 시간. 백엔드의 자식이 파이프를 쥐고 남으면 이 시간 뒤에 읽기를 그만둔다.
const TAIL_WAIT: Duration = Duration::from_millis(300);
const POLL: Duration = Duration::from_millis(50);
const ARGS: [&str; 7] = ["-m", "code_atlas.cli", "--hosted", "--port", "0", "--origin", "tauri://localhost"];

/// 화면에 알리는 백엔드의 상태. `host.ts`의 `Backend`와 같은 모양이다.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub enum State {
    Starting,
    Ready { url: String },
    Stopped { code: Option<i32>, detail: String },
}

/// 백엔드를 띄우는 명령. `resources`는 앱의 `Resources` 폴더이고 `checkout`은 이 껍데기를 빌드한 레포의 루트다.
/// 묶은 Python은 `-I`로 사용자의 `PYTHON*` 환경 변수와 사용자 `site-packages`를 읽지 않는다. 레포의 가상환경은 레포 루트를
/// 작업 폴더로 삼아 그 폴더의 `code_atlas`를 싣는다.
pub fn command(resources: &Path, checkout: &Path) -> Command {
    let bundled = resources.join("python/bin/python3");
    let mut command;
    if bundled.is_file() {
        command = Command::new(bundled);
        command.args(["-I", "-B"]);
    } else {
        command = Command::new(checkout.join(".venv/bin/python"));
        command.arg("-B").current_dir(checkout);
    }
    command.args(ARGS);
    command
}

struct Inner {
    state: State,
    /// 띄울 때마다 1씩 는다. 앞서 띄운 백엔드를 지켜보던 스레드는 자기 차례가 아니면 상태를 바꾸지 않는다.
    turn: u64,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

pub struct Backend {
    command: Box<dyn Fn() -> Command + Send + Sync>,
    notify: Box<dyn Fn(&State) + Send + Sync>,
    inner: Mutex<Inner>,
}

impl Backend {
    /// `command`가 낸 명령으로 띄우고 상태가 바뀔 때마다 `notify`를 부르는 백엔드. `start`를 부르기 전에는 `starting`이다.
    pub fn new(command: impl Fn() -> Command + Send + Sync + 'static, notify: impl Fn(&State) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            command: Box::new(command),
            notify: Box::new(notify),
            inner: Mutex::new(Inner { state: State::Starting, turn: 0, child: None, stdin: None }),
        })
    }

    pub fn state(&self) -> State {
        self.inner.lock().unwrap().state.clone()
    }

    /// 백엔드를 띄운다. 주소를 받으면 `ready`를, 띄우지 못했거나 스스로 끝나면 `stopped`를 알린다.
    pub fn start(self: &Arc<Self>) {
        let mut inner = self.inner.lock().unwrap();
        inner.turn += 1;
        let turn = inner.turn;
        let mut command = (self.command)();
        let spawned = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                let detail = format!("{}: {error}", command.get_program().to_string_lossy());
                self.set(&mut inner, State::Stopped { code: None, detail });
                return;
            }
        };
        let stdout = child.stdout.take().expect("표준 출력을 파이프로 받는다");
        let stderr = child.stderr.take().expect("표준 오류를 파이프로 받는다");
        inner.stdin = child.stdin.take();
        inner.child = Some(child);
        self.set(&mut inner, State::Starting);
        drop(inner);

        let backend = self.clone();
        thread::spawn(move || backend.read_url(turn, stdout));
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let (ended, tail_ended) = channel();
        let kept = tail.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut kept = kept.lock().unwrap();
                if kept.len() == KEPT_LINES {
                    kept.pop_front();
                }
                kept.push_back(line);
            }
            let _ = ended.send(());
        });
        let backend = self.clone();
        thread::spawn(move || backend.watch(turn, tail, tail_ended));
    }

    /// 표준 입력 파이프를 닫아 백엔드가 끝나기 시작하게 한다. 이 뒤로는 백엔드가 끝나도 `stopped`를 알리지 않는다.
    pub fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.turn += 1;
        inner.stdin = None;
    }

    /// 표준 입력 파이프를 닫고 `timeout`까지 기다린 뒤, 백엔드가 남아 있으면 `SIGKILL`을 보낸다.
    pub fn stop(&self, timeout: Duration) {
        self.close();
        let Some(mut child) = self.inner.lock().unwrap().child.take() else {
            return;
        };
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(POLL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    /// 떠 있는 백엔드를 끝내고 새로 띄운다.
    pub fn restart(self: &Arc<Self>) {
        self.stop(STOP_TIMEOUT);
        self.start();
    }

    fn set(&self, inner: &mut Inner, state: State) {
        inner.state = state;
        (self.notify)(&inner.state);
    }

    /// 표준 출력의 첫 줄 `{"url": "http://127.0.0.1:포트"}`에서 주소를 읽어 `ready`로 바꾸고, 그 뒤의 출력은 읽어서 버린다.
    fn read_url(&self, turn: u64, stdout: impl Read) {
        let mut lines = BufReader::new(stdout).lines().map_while(Result::ok);
        let url = lines.next().and_then(|line| serde_json::from_str::<serde_json::Value>(&line).ok()?.get("url")?.as_str().map(String::from));
        if let Some(url) = url {
            let mut inner = self.inner.lock().unwrap();
            if inner.turn == turn && inner.state == State::Starting {
                self.set(&mut inner, State::Ready { url });
            }
        }
        lines.for_each(drop);
    }

    /// 백엔드가 끝나기를 기다렸다가 종료 코드와 표준 오류의 마지막 줄들을 `stopped`로 알린다.
    fn watch(&self, turn: u64, tail: Arc<Mutex<VecDeque<String>>>, tail_ended: Receiver<()>) {
        let code = loop {
            let mut inner = self.inner.lock().unwrap();
            if inner.turn != turn {
                return;
            }
            match inner.child.as_mut().map(Child::try_wait) {
                Some(Ok(None)) => {}
                Some(Ok(Some(status))) => break status.code(),
                Some(Err(_)) | None => break None,
            }
            drop(inner);
            thread::sleep(POLL);
        };
        let _ = tail_ended.recv_timeout(TAIL_WAIT);
        let mut inner = self.inner.lock().unwrap();
        if inner.turn != turn {
            return;
        }
        inner.child = None;
        inner.stdin = None;
        let detail = tail.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
        self.set(&mut inner, State::Stopped { code, detail });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// `script`를 `/bin/sh`로 돌리는 가짜 백엔드와 그 백엔드가 알린 상태의 목록
    fn fake(script: &'static str) -> (Arc<Backend>, Arc<Mutex<Vec<State>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let told = seen.clone();
        let backend = Backend::new(
            move || {
                let mut command = Command::new("/bin/sh");
                command.args(["-c", script]);
                command
            },
            move |state| told.lock().unwrap().push(state.clone()),
        );
        (backend, seen)
    }

    fn until(backend: &Backend, wanted: impl Fn(&State) -> bool) -> State {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let state = backend.state();
            if wanted(&state) || Instant::now() > end {
                return state;
            }
            thread::sleep(POLL);
        }
    }

    fn alive(pid: u32) -> bool {
        Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().unwrap().success()
    }

    fn pid_of(backend: &Backend) -> u32 {
        backend.inner.lock().unwrap().child.as_ref().unwrap().id()
    }

    const SERVES: &str = r#"echo '{"url": "http://127.0.0.1:53124"}'; cat > /dev/null"#;
    const IGNORES_STDIN: &str = r#"echo '{"url": "http://127.0.0.1:53124"}'; exec sleep 600"#;

    #[test]
    fn state_matches_the_shape_host_ts_reads() {
        let json = |state: State| serde_json::to_string(&state).unwrap();
        assert_eq!(json(State::Starting), r#"{"phase":"starting"}"#);
        assert_eq!(json(State::Ready { url: "http://127.0.0.1:1".into() }), r#"{"phase":"ready","url":"http://127.0.0.1:1"}"#);
        assert_eq!(json(State::Stopped { code: None, detail: "x".into() }), r#"{"phase":"stopped","code":null,"detail":"x"}"#);
    }

    #[test]
    fn reads_the_url_from_the_first_line() {
        let (backend, seen) = fake(SERVES);
        assert_eq!(backend.state(), State::Starting);
        backend.start();
        let ready = State::Ready { url: "http://127.0.0.1:53124".into() };
        assert_eq!(until(&backend, |state| *state != State::Starting), ready);
        assert_eq!(*seen.lock().unwrap(), [State::Starting, ready]);
        backend.stop(STOP_TIMEOUT);
    }

    #[test]
    fn ends_when_stdin_closes() {
        let (backend, seen) = fake(SERVES);
        backend.start();
        until(&backend, |state| *state != State::Starting);
        let pid = pid_of(&backend);
        let began = Instant::now();
        backend.stop(STOP_TIMEOUT);
        assert!(began.elapsed() < Duration::from_secs(3), "표준 입력을 닫으면 기다리는 시간을 다 쓰지 않고 끝난다");
        assert!(!alive(pid));
        thread::sleep(TAIL_WAIT + POLL * 4);
        assert_eq!(seen.lock().unwrap().len(), 2, "껍데기가 끝낸 백엔드는 stopped를 알리지 않는다");
    }

    #[test]
    fn kills_a_backend_that_ignores_stdin() {
        let (backend, _) = fake(IGNORES_STDIN);
        backend.start();
        until(&backend, |state| *state != State::Starting);
        let pid = pid_of(&backend);
        let began = Instant::now();
        backend.stop(Duration::from_millis(400));
        assert!(began.elapsed() >= Duration::from_millis(400), "기다리는 시간을 다 쓴 뒤에 죽인다");
        assert!(!alive(pid));
    }

    #[test]
    fn tells_why_the_backend_stopped() {
        let (backend, seen) = fake(r#"echo '{"url": "http://127.0.0.1:53124"}'; for n in $(seq 30); do echo "line $n" >&2; done; exit 3"#);
        backend.start();
        let stopped = until(&backend, |state| matches!(state, State::Stopped { .. }));
        let lines: Vec<String> = (11..=30).map(|n| format!("line {n}")).collect();
        assert_eq!(stopped, State::Stopped { code: Some(3), detail: lines.join("\n") });
        assert_eq!(seen.lock().unwrap().last(), Some(&stopped));
    }

    #[test]
    fn tells_a_backend_killed_by_a_signal() {
        let (backend, _) = fake(IGNORES_STDIN);
        backend.start();
        until(&backend, |state| *state != State::Starting);
        Command::new("/bin/kill").args(["-9", &pid_of(&backend).to_string()]).status().unwrap();
        let stopped = until(&backend, |state| matches!(state, State::Stopped { .. }));
        assert_eq!(stopped, State::Stopped { code: None, detail: String::new() });
    }

    #[test]
    fn tells_a_command_that_does_not_run() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let told = seen.clone();
        let backend = Backend::new(|| Command::new("/nonexistent/python"), move |state: &State| told.lock().unwrap().push(state.clone()));
        backend.start();
        let State::Stopped { code: None, detail } = backend.state() else {
            panic!("띄우지 못한 백엔드는 stopped다");
        };
        assert!(detail.starts_with("/nonexistent/python: "), "{detail}");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn restart_brings_a_stopped_backend_back() {
        let (backend, seen) = fake(r#"echo '{"url": "http://127.0.0.1:53124"}'; read line; exit 1"#);
        backend.start();
        until(&backend, |state| *state != State::Starting);
        backend.inner.lock().unwrap().stdin = None;
        until(&backend, |state| matches!(state, State::Stopped { .. }));
        backend.restart();
        assert!(matches!(until(&backend, |state| *state != State::Starting), State::Ready { .. }));
        let phases: Vec<&str> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|state| match state {
                State::Starting => "starting",
                State::Ready { .. } => "ready",
                State::Stopped { .. } => "stopped",
            })
            .collect();
        assert_eq!(phases, ["starting", "ready", "stopped", "starting", "ready"]);
        backend.stop(STOP_TIMEOUT);
    }

    #[test]
    fn restart_ends_a_running_backend_first() {
        let (backend, _) = fake(SERVES);
        backend.start();
        until(&backend, |state| *state != State::Starting);
        let first = pid_of(&backend);
        backend.restart();
        assert!(!alive(first));
        assert!(matches!(until(&backend, |state| *state != State::Starting), State::Ready { .. }));
        backend.stop(STOP_TIMEOUT);
    }

    #[test]
    fn command_prefers_the_bundled_python() {
        let dir = std::env::temp_dir().join(format!("atlas-command-{}", std::process::id()));
        let resources = dir.join("Resources");
        let checkout = dir.join("checkout");
        let args = |command: &Command| command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ");

        let dev = command(&resources, &checkout);
        assert_eq!(dev.get_program(), checkout.join(".venv/bin/python"));
        assert_eq!(args(&dev), "-B -m code_atlas.cli --hosted --port 0 --origin tauri://localhost");
        assert_eq!(dev.get_current_dir(), Some(checkout.as_path()));

        fs::create_dir_all(resources.join("python/bin")).unwrap();
        fs::write(resources.join("python/bin/python3"), "").unwrap();
        let bundled = command(&resources, &checkout);
        assert_eq!(bundled.get_program(), resources.join("python/bin/python3"));
        assert_eq!(args(&bundled), "-I -B -m code_atlas.cli --hosted --port 0 --origin tauri://localhost");
        assert_eq!(bundled.get_current_dir(), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
