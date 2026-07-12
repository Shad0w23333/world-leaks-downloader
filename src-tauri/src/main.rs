#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    world_leaks_downloader::run();
}
