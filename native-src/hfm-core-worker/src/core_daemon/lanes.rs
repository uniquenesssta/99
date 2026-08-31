use std::sync::mpsc::{SendError, Sender};

use super::types::{DaemonJob, DaemonLane};

pub struct DaemonLaneSenders {
    pub foreground: Sender<DaemonJob>,
    pub preview: Sender<DaemonJob>,
    pub scan: Sender<DaemonJob>,
    pub write: Sender<DaemonJob>,
    pub maintenance: Sender<DaemonJob>,
    pub activation: Sender<DaemonJob>,
    pub background: Sender<DaemonJob>,
}

impl DaemonLaneSenders {
    pub fn send(&self, job: DaemonJob) -> Result<(), SendError<DaemonJob>> {
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
