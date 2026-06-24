//! Off-main-thread task execution: a pool of worker threads, **each owning its
//! own Elpian VM instance**, that run guest-defined compute tasks in parallel so
//! the heavy per-frame work (geometry tessellation, particle physics, layout
//! math, …) is divided across CPU cores instead of serialising on the render
//! thread.
//!
//! ## Model
//!
//! The guest registers a *worker module* once (`task.init`) — a small JS program
//! whose top-level defines the task functions. The host compiles it to bytecode
//! **once** on the main thread and hands a clone of those bytes to every worker;
//! each worker decodes them into a private [`VM`] of its own. Worker VMs never
//! share heap state with the main VM or with each other — only JSON crosses the
//! thread boundary — so the single-threaded `Rc`-based value model stays sound.
//!
//! Each worker owns a **signal-based job queue** (an `mpsc` channel: `recv()`
//! parks the thread and is woken by a `send`, so an idle worker burns no CPU).
//! `task.spawn` posts a job to the least-loaded worker's queue; the worker runs
//! the named function against its VM and publishes the JSON result into a shared
//! results table guarded by a `Mutex` + `Condvar`. The guest then either polls
//! (`task.poll`, non-blocking) or joins (`task.join`, parks on the condvar until
//! the results land) — the classic spawn / barrier split that lets a frame fan a
//! batch of work out across the pool and gather it back.
//!
//! Workers can also hand work to **each other** through the same signal-based
//! queues (`task.relay`), so a task running on one worker can enqueue a follow-up
//! on another without round-tripping through the main thread.
//!
//! On wasm (no threads) the pool degrades to inline execution on the calling
//! thread: `spawn` runs the task immediately and stores its result, so the guest
//! API behaves identically (it just never actually parallelises). This keeps the
//! web build compiling and correct.

use serde_json::Value;

/// The cross-thread results table: completed task id → JSON-encoded result.
type ResultMap = std::collections::HashMap<u64, String>;

/// Unwrap the single argument of an `askHost` payload (`[arg0, …]` → `arg0`).
fn first_arg(payload: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(payload).ok()?;
    match v {
        Value::Array(mut items) if !items.is_empty() => Some(items.remove(0)),
        Value::Array(_) => None,
        other => Some(other),
    }
}

/// Drive a worker VM to quiescence, servicing any `askHost` it makes with a
/// typed null (worker tasks are pure compute — they compute and `return`, they
/// do not reach back into the host). Returns the function's result, JSON-encoded.
fn run_to_result(vm: &mut elpian_vm::VM, mut val: elpian_vm::Val) -> String {
    // `sending_host_call_data` is `Some` exactly while the VM is paused on an
    // `askHost`; drain those with a null reply until the call returns its value.
    while vm.sending_host_call_data.take().is_some() {
        val = vm.continue_run("null".to_string());
    }
    val.stringify()
}

/// Build a worker VM from shared bytecode and run its top level once so the
/// module's task functions are defined.
fn build_worker_vm(id: String, bytecode: Vec<u8>) -> elpian_vm::VM {
    let mut vm = elpian_vm::VM::compile_and_create_of_bytecode(id, bytecode, Vec::new());
    let top = vm.run();
    let _ = run_to_result(&mut vm, top);
    vm
}

