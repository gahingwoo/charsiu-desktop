// SPDX-License-Identifier: GPL-2.0-only
// no console window behind the app on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    charsiu_desktop_lib::run();
}
