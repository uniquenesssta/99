//! Shared Win32 ABI declarations used by font identity and registry operations.
use std::ffi::c_void;
pub(crate) type Handle = *mut c_void;
#[repr(C)] #[derive(Default)]
pub(crate) struct FileTime { pub low:u32, pub high:u32 }
#[repr(C)] #[derive(Default)]
pub(crate) struct FileInformation {
    pub attributes:u32, pub created:FileTime, pub accessed:FileTime, pub modified:FileTime,
    pub volume:u32, pub size_high:u32, pub size_low:u32, pub links:u32,
    pub index_high:u32, pub index_low:u32,
}
#[link(name="kernel32")] extern "system" {
    pub(crate) fn GetFileInformationByHandle(file:Handle, info:*mut FileInformation)->i32;
    pub(crate) fn SetFileInformationByHandle(file:Handle, class:u32, data:*const c_void, size:u32)->i32;
}
#[link(name="advapi32")] extern "system" {
    pub(crate) fn RegOpenKeyExW(root:Handle, subkey:*const u16, options:u32, access:u32, out:*mut Handle)->i32;
    pub(crate) fn RegDeleteValueW(key:Handle, name:*const u16)->i32;
    pub(crate) fn RegCloseKey(key:Handle)->i32;
}
