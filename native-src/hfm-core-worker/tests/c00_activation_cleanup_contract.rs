#[cfg(windows)]
mod windows_baseline {
    use serde_json::{json, Value};
    use std::{fs, path::PathBuf, process::Command, time::{SystemTime, UNIX_EPOCH}};

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn current_cleanup_contract_rejects_the_registry_name_created_by_activation() {
        let dir = Fixture(std::env::temp_dir().join(format!(
            "hfm-c00-activation-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        )));
        fs::create_dir_all(&dir.0).unwrap();
        let managed = dir.0.join("字体管理器_ACTIVE_fixture.ttf");
        fs::write(&managed, b"fixture").unwrap();
        let input = dir.0.join("input.json");
        let registry_name = "方正粗圆_GBK (TrueType) [fixture-session]";
        fs::write(&input, serde_json::to_vec(&json!({
            "inspects": [managed],
            "registryExpectations": { registry_name: managed },
            "allowedDeleteDir": dir.0,
            "allowedNamePrefix": "字体管理器_ACTIVE_"
        })).unwrap()).unwrap();

        let output = Command::new(env!("CARGO_BIN_EXE_hfm-core-worker"))
            .arg("--font-activation-files").arg("--input").arg(&input)
            .output().unwrap();
        assert!(!output.status.success(), "C-00 baseline unexpectedly accepted the cleanup contract");
        let body: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["message"], "unsafe registry ownership request");
        // The current failure occurs before any registry read/delete side effect.
    }
}

#[cfg(not(windows))]
#[test]
fn c00_activation_cleanup_contract_is_windows_only() {
    eprintln!("C-00 native registry ownership observer requires Windows; skipped on this platform.");
}
