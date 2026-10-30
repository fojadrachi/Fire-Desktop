#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Fire Desktop – 24fire-KVM-Server verwalten.

mod app;
mod discord;
mod fire;
mod mc;
mod mcp;
mod ssh;
mod store;
mod updater;

slint::include_modules!();

use slint::ComponentHandle;

fn main() -> Result<(), slint::PlatformError> {
    let window = AppWindow::new()?;
    window.window().set_size(slint::LogicalSize::new(1360.0, 860.0));
    app::run(&window);
    window.run()
}