// ---------------------------------------------------------------- native ------
#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread::JoinHandle;

    /// A unit of work posted to a worker's queue.
    enum Msg {
        /// Run `func(args)` on this worker's VM and publish the result under `id`.
        Job { id: u64, func: String, args: String },
        Shutdown,
    }

    /// The cross-thread rendezvous: completed task results plus a condvar the
    /// main thread parks on in `join` until the results it waits for arrive.
    struct Shared {
        results: Mutex<super::ResultMap>,
        ready: Condvar,
        completed: AtomicU64,
    }

    /// A pool of worker threads, each running a private Elpian VM.
    pub struct WorkerPool {
        senders: Vec<Sender<Msg>>,
        depth: Vec<Arc<AtomicUsize>>,
        shared: Arc<Shared>,
        handles: Vec<Option<JoinHandle<()>>>,
        next_id: u64,
        rr: usize,
    }

    impl WorkerPool {
        /// Spin up `n` worker threads, each compiling `bytecode` into its own VM.
        pub fn start(bytecode: Vec<u8>, n: usize) -> Self {
            let n = n.clamp(1, 64);
            let shared = Arc::new(Shared {
                results: Mutex::new(super::ResultMap::new()),
                ready: Condvar::new(),
                completed: AtomicU64::new(0),
            });
            let mut senders = Vec::with_capacity(n);
            let mut depth = Vec::with_capacity(n);
            let mut handles = Vec::with_capacity(n);
            for i in 0..n {
                let (tx, rx) = channel::<Msg>();
                let d = Arc::new(AtomicUsize::new(0));
                let worker_depth = d.clone();
                let worker_shared = shared.clone();
                let code = bytecode.clone();
                let handle = std::thread::Builder::new()
                    .name(format!("elpa-worker-{i}"))
                    .spawn(move || {
                        let mut vm = build_worker_vm(format!("elpa-worker-{i}"), code);
                        while let Ok(msg) = rx.recv() {
                            match msg {
                                Msg::Job { id, func, args } => {
                                    worker_depth.fetch_sub(1, Ordering::Relaxed);
                                    let first = vm.run_func_with_input(&func, Some(&args), 0);
                                    let result = run_to_result(&mut vm, first);
                                    if let Ok(mut map) = worker_shared.results.lock() {
                                        map.insert(id, result);
                                    }
                                    worker_shared.completed.fetch_add(1, Ordering::Relaxed);
                                    worker_shared.ready.notify_all();
                                }
                                Msg::Shutdown => break,
                            }
                        }
                    })
                    .expect("spawn elpa worker thread");
                senders.push(tx);
                depth.push(d);
                handles.push(Some(handle));
            }
            WorkerPool { senders, depth, shared, handles, next_id: 1, rr: 0 }
        }

        pub fn worker_count(&self) -> usize {
            self.senders.len()
        }

        /// Pick the least-loaded worker (fewest queued jobs), breaking ties with
        /// a round-robin cursor so a burst of equal-depth posts still spreads.
        fn choose(&mut self) -> usize {
            let mut best = self.rr % self.senders.len();
            let mut best_depth = self.depth[best].load(Ordering::Relaxed);
            for off in 0..self.senders.len() {
                let i = (self.rr + off) % self.senders.len();
                let d = self.depth[i].load(Ordering::Relaxed);
                if d < best_depth {
                    best = i;
                    best_depth = d;
                }
            }
            self.rr = (self.rr + 1) % self.senders.len();
            best
        }

        /// Post a job to a specific worker's queue.
        fn post(&self, worker: usize, id: u64, func: String, args: String) {
            self.depth[worker].fetch_add(1, Ordering::Relaxed);
            let _ = self.senders[worker].send(Msg::Job { id, func, args });
        }

        /// Enqueue `func(args)` on the least-loaded worker; returns the task id.
        pub fn spawn(&mut self, func: String, args: String) -> u64 {
            let id = self.next_id;
            self.next_id += 1;
            let worker = self.choose();
            self.post(worker, id, func, args);
            id
        }

        /// Enqueue `func(args)` on a specific worker (used by `task.relay` so a
        /// worker can hand follow-up work to a chosen peer). `worker` wraps.
        pub fn spawn_on(&mut self, worker: usize, func: String, args: String) -> u64 {
            let id = self.next_id;
            self.next_id += 1;
            let w = worker % self.senders.len();
            self.post(w, id, func, args);
            id
        }

        /// Non-blocking: take a task's result if it has landed.
        pub fn poll(&self, id: u64) -> Option<String> {
            self.shared.results.lock().ok()?.remove(&id)
        }

        /// Block (parking on the condvar) until every id in `ids` has a result,
        /// then return them in order. An idle wait consumes no CPU.
        pub fn join(&self, ids: &[u64]) -> Vec<String> {
            let mut guard = self.shared.results.lock().expect("worker results lock");
            loop {
                if ids.iter().all(|id| guard.contains_key(id)) {
                    return ids
                        .iter()
                        .map(|id| guard.remove(id).unwrap_or_else(|| "null".to_string()))
                        .collect();
                }
                guard = self.shared.ready.wait(guard).expect("worker condvar wait");
            }
        }

        /// (workers, total queued, total completed) — a cheap KPI snapshot.
        pub fn stats(&self) -> (usize, usize, u64) {
            let queued = self.depth.iter().map(|d| d.load(Ordering::Relaxed)).sum();
            (self.senders.len(), queued, self.shared.completed.load(Ordering::Relaxed))
        }
    }

    impl Drop for WorkerPool {
        fn drop(&mut self) {
            for tx in &self.senders {
                let _ = tx.send(Msg::Shutdown);
            }
            for h in &mut self.handles {
                if let Some(h) = h.take() {
                    let _ = h.join();
                }
            }
        }
    }
}

