#[cfg(windows)]
mod windows_contract {
    use serde_json::{json, Value};
    use std::{
        fs,
        path::{Path, PathBuf},
        process::{Command, Output},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        root: PathBuf,
        registry_names: Vec<String>,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "hfm-c05-activation-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root, registry_names: Vec::new() }
        }

        fn input(&self, label: &str) -> PathBuf {
            self.root.join(format!("{label}.json"))
        }

        fn worker(&self, command: &str, label: &str, payload: Value) -> Output {
            let input = self.input(label);
            fs::write(&input, serde_json::to_vec(&payload).unwrap()).unwrap();
            Command::new(env!("CARGO_BIN_EXE_hfm-core-worker"))
                .arg(command)
                .arg("--input")
                .arg(&input)
                .output()
                .unwrap()
        }

        fn success(&self, command: &str, label: &str, payload: Value) -> Value {
            let output = self.worker(command, label, payload);
            assert!(
                output.status.success(),
                "{label}: {}",
                String::from_utf8_lossy(&output.stdout)
            );
            let body: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(body["ok"], true, "{label}: {body}");
            body
        }

        fn failure(&self, command: &str, label: &str, payload: Value, message: &str) -> Value {
            let output = self.worker(command, label, payload);
            assert!(!output.status.success(), "{label} unexpectedly succeeded");
            let body: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(body["ok"], false, "{label}: {body}");
            assert!(
                body["message"].as_str().unwrap_or_default().contains(message),
                "{label}: expected {message:?}, got {body}"
            );
            body
        }

        fn managed(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(format!("HFM_ACTIVE_{name}"));
            fs::write(&path, bytes).unwrap();
            path
        }

        fn inspect_identity(&self, path: &Path, label: &str) -> Value {
            let body = self.success(
                "--font-activation-files",
                label,
                json!({
                    "inspects": [path],
                    "allowedDeleteDir": self.root,
                    "allowedNamePrefix": "HFM_ACTIVE_"
                }),
            );
            body["inspectResults"][0]["identity"].clone()
        }

        fn apply_registry(&mut self, name: &str, path: &Path, label: &str) {
            self.success(
                "--font-registry-apply",
                label,
                json!({"records":[{"name":name,"path":path}]}),
            );
            self.registry_names.push(name.to_string());
        }

        fn remove_registry_cleanup(&self, name: &str, label: &str) {
            let _ = self.worker(
                "--font-registry-delete",
                label,
                json!({"names":[name]}),
            );
        }

        fn claim(name: &str, path: &Path, session: &str, identity: Value) -> Value {
            json!({
                "registryName": name,
                "installPath": path,
                "sessionId": session,
                "identity": identity
            })
        }

