// This is a dedicated, short-lived protocol, never a daemon/RPC command.
#[cfg(windows)]
mod windows;

pub fn run(args: &[String]) -> i32 {
    #[cfg(windows)]
    { match windows::run(args) { Ok(()) => 0, Err(error) => { eprintln!("font mutation: {error}"); 2 } } }
    #[cfg(not(windows))]
    { let _ = args; 2 }
}