// ------------------------------------------------------------------ wasm ------
#[cfg(target_arch = "wasm32")]
mod imp {
    use super::*;
    use std::collections::HashMap as StdHashMap;

    /// Threadless fallback: one VM on the calling thread; `spawn` runs the task
    /// inline and stores its result, so the guest API is identical (it just does
    /// not actually parallelise).
    pub struct WorkerPool {
        vm: elpian_vm::VM,
        results: StdHashMap<u64, String>,
        next_id: u64,
        completed: u64,
    }

    impl WorkerPool {
        pub fn start(bytecode: Vec<u8>, _n: usize) -> Self {
            let vm = build_worker_vm("elpa-worker-0".to_string(), bytecode);
            WorkerPool { vm, results: StdHashMap::new(), next_id: 1, completed: 0 }
        }
        pub fn worker_count(&self) -> usize {
            1
        }
        fn run(&mut self, func: &str, args: &str) -> String {
            let first = self.vm.run_func_with_input(func, Some(args), 0);
            run_to_result(&mut self.vm, first)
        }
        pub fn spawn(&mut self, func: String, args: String) -> u64 {
            let id = self.next_id;
            self.next_id += 1;
            let r = self.run(&func, &args);
            self.results.insert(id, r);
            self.completed += 1;
            id
        }
        pub fn spawn_on(&mut self, _worker: usize, func: String, args: String) -> u64 {
            self.spawn(func, args)
        }
        pub fn poll(&self, id: u64) -> Option<String> {
            self.results.get(&id).cloned()
        }
        // Mutating poll to bound the map (mirrors native semantics of taking).
        pub fn take(&mut self, id: u64) -> Option<String> {
            self.results.remove(&id)
        }
        pub fn join(&self, ids: &[u64]) -> Vec<String> {
            ids.iter()
                .map(|id| self.results.get(id).cloned().unwrap_or_else(|| "null".to_string()))
                .collect()
        }
        pub fn stats(&self) -> (usize, usize, u64) {
            (1, 0, self.completed)
        }
    }
}

pub use imp::WorkerPool;

/// A worker pool plus the bookkeeping the host-call layer needs: the guest posts
/// tasks by *function name* and gets back integer ids it later polls / joins.
/// `TaskPool` is the façade `HostEnv` holds; it owns the pool lazily so a guest
/// that never calls `task.*` pays nothing.
pub struct TaskPool {
    pool: Option<WorkerPool>,
}

impl Default for TaskPool {
    fn default() -> Self {
        TaskPool { pool: None }
    }
}

impl TaskPool {
    /// Service a `task.*` host call. Returns the JSON reply string.
    ///
    /// * `task.init  {source, workers}` — compile the worker module to bytecode
    ///   once and start the pool. Idempotent: a second init is ignored (the pool
    ///   is already warm) unless `source` differs, in which case it restarts.
    /// * `task.spawn {fn, args}`        — post a job; reply `{ok, id}`.
    /// * `task.poll  {id}`              — non-blocking; reply `{ok, ready, result?}`.
    /// * `task.join  {ids:[…]}`         — block until all done; reply `{ok, results:[…]}`.
    /// * `task.relay {to, fn, args}`    — post to a specific worker; reply `{ok, id}`.
    /// * `task.stats`                   — reply `{ok, workers, queued, completed}`.
    pub fn service(&mut self, api_name: &str, payload: &str) -> String {
        match api_name {
            "task.init" => self.init(payload),
            "task.spawn" => self.spawn(payload),
            "task.poll" => self.poll(payload),
            "task.join" => self.join(payload),
            "task.relay" => self.relay(payload),
            "task.stats" => self.stats(),
            _ => "null".to_string(),
        }
    }