        fn activation_payload(&self, claim: Value) -> Value {
            json!({
                "registryClaims": [claim],
                "allowedDeleteDir": self.root,
                "allowedNamePrefix": "HFM_ACTIVE_"
            })
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            for (index, name) in self.registry_names.iter().enumerate() {
                self.remove_registry_cleanup(name, &format!("drop-{index}"));
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn c05_registry_ownership_accepts_real_font_names_and_deletes_only_owned_values() {
        let mut fixture = Fixture::new();

        for (index, (base, suffix)) in [
            ("方正粗圆_GBK (TrueType)", "ttf"),
            ("思源黑体 CN (OpenType)", "otf"),
        ].into_iter().enumerate() {
            let session = format!("fixture-session-{index}");
            let managed = fixture.managed(&format!("{index}_{session}.{suffix}"), format!("font-{index}").as_bytes());
            let identity = fixture.inspect_identity(&managed, &format!("inspect-{index}"));
            let registry_name = format!("{base} [{session}]");
            fixture.apply_registry(&registry_name, &managed, &format!("apply-{index}"));

            let claim = Fixture::claim(&registry_name, &managed, &session, identity.clone());
            let verified = fixture.success(
                "--font-activation-files",
                &format!("verify-{index}"),
                fixture.activation_payload(claim.clone()),
            );
            assert_eq!(verified["registryResults"][0]["missing"], false);
            assert_eq!(verified["registryResults"][0]["deleted"], false);

            let mut delete_payload = fixture.activation_payload(claim);
            delete_payload["deleteRegistryClaims"] = json!(true);
            let deleted = fixture.success(
                "--font-activation-files",
                &format!("delete-{index}"),
                delete_payload,
            );
            assert_eq!(deleted["registryResults"][0]["deleted"], true);
            assert!(managed.exists(), "registry settlement must not delete the managed file");
        }
    }

    #[test]
    fn c05_registry_ownership_rejects_forged_external_adjacent_replaced_and_legacy_claims() {
        let mut fixture = Fixture::new();
        let session = "fixture-session-negative";
        let managed = fixture.managed(&format!("negative_{session}.ttf"), b"same bytes");
        let identity = fixture.inspect_identity(&managed, "inspect-negative");
        let registry_name = format!("方正粗圆_GBK (TrueType) [{session}]");
        fixture.apply_registry(&registry_name, &managed, "apply-negative");

        let forged_name = format!("伪造字体 (TrueType) [{session}]");
        fixture.failure(
            "--font-activation-files",
            "forged-name",
            fixture.activation_payload(Fixture::claim(&forged_name, &managed, session, identity.clone())),
            "registry value missing",
        );

        let external = fixture.root.parent().unwrap().join(format!(
            "hfm-c05-external-{}-{}.ttf",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::write(&external, b"external").unwrap();
        fixture.remove_registry_cleanup(&registry_name, "remove-before-external");
        fixture.apply_registry(&registry_name, &external, "apply-external");
        fixture.failure(
            "--font-activation-files",
            "same-name-external",
            fixture.activation_payload(Fixture::claim(&registry_name, &managed, session, identity.clone())),
            "another font",
        );
        let _ = fs::remove_file(&external);

        let sibling_dir = fixture.root.join("neighbor");
        fs::create_dir(&sibling_dir).unwrap();
        let sibling = sibling_dir.join(format!("HFM_ACTIVE_neighbor_{session}.ttf"));
        fs::write(&sibling, b"neighbor").unwrap();
        fixture.failure(
            "--font-activation-files",
            "adjacent-path",
            fixture.activation_payload(Fixture::claim(
                &format!("邻接字体 (TrueType) [{session}]"),
                &sibling,
                session,
                identity.clone(),
            )),
            "unsafe registry ownership request",
        );

        fixture.remove_registry_cleanup(&registry_name, "remove-before-replaced");
        fixture.apply_registry(&registry_name, &managed, "apply-replaced");
        let old_path = fixture.root.join(format!("HFM_ACTIVE_negative_{session}.old"));
        fs::rename(&managed, &old_path).unwrap();
        fs::write(&managed, b"same bytes").unwrap();
        fixture.failure(
            "--font-activation-files",
            "replaced-inode",
            fixture.activation_payload(Fixture::claim(&registry_name, &managed, session, identity.clone())),
            "identity changed",
        );

        fixture.failure(
            "--font-activation-files",
            "old-contract",
            json!({
                "registryExpectations": { registry_name.clone(): managed.clone() },
                "allowedDeleteDir": fixture.root,
                "allowedNamePrefix": "HFM_ACTIVE_"
            }),
            "legacy registry ownership contract rejected",
        );

        fixture.failure(
            "--font-activation-files",
            "old-record-no-session",
            fixture.activation_payload(json!({
                "registryName": registry_name,
                "installPath": managed,
                "sessionId": "",
                "identity": identity
            })),
            "unsafe registry ownership request",
        );
    }
}

#[cfg(not(windows))]
#[test]
fn c00_activation_cleanup_contract_is_windows_only() {
    eprintln!("C-05 native registry ownership contract requires Windows; skipped on this platform.");
}
