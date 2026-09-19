use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Identity { pub device: String, pub inode: String, pub sha1: String, pub size: u64 }

pub(crate) fn identify(file: &mut File) -> io::Result<Identity> {
    let before = file.metadata()?;
    if !before.is_file() { return Err(io::Error::other("not a regular file")); }
    let (device, inode) = file_id(file)?;
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha1::new();
    let mut buffer = [0u8; 65536];
    loop { let count = file.read(&mut buffer)?; if count == 0 { break; } hash.update(&buffer[..count]); }
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? { return Err(io::Error::other("file changed while identifying")); }
    Ok(Identity { device, inode, sha1: format!("{:x}", hash.finalize()), size: after.len() })
}
#[cfg(unix)]
pub(crate) fn file_id(file: &File) -> io::Result<(String,String)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev().to_string(),metadata.ino().to_string()))
}
#[cfg(windows)]
pub(crate) fn file_id(file: &File) -> io::Result<(String,String)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct Information { attributes:u32, creation:[u32;2], access:[u32;2], write:[u32;2], volume:u32, size_high:u32, size_low:u32, links:u32, index_high:u32, index_low:u32 }
    #[link(name="kernel32")]
    extern "system" { fn GetFileInformationByHandle(handle:*mut std::ffi::c_void, info:*mut Information) -> i32; }
    let mut info=Information::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 { return Err(io::Error::last_os_error()); }
    Ok((info.volume.to_string(), (((info.index_high as u64)<<32)|info.index_low as u64).to_string()))
}
#[cfg(not(any(unix,windows)))]
pub(crate) fn file_id(_file: &File) -> io::Result<(String,String)> { Err(io::Error::other("unsupported file identity platform")) }

pub(crate) fn inspect(path: &Path) -> io::Result<Identity> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() { return Err(io::Error::other("symbolic link is not a managed font")); }
    identify(&mut File::open(path)?)
}

pub(crate) fn remove_owned(path: &Path, expected: &Identity) -> io::Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() { return Err(io::Error::other("refusing linked font")); }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        // The handle denies replacement until disposition targets this exact file.
        let mut file = fs::OpenOptions::new().read(true).access_mode(0x80000000 | 0x00010000).share_mode(0).open(path)?;
        if identify(&mut file)? != *expected { return Err(io::Error::other("managed font identity changed")); }
        #[link(name="kernel32")]
        extern "system" { fn SetFileInformationByHandle(handle:*mut std::ffi::c_void, class:u32, info:*const std::ffi::c_void, size:u32) -> i32; }
        let delete:u8=1;
        if unsafe { SetFileInformationByHandle(file.as_raw_handle(), 4, &delete as *const _ as _, 1) } == 0 { return Err(io::Error::last_os_error()); }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if inspect(path)? != *expected { return Err(io::Error::other("managed font identity changed")); }
        fs::remove_file(path)
    }
}
