// Shared Unicode registry reader for installation discovery and mutation checks.
mod value;
mod windows;
pub(crate) use value::decode;
pub(crate) use windows::read;

pub(crate) struct Entry {
    pub scope: &'static str,
    pub name: String,
    pub value: String,
}