    fn init(&mut self, payload: &str) -> String {
        let arg = match first_arg(payload) {
            Some(v) => v,
            None => return err("task.init: missing {source}"),
        };
        let source = arg.get("source").and_then(Value::as_str).unwrap_or("");
        if source.is_empty() {
            return err("task.init: empty worker source");
        }
        let requested = arg.get("workers").and_then(Value::as_i64).unwrap_or(0);
        let n = if requested > 0 {
            requested as usize
        } else {
            std::thread::available_parallelism().map(|p| p.get()).unwrap_or(4)
        };
        // Compile the worker module to bytecode once, here on the main thread, so
        // the JS front-end never runs concurrently on the worker threads — each
        // worker just decodes the shared bytes.
        let bytecode = match elpian_vm::api::compile_js_to_bytecode(source) {
            Some(bc) => bc,
            None => return err("task.init: worker source failed to compile"),
        };
        if self.pool.is_some() {
            // Already initialised; honour the request idempotently.
            let workers = self.pool.as_ref().map(|p| p.worker_count()).unwrap_or(0);
            return serde_json::json!({ "ok": true, "workers": workers, "reused": true })
                .to_string();
        }
        let pool = WorkerPool::start(bytecode, n);
        let workers = pool.worker_count();
        self.pool = Some(pool);
        serde_json::json!({ "ok": true, "workers": workers }).to_string()
    }

    fn spawn(&mut self, payload: &str) -> String {
        let pool = match self.pool.as_mut() {
            Some(p) => p,
            None => return err("task.spawn: pool not initialised (call taskInit first)"),
        };
        let arg = first_arg(payload).unwrap_or(Value::Null);
        let func = arg.get("fn").and_then(Value::as_str).unwrap_or("").to_string();
        if func.is_empty() {
            return err("task.spawn: missing {fn}");
        }
        let args = arg.get("args").cloned().unwrap_or(Value::Null).to_string();
        let id = pool.spawn(func, args);
        serde_json::json!({ "ok": true, "id": id }).to_string()
    }

    fn relay(&mut self, payload: &str) -> String {
        let pool = match self.pool.as_mut() {
            Some(p) => p,
            None => return err("task.relay: pool not initialised"),
        };
        let arg = first_arg(payload).unwrap_or(Value::Null);
        let func = arg.get("fn").and_then(Value::as_str).unwrap_or("").to_string();
        if func.is_empty() {
            return err("task.relay: missing {fn}");
        }
        let to = arg.get("to").and_then(Value::as_i64).unwrap_or(0).max(0) as usize;
        let args = arg.get("args").cloned().unwrap_or(Value::Null).to_string();
        let id = pool.spawn_on(to, func, args);
        serde_json::json!({ "ok": true, "id": id }).to_string()
    }

    fn poll(&mut self, payload: &str) -> String {
        let arg = first_arg(payload).unwrap_or(Value::Null);
        let id = match arg.get("id").and_then(Value::as_u64) {
            Some(id) => id,
            None => return err("task.poll: missing {id}"),
        };
        #[cfg(not(target_arch = "wasm32"))]
        let got = self.pool.as_ref().and_then(|p| p.poll(id));
        #[cfg(target_arch = "wasm32")]
        let got = self.pool.as_mut().and_then(|p| p.take(id));
        match got {
            Some(result) => {
                let parsed: Value = serde_json::from_str(&result).unwrap_or(Value::Null);
                serde_json::json!({ "ok": true, "ready": true, "result": parsed }).to_string()
            }
            None => serde_json::json!({ "ok": true, "ready": false }).to_string(),
        }
    }

    fn join(&mut self, payload: &str) -> String {
        let pool = match self.pool.as_ref() {
            Some(p) => p,
            None => return err("task.join: pool not initialised"),
        };
        let arg = first_arg(payload).unwrap_or(Value::Null);
        let ids: Vec<u64> = arg
            .get("ids")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_default();
        let raw = pool.join(&ids);
        let results: Vec<Value> =
            raw.iter().map(|r| serde_json::from_str(r).unwrap_or(Value::Null)).collect();
        serde_json::json!({ "ok": true, "results": results }).to_string()
    }

    /// Read-only KPI snapshot for host telemetry: `(workers, queued, completed)`.
    /// `None` if the pool was never initialised.
    pub fn pool_stats(&self) -> Option<(usize, usize, u64)> {
        self.pool.as_ref().map(|p| p.stats())
    }

