use super::state_machine::remove_shared_metadata_tag_state_machine;
use super::types::SharedMetadataCommandConfig;

pub fn remove_shared_metadata_tag(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    remove_shared_metadata_tag_state_machine(config)
}
