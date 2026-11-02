use codex_utils_absolute_path::AbsolutePathBuf;
#[cfg(not(windows))]
use dirs::home_dir;
use std::path::PathBuf;

/// Returns the path to the Codex configuration directory, which can be
/// specified by the `CODEX_HOME` environment variable. If not set, defaults to
/// `~/.codex` — except on Windows, where this Crossline fork defaults to
/// Crossline's own home (see `crossline_default_home`), so a fork binary started
/// without `CODEX_HOME` never opens the official Codex app's `~/.codex`.
///
/// - If `CODEX_HOME` is set, the value must exist and be a directory. The
///   value will be canonicalized and this function will Err otherwise.
/// - If `CODEX_HOME` is not set, this function does not verify that the
///   directory exists.
pub fn find_codex_home() -> std::io::Result<AbsolutePathBuf> {
    let codex_home_env = std::env::var("CODEX_HOME")
        .ok()
        .filter(|val| !val.is_empty());
    find_codex_home_from_env(codex_home_env.as_deref())
}

fn find_codex_home_from_env(codex_home_env: Option<&str>) -> std::io::Result<AbsolutePathBuf> {
    // Honor the `CODEX_HOME` environment variable when it is set to allow users
    // (and tests) to override the default location.
    match codex_home_env {
        Some(val) => {
            let path = PathBuf::from(val);
            let metadata = std::fs::metadata(&path).map_err(|err| match err.kind() {
                std::io::ErrorKind::NotFound => std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("CODEX_HOME points to {val:?}, but that path does not exist"),
                ),
                _ => std::io::Error::new(
                    err.kind(),
                    format!("failed to read CODEX_HOME {val:?}: {err}"),
                ),
            })?;

            if !metadata.is_dir() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("CODEX_HOME points to {val:?}, but that path is not a directory"),
                ))
            } else {
                let canonical = path.canonicalize().map_err(|err| {
                    std::io::Error::new(
                        err.kind(),
                        format!("failed to canonicalize CODEX_HOME {val:?}: {err}"),
                    )
                })?;
                AbsolutePathBuf::from_absolute_path(canonical)
            }
        }
        #[cfg(windows)]
        None => crossline_default_home(
            std::env::var_os("CROSSLINE_STATE_DIR").as_deref(),
            std::env::var_os("LOCALAPPDATA").as_deref(),
            std::env::var_os("USERPROFILE").as_deref(),
        ),
        #[cfg(not(windows))]
        None => {
            let mut p = home_dir().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Could not find home directory",
                )
            })?;
            p.push(".codex");
            AbsolutePathBuf::from_absolute_path(p)
        }
    }
}

/// Crossline fork: the home used when `CODEX_HOME` is unset. Same rule as
/// `codexProcessEnvironment` in `packages/codex/src/index.ts`:
/// `%CROSSLINE_STATE_DIR%\codex-home`, else `%LOCALAPPDATA%\Crossline\codex-home`,
/// where an MSIX-redirected LOCALAPPDATA (`...\Packages\<pkg>\LocalCache\Local`)
/// is replaced by `%USERPROFILE%\AppData\Local`.
///
/// The fork's Windows migration-checksum repair rewrites the official app's
/// checksums, so the fork must never fall back to the official `~/.codex`.
#[cfg(windows)]
fn crossline_default_home(
    state_dir: Option<&std::ffi::OsStr>,
    local_app_data: Option<&std::ffi::OsStr>,
    user_profile: Option<&std::ffi::OsStr>,
) -> std::io::Result<AbsolutePathBuf> {
    let non_empty = |value: Option<&std::ffi::OsStr>| {
        value
            .map(|value| value.to_string_lossy().trim().to_string())
            .filter(|value| !value.is_empty())
    };
    if let Some(state_dir) = non_empty(state_dir) {
        return AbsolutePathBuf::from_absolute_path(PathBuf::from(state_dir).join("codex-home"));
    }
    let local_app_data = non_empty(local_app_data).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "CODEX_HOME is not set and LOCALAPPDATA is unavailable",
        )
    })?;
    let lower = local_app_data.trim_end_matches(['\\', '/']).to_lowercase();
    let segments: Vec<&str> = lower.split(['\\', '/']).collect();
    let is_packaged_redirect = segments.len() >= 4
        && segments[segments.len() - 4] == "packages"
        && segments[segments.len() - 2] == "localcache"
        && segments[segments.len() - 1] == "local";
    let durable = match non_empty(user_profile) {
        Some(profile) if is_packaged_redirect => {
            PathBuf::from(profile).join("AppData").join("Local")
        }
        _ => PathBuf::from(local_app_data),
    };
    AbsolutePathBuf::from_absolute_path(durable.join("Crossline").join("codex-home"))
}