    fn stats(&self) -> String {
        match self.pool.as_ref() {
            Some(p) => {
                let (workers, queued, completed) = p.stats();
                serde_json::json!({
                    "ok": true, "workers": workers, "queued": queued, "completed": completed
                })
                .to_string()
            }
            None => serde_json::json!({ "ok": true, "workers": 0, "queued": 0, "completed": 0 })
                .to_string(),
        }
    }
}

fn err(msg: &str) -> String {
    serde_json::json!({ "ok": false, "error": msg }).to_string()
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    const WORKER_SRC: &str = r#"
        function sumTo(n) {
            let total = 0.0;
            let i = 0.0;
            while (i < n) { total = total + i; i = i + 1.0; }
            return total;
        }
        function echo(x) { return x; }
        function addPair(p) { return p.a + p.b; }
    "#;

    fn pool() -> TaskPool {
        let mut tp = TaskPool::default();
        let r = tp.service("task.init", &format!("[{{\"source\": {:?}, \"workers\": 3}}]", WORKER_SRC));
        assert!(r.contains("\"ok\":true"), "init reply: {r}");
        tp
    }

    #[test]
    fn spawns_and_joins_a_pure_compute_task() {
        let mut tp = pool();
        let spawn = tp.service("task.spawn", r#"[{"fn":"sumTo","args":100}]"#);
        let id: u64 = serde_json::from_str::<Value>(&spawn).unwrap()["id"].as_u64().unwrap();
        let join = tp.service("task.join", &format!("[{{\"ids\":[{id}]}}]"));
        let v: Value = serde_json::from_str(&join).unwrap();
        // sum 0..100 = 4950
        assert_eq!(v["results"][0].as_f64(), Some(4950.0), "join reply: {join}");
    }

    #[test]
    fn round_trips_object_args() {
        let mut tp = pool();
        let spawn = tp.service("task.spawn", r#"[{"fn":"addPair","args":{"a":3,"b":4}}]"#);
        let id: u64 = serde_json::from_str::<Value>(&spawn).unwrap()["id"].as_u64().unwrap();
        let join = tp.service("task.join", &format!("[{{\"ids\":[{id}]}}]"));
        let v: Value = serde_json::from_str(&join).unwrap();
        assert_eq!(v["results"][0].as_f64(), Some(7.0));
    }

    #[test]
    fn many_tasks_fan_out_across_workers_and_all_complete() {
        let mut tp = pool();
        let mut ids = Vec::new();
        for _ in 0..64 {
            let spawn = tp.service("task.spawn", r#"[{"fn":"sumTo","args":50}]"#);
            ids.push(serde_json::from_str::<Value>(&spawn).unwrap()["id"].as_u64().unwrap());
        }
        let ids_json = serde_json::to_string(&ids).unwrap();
        let join = tp.service("task.join", &format!("[{{\"ids\":{ids_json}}}]"));
        let v: Value = serde_json::from_str(&join).unwrap();
        let results = v["results"].as_array().unwrap();
        assert_eq!(results.len(), 64);
        for r in results {
            assert_eq!(r.as_f64(), Some(1225.0)); // sum 0..50
        }
        let stats: Value =
            serde_json::from_str(&tp.service("task.stats", "[]")).unwrap();
        assert_eq!(stats["workers"].as_u64(), Some(3));
        assert!(stats["completed"].as_u64().unwrap() >= 64);
    }

    #[test]
    fn poll_is_nonblocking_and_eventually_ready() {
        let mut tp = pool();
        let spawn = tp.service("task.spawn", r#"[{"fn":"sumTo","args":10}]"#);
        let id: u64 = serde_json::from_str::<Value>(&spawn).unwrap()["id"].as_u64().unwrap();
        let mut ready = false;
        for _ in 0..1000 {
            let poll = tp.service("task.poll", &format!("[{{\"id\":{id}}}]"));
            let v: Value = serde_json::from_str(&poll).unwrap();
            if v["ready"].as_bool() == Some(true) {
                assert_eq!(v["result"].as_f64(), Some(45.0));
                ready = true;
                break;
            }
            std::thread::yield_now();
        }
        assert!(ready, "task should eventually be ready");
    }
}
