use std::sync::{mpsc::{Receiver, RecvError, SendError, Sender}, Arc, Mutex};
use std::thread::{self, JoinHandle};

use super::types::{DaemonJob, DaemonLane};

pub struct DaemonLaneSenders {
    pub foreground: Sender<DaemonJob>,
    pub preview: Sender<DaemonJob>,
    pub preview_render: Sender<DaemonJob>,
    pub scan: Sender<DaemonJob>,
    pub write: Sender<DaemonJob>,
    pub maintenance: Sender<DaemonJob>,
    pub activation: Sender<DaemonJob>,
    pub background: Sender<DaemonJob>,
}

impl DaemonLaneSenders {
    pub fn send(&self, job: DaemonJob) -> Result<(), SendError<DaemonJob>> {
        if job.command == "--preview-render-image" {
            return self.preview_render.send(job);
        }
        match job.lane {
            DaemonLane::Foreground => self.foreground.send(job),
            DaemonLane::Preview => self.preview.send(job),
            DaemonLane::Scan => self.scan.send(job),
            DaemonLane::Write => self.write.send(job),
            DaemonLane::Maintenance => self.maintenance.send(job),
            DaemonLane::Activation => self.activation.send(job),
            DaemonLane::Background => self.background.send(job),
        }
    }
}

// Only independent image renders use this pool. Preview cache/index commands
// stay on the original serial receiver.
pub type SharedJobReceiver = Arc<Mutex<Receiver<DaemonJob>>>;

pub fn receive_job(receiver: &SharedJobReceiver) -> Result<DaemonJob, RecvError> {
    receiver.lock().expect("daemon receiver poisoned").recv()
}

pub fn spawn_preview_render_workers(
    receiver: Receiver<DaemonJob>,
    worker: impl Fn(SharedJobReceiver) + Send + Sync + 'static,
) -> Vec<JoinHandle<()>> {
    let receiver = Arc::new(Mutex::new(receiver));
    let worker = Arc::new(worker);
    (0..10).map(|_| {
        let receiver = Arc::clone(&receiver);
        let worker = Arc::clone(&worker);
        thread::spawn(move || worker(receiver))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Condvar};
    use std::time::Duration;

    #[test]
    fn preview_pool_has_ten_slots_and_releases_receive_lock() {
        let (sender, receiver) = mpsc::channel();
        let (started, observed) = mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let gate = Arc::clone(&release);
        let workers = spawn_preview_render_workers(receiver, move |receiver| {
            while let Ok(job) = receive_job(&receiver) {
                started.send(job.id).unwrap();
                let (lock, wake) = &*gate;
                let guard = lock.lock().unwrap();
                drop(wake.wait_while(guard, |open| !*open).unwrap());
            }
        });
        for i in 0..24 {
            sender.send(DaemonJob { id: i.to_string(), args: vec![], command: "--preview-render-image".into(), lane: DaemonLane::Preview, sequence: i }).unwrap();
        }
        let mut ids = std::collections::HashSet::new();
        let first = (0..10).all(|_| observed.recv_timeout(Duration::from_secs(5)).map(|id| ids.insert(id)).unwrap_or(false));
        let bounded = observed.try_recv().is_err();
        // Always release/join, including on a failed concurrency assertion.
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
        drop(sender);
        for worker in workers { worker.join().unwrap(); }
        ids.extend(observed.try_iter());
        assert!(first, "ten renders must start before any completion");
        assert!(bounded, "eleventh render must wait for a slot");
        assert_eq!(ids.len(), 24, "all queued renders must drain on shutdown");
    }
}
