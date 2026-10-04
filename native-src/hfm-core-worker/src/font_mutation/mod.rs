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
