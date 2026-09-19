mod sqlite;
mod types;

pub use sqlite::apply_root_index_changes;
pub(crate) use sqlite::initialize_root_index_db;
pub use types::RootIndexApplyConfig;
