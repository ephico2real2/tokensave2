//! The dashboard page's files, embedded at compile time from
//! `dashboard/dist/` by `build.rs`: `(path, bytes)` pairs, the path relative
//! to `dist/` with `/` separators. Empty when the page was not built, and the
//! server then answers `/` with 503.

include!(concat!(env!("OUT_DIR"), "/dashboard_assets.rs"));

/// A short value that changes when any of `assets` does. An open page compares
/// it across refreshes to tell that a new build runs under it, so it needs only
/// to differ, not to resist collisions on purpose.
pub fn version(assets: &[(&str, &[u8])]) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    assets.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::version;

    #[test]
    fn the_version_follows_every_file_of_the_page() {
        let one: &[(&str, &[u8])] = &[("app.js", b"one"), ("app.css", b"same")];
        let same: &[(&str, &[u8])] = &[("app.js", b"one"), ("app.css", b"same")];
        let js: &[(&str, &[u8])] = &[("app.js", b"two"), ("app.css", b"same")];
        let css: &[(&str, &[u8])] = &[("app.js", b"one"), ("app.css", b"new")];
        assert_eq!(version(one), version(same));
        assert_ne!(version(one), version(js));
        assert_ne!(version(one), version(css));
    }
}
