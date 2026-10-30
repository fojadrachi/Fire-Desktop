fn main() {
    let config = slint_build::CompilerConfiguration::new().with_style("fluent-dark".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("Slint-Oberfläche konnte nicht gebaut werden");

    // App-Icon und Versionsinfos in die .exe
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set("ProductName", "Fire Desktop");
        res.set("FileDescription", "Fire Desktop");
        res.set("CompanyName", "Fojadrachi");
        res.compile().expect("Windows-Ressourcen konnten nicht gebaut werden");
    }
}
