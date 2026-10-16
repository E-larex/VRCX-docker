use std::fs;
use std::path::{Path, PathBuf};

use vrcx_0_application::profile::{
    BackgroundImageCustomSource, BackgroundImageCustomSourceKind, BackgroundImageFileResolver,
};
use vrcx_0_application_core::Error;

use crate::HostFileAccess;

pub const BACKGROUND_IMAGE_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];
const MAX_BACKGROUND_IMAGE_FOLDER_DEPTH: usize = 10;
const MAX_BACKGROUND_IMAGE_FOLDER_ENTRIES: usize = 100_000;

fn has_background_image_extension(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    BACKGROUND_IMAGE_EXTENSIONS
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
}

fn is_background_image_file(path: &Path) -> bool {
    path.is_file() && has_background_image_extension(path)
}

fn should_traverse_directory(path: &Path, file_type: &fs::FileType) -> bool {
    if !file_type.is_dir() || file_type.is_symlink() {
        return false;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        fs::symlink_metadata(path)
            .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0)
            .unwrap_or(false)
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        true
    }
}

fn background_image_files_in_folder(folder: &Path) -> Result<Vec<String>, Error> {
    if !folder.is_dir() {
        return Err(Error::Custom(
            "Background image folder is not available.".into(),
        ));
    }

    let mut files = Vec::new();
    let mut directories = vec![(folder.to_path_buf(), 0usize)];
    let mut scanned_entries = 0usize;
    while let Some((directory, depth)) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if depth == 0 => return Err(Error::from(error)),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            scanned_entries += 1;
            if scanned_entries > MAX_BACKGROUND_IMAGE_FOLDER_ENTRIES {
                return Err(Error::Custom(
                    "Background image folder contains too many entries to scan.".into(),
                ));
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_file() && has_background_image_extension(&path) {
                files.push(path.to_string_lossy().to_string());
            } else if depth < MAX_BACKGROUND_IMAGE_FOLDER_DEPTH
                && should_traverse_directory(&path, &file_type)
            {
                directories.push((path, depth + 1));
            }
        }
    }
    files.sort_by_key(|path| path.to_ascii_lowercase());
    Ok(files)
}

pub fn background_image_files_from_paths(paths: Vec<String>) -> Vec<String> {
    let mut files: Vec<String> = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| is_background_image_file(path))
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    files.sort_by_key(|path| path.to_ascii_lowercase());
    files.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    files
}

pub struct HostBackgroundImageFileResolver {
    host_file_access: HostFileAccess,
}

impl HostBackgroundImageFileResolver {
    pub fn new(host_file_access: HostFileAccess) -> Self {
        Self { host_file_access }
    }
}

impl BackgroundImageFileResolver for HostBackgroundImageFileResolver {
    fn resolve_files(&self, source: &BackgroundImageCustomSource) -> Result<Vec<String>, Error> {
        // Validate the complete selection before scanning or granting any path.
        // Desktop selections remain unrestricted; the Web host supplies a fixed root.
        let paths = match source.kind {
            BackgroundImageCustomSourceKind::Folder => std::slice::from_ref(&source.folder_path),
            BackgroundImageCustomSourceKind::Files => source.paths.as_slice(),
        };
        for path in paths {
            self.host_file_access
                .ensure_selection_allowed(Path::new(path))
                .map_err(|error| Error::Custom(error.to_string()))?;
        }
        match source.kind {
            BackgroundImageCustomSourceKind::Folder => {
                let folder = PathBuf::from(&source.folder_path);
                self.host_file_access.register_path(&folder);
                background_image_files_in_folder(&folder)
            }
            BackgroundImageCustomSourceKind::Files => {
                let files = background_image_files_from_paths(source.paths.clone());
                for file in &files {
                    self.host_file_access.register_path(file);
                }
                Ok(files)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new() -> Self {
            let sequence = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "vrcx-0-background-image-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn create_file(&self, relative_path: &str) -> PathBuf {
            let mut path = self.path.clone();
            for component in relative_path.split('/') {
                path.push(component);
            }
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, b"image").unwrap();
            path
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn folder_scan_includes_supported_images_in_subfolders() {
        let directory = TestDirectory::new();
        let root_image = directory.create_file("root.jpg");
        let nested_image = directory.create_file("nested/B.PNG");
        let deep_image = directory.create_file("nested/deep/c.webp");
        directory.create_file("nested/notes.txt");

        let files = background_image_files_in_folder(directory.path()).unwrap();
        let mut expected = vec![root_image, nested_image, deep_image]
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        expected.sort_by_key(|path| path.to_ascii_lowercase());
        assert_eq!(files, expected);
    }

    #[test]
    fn folder_scan_stops_at_the_internal_depth_limit() {
        let directory = TestDirectory::new();
        let mut included_directory = directory.path().to_path_buf();
        for _ in 0..MAX_BACKGROUND_IMAGE_FOLDER_DEPTH {
            included_directory.push("d");
        }
        fs::create_dir_all(&included_directory).unwrap();
        let included_image = included_directory.join("included.jpg");
        fs::write(&included_image, b"image").unwrap();
        let excluded_directory = included_directory.join("x");
        fs::create_dir_all(&excluded_directory).unwrap();
        fs::write(excluded_directory.join("excluded.jpg"), b"image").unwrap();

        assert_eq!(
            background_image_files_in_folder(directory.path()).unwrap(),
            vec![included_image.to_string_lossy().to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn folder_scan_does_not_follow_symbolic_link_cycles() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new();
        let image = directory.create_file("nested/image.jpg");
        symlink(directory.path(), directory.path().join("nested/loop")).unwrap();

        assert_eq!(
            background_image_files_in_folder(directory.path()).unwrap(),
            vec![image.to_string_lossy().to_string()]
        );
    }
}
