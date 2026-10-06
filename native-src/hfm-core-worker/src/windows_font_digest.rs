// Shared read-only SHA-256 implementation. No registration or mutation effects.
use std::{ffi::c_void, io::{self, Read}, ptr};
type Handle = *mut c_void;
#[link(name="bcrypt")] extern "system" {
    fn BCryptOpenAlgorithmProvider(out:*mut Handle, name:*const u16, implementation:*const u16, flags:u32)->i32;
    fn BCryptCreateHash(algorithm:Handle, out:*mut Handle, object:*mut u8, size:u32, secret:*const u8, secret_size:u32, flags:u32)->i32;
    fn BCryptHashData(hash:Handle, data:*const u8, size:u32, flags:u32)->i32;
    fn BCryptFinishHash(hash:Handle, output:*mut u8, size:u32, flags:u32)->i32;
    fn BCryptDestroyHash(hash:Handle)->i32;
    fn BCryptCloseAlgorithmProvider(algorithm:Handle, flags:u32)->i32;
}
pub fn sha256(mut file: impl Read, limit: u64) -> io::Result<(String, u64)> {
    struct Hash(Handle,Handle);
    impl Drop for Hash { fn drop(&mut self) { unsafe {
        if !self.1.is_null() { BCryptDestroyHash(self.1); }
        BCryptCloseAlgorithmProvider(self.0,0);
    } } }
    unsafe {
        let name: Vec<u16> = "SHA256".encode_utf16().chain(Some(0)).collect();
        let mut algorithm = ptr::null_mut();
        if BCryptOpenAlgorithmProvider(&mut algorithm,name.as_ptr(),ptr::null(),0)<0 { return Err(io::Error::other("SHA256 provider unavailable")); }
        let mut hash = Hash(algorithm,ptr::null_mut());
        if BCryptCreateHash(algorithm,&mut hash.1,ptr::null_mut(),0,ptr::null(),0,0)<0 { return Err(io::Error::other("SHA256 allocation failed")); }
        let mut buffer = [0u8;65536];
        let mut bytes = 0u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 { break; }
            bytes = bytes.checked_add(count as u64).ok_or_else(||io::Error::other("font byte count overflow"))?;
            if bytes > limit { return Err(io::Error::other("font read size exceeded")); }
            if BCryptHashData(hash.1,buffer.as_ptr(),count as u32,0)<0 { return Err(io::Error::other("SHA256 read failed")); }
        }
        let mut output = [0u8;32];
        if BCryptFinishHash(hash.1,output.as_mut_ptr(),32,0)<0 { return Err(io::Error::other("SHA256 finish failed")); }
        Ok((output.iter().map(|value|format!("{value:02x}")).collect(),bytes))
    }
}
