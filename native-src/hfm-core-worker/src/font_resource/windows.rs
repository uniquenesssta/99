use super::types::{FontRegistryRecord, FontResourceBatchRow};

#[cfg(windows)]
mod platform {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::raw::c_void;
    use std::os::windows::ffi::OsStrExt;

    use super::{FontRegistryRecord, FontResourceBatchRow};

    type Bool = i32;
    type Dword = u32;
    type Long = i32;
    type Hkey = isize;

    const HWND_BROADCAST: *mut c_void = 0xffffusize as *mut c_void;
    const WM_FONTCHANGE: u32 = 0x001D;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    const REG_SZ: u32 = 1;
    const KEY_SET_VALUE: u32 = 0x0002;
    const ERROR_SUCCESS: i32 = 0;
    const HKEY_CURRENT_USER: Hkey = 0x80000001u32 as i32 as isize;
    const HKCU_FONT_REGISTRY_KEY: &str = "Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn AddFontResourceExW(lpsz_filename: *const u16, fl: Dword, pdv: *mut c_void) -> i32;
        fn RemoveFontResourceExW(lpsz_filename: *const u16, fl: Dword, pdv: *mut c_void) -> Bool;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SendNotifyMessageW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> Bool;
        fn PostMessageW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> Bool;
        fn SendMessageTimeoutW(
            hwnd: *mut c_void,
            msg: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegCreateKeyExW(
            hkey: Hkey,
            sub_key: *const u16,
            reserved: Dword,
            class: *mut u16,
            options: Dword,
            sam_desired: Dword,
            security_attributes: *mut c_void,
            result: *mut Hkey,
            disposition: *mut Dword,
        ) -> Long;
        fn RegSetValueExW(
            hkey: Hkey,
            value_name: *const u16,
            reserved: Dword,
            value_type: Dword,
            data: *const u8,
            data_len: Dword,
        ) -> Long;
        fn RegDeleteValueW(hkey: Hkey, value_name: *const u16) -> Long;
        fn RegCloseKey(hkey: Hkey) -> Long;
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(once(0)).collect()
    }

    pub fn notify_font_change(strong: bool) -> Result<(), String> {
        unsafe {
            if strong {
                let mut result: usize = 0;
                let _ = SendMessageTimeoutW(
                    HWND_BROADCAST,
                    WM_FONTCHANGE,
                    0,
                    0,
                    SMTO_ABORTIFHUNG,
                    900,
                    &mut result as *mut usize,
                );
            }
            let sent = SendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
            let _ = PostMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
            if sent == 0 && strong {
                return Err("WM_FONTCHANGE notify failed".to_string());
            }
        }
        Ok(())
    }

    pub fn add_font_resources(paths: &[String]) -> Vec<FontResourceBatchRow> {
        let mut rows = Vec::with_capacity(paths.len());
        for path in paths {
            let wide_path = wide(path);
            let count = unsafe { AddFontResourceExW(wide_path.as_ptr(), 0, std::ptr::null_mut()) };
            let ok = count > 0;
            rows.push(FontResourceBatchRow {
                path: path.clone(),
                ok,
                count: if count > 0 { count as u32 } else { 0 },
                message: if ok { "ok".to_string() } else { "AddFontResourceExW failed".to_string() },
            });
        }
        rows
    }

    pub fn remove_font_resources(paths: &[String]) -> Vec<FontResourceBatchRow> {
        let mut rows = Vec::with_capacity(paths.len());
        for path in paths {
            let wide_path = wide(path);
            let mut count: u32 = 0;
            for _ in 0..8 {
                let removed = unsafe { RemoveFontResourceExW(wide_path.as_ptr(), 0, std::ptr::null_mut()) };
                if removed == 0 {
                    break;
                }
                count += 1;
            }
            rows.push(FontResourceBatchRow {
                path: path.clone(),
                ok: count > 0,
                count,
                message: if count > 0 { "ok".to_string() } else { "RemoveFontResourceExW failed".to_string() },
            });
        }
        rows
    }

    fn open_fonts_key() -> Result<Hkey, String> {
        let mut key: Hkey = 0;
        let mut disposition: Dword = 0;
        let sub_key = wide(HKCU_FONT_REGISTRY_KEY);
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                sub_key.as_ptr(),
                0,
                std::ptr::null_mut(),
                0,
                KEY_SET_VALUE,
                std::ptr::null_mut(),
                &mut key as *mut Hkey,
                &mut disposition as *mut Dword,
            )
        };
        if status != ERROR_SUCCESS || key == 0 {
            return Err(format!("RegCreateKeyExW failed: {}", status));
        }
        Ok(key)
    }

    pub fn apply_registry_records(records: &[FontRegistryRecord]) -> Result<(usize, usize), String> {
        if records.is_empty() {
            return Ok((0, 0));
        }
        let key = open_fonts_key()?;
        let mut count = 0usize;
        let mut failed = 0usize;
        for record in records {
            if record.name.trim().is_empty() || record.path.trim().is_empty() {
                failed += 1;
                continue;
            }
            let name = wide(&record.name);
            let path = wide(&record.path);
            let bytes = (path.len() * 2) as Dword;
            let status = unsafe {
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    path.as_ptr() as *const u8,
                    bytes,
                )
            };
            if status == ERROR_SUCCESS {
                count += 1;
            } else {
                failed += 1;
            }
        }
        unsafe { RegCloseKey(key); }
        Ok((count, failed))
    }

    pub fn delete_registry_values(names: &[String]) -> Result<usize, String> {
        if names.is_empty() {
            return Ok(0);
        }
        let key = open_fonts_key()?;
        let mut count = 0usize;
        for name in names {
            if name.trim().is_empty() {
                continue;
            }
            let wide_name = wide(name);
            let status = unsafe { RegDeleteValueW(key, wide_name.as_ptr()) };
            if status == ERROR_SUCCESS {
                count += 1;
            }
        }
        unsafe { RegCloseKey(key); }
        Ok(count)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{FontRegistryRecord, FontResourceBatchRow};

    pub fn notify_font_change(_strong: bool) -> Result<(), String> {
        Err("font resource commands are only supported on Windows".to_string())
    }

    pub fn add_font_resources(paths: &[String]) -> Vec<FontResourceBatchRow> {
        paths.iter().map(|path| FontResourceBatchRow {
            path: path.clone(),
            ok: false,
            count: 0,
            message: "font resource commands are only supported on Windows".to_string(),
        }).collect()
    }

    pub fn remove_font_resources(paths: &[String]) -> Vec<FontResourceBatchRow> {
        add_font_resources(paths)
    }

    pub fn apply_registry_records(_records: &[FontRegistryRecord]) -> Result<(usize, usize), String> {
        Err("font registry commands are only supported on Windows".to_string())
    }

    pub fn delete_registry_values(_names: &[String]) -> Result<usize, String> {
        Err("font registry commands are only supported on Windows".to_string())
    }
}

pub use platform::*;
