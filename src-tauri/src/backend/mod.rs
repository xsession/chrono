#[cfg(not(target_os = "android"))]
mod cli;
#[cfg(target_os = "android")]
mod native;

#[cfg(not(target_os = "android"))]
pub use cli::*;
#[cfg(target_os = "android")]
pub use native::*;
