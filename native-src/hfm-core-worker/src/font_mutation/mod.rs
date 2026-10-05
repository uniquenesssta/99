// This is a dedicated, short-lived protocol, never a daemon/RPC command.
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod file_usage;

pub fn run(args: &[String]) -> i32 {
    #[cfg(windows)]
    {
        let result=if args.get(1).is_some_and(|arg|arg=="--font-file-usage") {
            if args.len()!=3 {Err(std::io::Error::other("invalid file usage invocation"))}else{file_usage::run(&args[2])}
        }else{windows::run(args)};
        match result { Ok(()) => 0, Err(error) => { eprintln!("font mutation: {error}"); 2 } }
    }
    #[cfg(not(windows))]
    { let _ = args; 2 }
}

// Read-only pins; no registry, resources, attributes or deletion APIs are called.
pub fn pin_recovery_file(path: &str, physical: &str, sha256: &str) -> std::io::Result<std::fs::File> {
    #[cfg(windows)] { windows::pin_recovery_file(path, physical, sha256) }
    #[cfg(not(windows))] { let _ = (path, physical, sha256); Err(std::io::Error::other("Windows recovery pins required")) }
}
