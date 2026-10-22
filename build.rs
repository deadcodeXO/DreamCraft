fn main() {
    println!("cargo:rerun-if-changed=assets/dreamcraft.ico");

    #[cfg(windows)]
    {
        let mut resources = winres::WindowsResource::new();
        resources
            .set_icon("assets/dreamcraft.ico")
            .set("FileDescription", "DreamCraft Web Design Studio")
            .set("ProductName", "DreamCraft")
            .set("InternalName", "DreamCraft")
            .set("OriginalFilename", "DreamCraft.exe");
        resources
            .compile()
            .expect("failed to embed the DreamCraft Windows application icon");
    }
}