#[cfg(test)]
mod tests {
    use super::find_codex_home_from_env;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use dirs::home_dir;
    use pretty_assertions::assert_eq;
    use std::fs;
    use std::io::ErrorKind;
    use tempfile::TempDir;

    #[test]
    fn find_codex_home_env_missing_path_is_fatal() {
        let temp_home = TempDir::new().expect("temp home");
        let missing = temp_home.path().join("missing-codex-home");
        let missing_str = missing
            .to_str()
            .expect("missing codex home path should be valid utf-8");

        let err = find_codex_home_from_env(Some(missing_str)).expect_err("missing CODEX_HOME");
        assert_eq!(err.kind(), ErrorKind::NotFound);
        assert!(
            err.to_string().contains("CODEX_HOME"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn find_codex_home_env_file_path_is_fatal() {
        let temp_home = TempDir::new().expect("temp home");
        let file_path = temp_home.path().join("codex-home.txt");
        fs::write(&file_path, "not a directory").expect("write temp file");
        let file_str = file_path
            .to_str()
            .expect("file codex home path should be valid utf-8");

        let err = find_codex_home_from_env(Some(file_str)).expect_err("file CODEX_HOME");
        assert_eq!(err.kind(), ErrorKind::InvalidInput);
        assert!(
            err.to_string().contains("not a directory"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn find_codex_home_env_valid_directory_canonicalizes() {
        let temp_home = TempDir::new().expect("temp home");
        let temp_str = temp_home
            .path()
            .to_str()
            .expect("temp codex home path should be valid utf-8");

        let resolved = find_codex_home_from_env(Some(temp_str)).expect("valid CODEX_HOME");
        let expected = temp_home
            .path()
            .canonicalize()
            .expect("canonicalize temp home");
        let expected = AbsolutePathBuf::from_absolute_path(expected).expect("absolute home");
        assert_eq!(resolved, expected);
    }

    #[cfg(windows)]
    #[test]
    fn find_codex_home_without_env_never_uses_official_dot_codex() {
        let resolved =
            find_codex_home_from_env(/*codex_home_env*/ None).expect("default CODEX_HOME");
        let mut official = home_dir().expect("home dir");
        official.push(".codex");
        assert_ne!(resolved.as_path(), official.as_path());
        assert!(resolved.as_path().ends_with("codex-home"));
    }

    #[cfg(windows)]
    #[test]
    fn crossline_default_home_follows_codex_process_environment() {
        use super::crossline_default_home;
        use std::ffi::OsStr;
        use std::path::PathBuf;
        let home = |state: Option<&str>, local: Option<&str>, profile: Option<&str>| {
            crossline_default_home(
                state.map(OsStr::new),
                local.map(OsStr::new),
                profile.map(OsStr::new),
            )
        };
        let path = |result: std::io::Result<AbsolutePathBuf>| {
            result.expect("home").as_path().to_path_buf()
        };
        assert_eq!(
            path(home(Some(r"D:\state"), Some(r"C:\Users\u\AppData\Local"), None)),
            PathBuf::from(r"D:\state\codex-home")
        );
        assert_eq!(
            path(home(None, Some(r"C:\Users\u\AppData\Local"), Some(r"C:\Users\u"))),
            PathBuf::from(r"C:\Users\u\AppData\Local\Crossline\codex-home")
        );
        assert_eq!(
            path(home(
                Some("  "),
                Some(r"C:\Users\u\AppData\Local\Packages\OpenAI.Codex_x\LocalCache\Local"),
                Some(r"C:\Users\u"),
            )),
            PathBuf::from(r"C:\Users\u\AppData\Local\Crossline\codex-home")
        );
        assert_eq!(
            home(None, None, Some(r"C:\Users\u"))
                .expect_err("no LOCALAPPDATA")
                .kind(),
            ErrorKind::NotFound
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn find_codex_home_without_env_uses_default_home_dir() {
        let resolved =
            find_codex_home_from_env(/*codex_home_env*/ None).expect("default CODEX_HOME");
        let mut expected = home_dir().expect("home dir");
        expected.push(".codex");
        let expected = AbsolutePathBuf::from_absolute_path(expected).expect("absolute home");
        assert_eq!(resolved, expected);
    }
}
