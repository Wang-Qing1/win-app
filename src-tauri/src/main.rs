// 发布版不弹控制台窗口；debug 版保留，否则崩溃时连堆栈都看不到。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    winbook_lib::run()
}
