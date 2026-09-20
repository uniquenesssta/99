mod sqlite;
mod types;

pub use sqlite::{apply_root_index_changes, replace_root_index};
pub(crate) use sqlite::initialize_root_index_db;
pub use types::RootIndexApplyConfig;
