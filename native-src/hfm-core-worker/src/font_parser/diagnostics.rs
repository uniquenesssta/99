use serde::Serialize;
use std::io;

pub const MAX_METADATA_DIAGNOSTICS: usize = 16;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MetadataDiagnosticKind {
    IoError,
    InvalidStructure,
    UnsupportedFormat,
    ResourceLimit,
    MissingTable,
    EmptyMetadata,
}

// Diagnostic evidence only: never authorizes bad-font classification or publication.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataDiagnostic {
    pub stage: &'static str,
    pub kind: MetadataDiagnosticKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_index: Option<usize>,
    pub detail: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub io_kind: Option<String>,
}

pub fn record(diagnostics: &mut Vec<MetadataDiagnostic>, stage: &'static str,
    kind: MetadataDiagnosticKind, source_index: Option<usize>, detail: &'static str) {
    if diagnostics.len() < MAX_METADATA_DIAGNOSTICS {
        diagnostics.push(MetadataDiagnostic { stage, kind, source_index, detail, io_kind: None });
    }
}

pub fn record_io(diagnostics: &mut Vec<MetadataDiagnostic>, stage: &'static str,
    source_index: Option<usize>, error: &io::Error) {
    if diagnostics.len() < MAX_METADATA_DIAGNOSTICS {
        diagnostics.push(MetadataDiagnostic { stage, kind: MetadataDiagnosticKind::IoError,
            source_index, detail: "read-or-seek-failed", io_kind: Some(format!("{:?}", error.kind())) });
    }
}
