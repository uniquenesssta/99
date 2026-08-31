use crate::family::FontFamilyHint;
use crate::font_parser::{FontNameInfo, FontScriptInfo, FontStyleInfo};

#[derive(Clone, Debug)]
pub struct FontFileEntry {
    pub path: String,
    pub size: u64,
    pub modified_ms: u128,
    pub created_ms: u128,
    pub changed_ms: u128,
    pub signature_valid: bool,
    pub format: String,
    pub quick_hash: String,
    pub content_hash: String,
    pub hash_kind: String,
    pub name_hint: Option<FontNameInfo>,
    pub script_hint: Option<FontScriptInfo>,
    pub style_hint: Option<FontStyleInfo>,
    pub family_hint: Option<FontFamilyHint>,
}

#[derive(Clone, Debug)]
pub struct DirectoryEntry {
    pub path: String,
    pub modified_ms: u128,
    pub file_count: usize,
    pub dir_count: usize,
}

#[derive(Clone, Debug)]
pub struct ListFontFilesResult {
    pub files: Vec<FontFileEntry>,
    pub directories: Vec<DirectoryEntry>,
    pub errors: Vec<(String, String)>,
    pub truncated: bool,
}
