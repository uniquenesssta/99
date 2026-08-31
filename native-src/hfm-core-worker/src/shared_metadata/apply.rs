use super::state_machine::apply_shared_metadata_state_machine;
use super::types::SharedMetadataCommandConfig;

pub fn apply_shared_metadata(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    apply_shared_metadata_state_machine(config)
}
