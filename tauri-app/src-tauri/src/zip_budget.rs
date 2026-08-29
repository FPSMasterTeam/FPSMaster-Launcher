//! Defensive extraction budgets for untrusted archives.
//!
//! Imported instance/world archives, downloaded installers and mod packages
//! are attacker-controllable inputs. A crafted archive can declare — or
//! actually inflate to — far more data than the launcher should ever
//! materialize, or carry an absurd number of entries, exhausting memory or
//! disk. Every extraction site must pre-flight the archive against a budget
//! before writing anything, and must stream entry bytes through the budget so
//! an entry header that understates its real size cannot bypass the declared
//! check. All checks fail closed.

use std::io::{Read, Seek, Write};
use std::path::Path;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// Hard ceilings for one archive-extraction operation.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ZipExtractBudget {
    /// Maximum number of entries (files + directories) the archive may hold.
    pub(crate) max_entries: usize,
    /// Maximum total uncompressed bytes across all extracted entries.
    pub(crate) max_total_uncompressed_bytes: u64,
}

/// User-imported instance or world archives. Modpack instances legitimately
/// hold tens of thousands of config files and multi-gigabyte worlds, so the
/// ceiling is generous; it only stops pathological archives.
pub(crate) const IMPORT_ARCHIVE_BUDGET: ZipExtractBudget = ZipExtractBudget {
    max_entries: 100_000,
    max_total_uncompressed_bytes: 8 * GIB,
};

/// Vanilla client jars scanned for their bundled asset tree.
pub(crate) const CLIENT_JAR_BUDGET: ZipExtractBudget = ZipExtractBudget {
    max_entries: 100_000,
    max_total_uncompressed_bytes: 2 * GIB,
};

/// Downloaded JRE archives (zip or tar.gz).
pub(crate) const JRE_ARCHIVE_BUDGET: ZipExtractBudget = ZipExtractBudget {
    max_entries: 50_000,
    max_total_uncompressed_bytes: 4 * GIB,
};

/// Launcher mod packages and the nested jars they embed.
pub(crate) const MOD_ARCHIVE_BUDGET: ZipExtractBudget = ZipExtractBudget {
    max_entries: 50_000,
    max_total_uncompressed_bytes: 4 * GIB,
};

/// LWJGL/native jars unpacked before launch; these are only a few megabytes.
pub(crate) const NATIVE_JAR_BUDGET: ZipExtractBudget = ZipExtractBudget {
    max_entries: 10_000,
    max_total_uncompressed_bytes: GIB,
};

/// Single artifacts copied out of a Forge installer (e.g. the universal jar).
pub(crate) const FORGE_INSTALLER_BUDGET: ZipExtractBudget = ZipExtractBudget {
    max_entries: 50_000,
    max_total_uncompressed_bytes: GIB,
};

/// Cap for individual text entries or extracted text files read fully into
/// memory (manifests, JSON profiles, access wideners).
pub(crate) const MAX_TEXT_ENTRY_BYTES: u64 = 16 * MIB;

impl ZipExtractBudget {
    /// Fail-closed pre-flight: rejects the archive before anything is written
    /// when the entry count or the declared uncompressed total is over budget.
    /// Declared sizes can lie, so extraction must additionally stream through
    /// [`ZipBudgetTracker::copy_entry`].
    pub(crate) fn check_archive<R: Read + Seek>(
        &self,
        archive: &mut zip::ZipArchive<R>,
        archive_label: &str,
    ) -> Result<(), String> {
        if archive.len() > self.max_entries {
            return Err(format!(
                "Refusing to extract {archive_label} archive: {} entries exceed the limit of {}",
                archive.len(),
                self.max_entries
            ));
        }
        let mut declared_total: u64 = 0;
        for index in 0..archive.len() {
            let entry = archive.by_index_raw(index).map_err(|e| {
                format!("Failed to inspect {archive_label} archive entry {index}: {e}")
            })?;
            declared_total = declared_total.saturating_add(entry.size());
            if declared_total > self.max_total_uncompressed_bytes {
                return Err(format!(
                    "Refusing to extract {archive_label} archive: declared uncompressed size exceeds the limit of {} bytes",
                    self.max_total_uncompressed_bytes
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn tracker(&self) -> ZipBudgetTracker {
        ZipBudgetTracker {
            remaining_bytes: self.max_total_uncompressed_bytes,
            max_total_uncompressed_bytes: self.max_total_uncompressed_bytes,
        }
    }
}

/// Tracks the byte budget while entries are written out. The pre-flight check
/// trusts declared sizes; this enforces the same ceiling on the bytes actually
/// decompressed, so a lying header aborts mid-extraction instead of filling
/// the disk.
pub(crate) struct ZipBudgetTracker {
    remaining_bytes: u64,
    max_total_uncompressed_bytes: u64,
}

impl ZipBudgetTracker {
    /// Copies one archive entry to `writer` without ever writing more than the
    /// remaining byte budget. `context` names the entry for error messages,
    /// e.g. `instance file config/foo.toml`.
    pub(crate) fn copy_entry<R: Read + ?Sized, W: Write + ?Sized>(
        &mut self,
        reader: &mut R,
        writer: &mut W,
        context: &str,
    ) -> Result<u64, String> {
        let limit = self.remaining_bytes;
        let copied = {
            let mut limited = (&mut *reader).take(limit);
            std::io::copy(&mut limited, writer)
                .map_err(|e| format!("Failed to extract {context}: {e}"))?
        };
        self.remaining_bytes = limit - copied;
        if self.remaining_bytes == 0 {
            // The take() limit was (or already had been) fully consumed; probe
            // whether the entry actually holds more data than the budget allows.
            let mut probe = [0u8; 1];
            let extra = reader
                .read(&mut probe)
                .map_err(|e| format!("Failed to extract {context}: {e}"))?;
            if extra > 0 {
                return Err(format!(
                    "Refusing to extract {context}: archive exceeds the uncompressed budget of {} bytes",
                    self.max_total_uncompressed_bytes
                ));
            }
        }
        Ok(copied)
    }
}

/// Reads a single text entry fully into memory with a hard byte cap, so one
/// entry cannot balloon into unbounded allocation.
pub(crate) fn read_text_entry_bounded<R: Read>(
    reader: &mut R,
    max_bytes: u64,
    context: &str,
) -> Result<String, String> {
    let mut buffer = Vec::new();
    let mut limited = reader.take(max_bytes.saturating_add(1));
    limited
        .read_to_end(&mut buffer)
        .map_err(|e| format!("Failed to read {context}: {e}"))?;
    if buffer.len() as u64 > max_bytes {
        return Err(format!(
            "Refusing to read {context}: entry exceeds the limit of {max_bytes} bytes"
        ));
    }
    String::from_utf8(buffer).map_err(|e| format!("Failed to read {context}: {e}"))
}

/// Opens and reads a text file through the same bounded path used for archive
/// entries. This is used for metadata that may have originated in an imported
/// archive, so extraction limits cannot be bypassed by a later full-file read.
pub(crate) fn read_text_file_bounded(
    path: &Path,
    max_bytes: u64,
    context: &str,
) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to read {context} {}: {e}", path.display()))?;
    read_text_entry_bounded(
        &mut file,
        max_bytes,
        &format!("{context} {}", path.display()),
    )
}

/// Wraps a decompression stream and fails once more than the budgeted number
/// of bytes has been produced. Used for tar.gz extraction, where entries
/// cannot be pre-flighted without decompressing the whole stream.
pub(crate) struct BudgetedReader<R> {
    inner: R,
    remaining: u64,
    max_bytes: u64,
    label: &'static str,
}

impl<R> BudgetedReader<R> {
    pub(crate) fn new(inner: R, max_bytes: u64, label: &'static str) -> Self {
        Self {
            inner,
            remaining: max_bytes,
            max_bytes,
            label,
        }
    }
}

impl<R: Read> Read for BudgetedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        if read as u64 > self.remaining {
            return Err(std::io::Error::other(format!(
                "{} exceeds the uncompressed budget of {} bytes",
                self.label, self.max_bytes
            )));
        }
        self.remaining -= read as u64;
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const TEST_BUDGET: ZipExtractBudget = ZipExtractBudget {
        max_entries: 2,
        max_total_uncompressed_bytes: 64,
    };

    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            for (name, data) in entries {
                writer
                    .start_file(*name, options)
                    .expect("test zip entry should start");
                writer
                    .write_all(data)
                    .expect("test zip entry should be written");
            }
            writer.finish().expect("test zip should be finalized");
        }
        cursor.into_inner()
    }

    fn open_zip(bytes: Vec<u8>) -> zip::ZipArchive<Cursor<Vec<u8>>> {
        zip::ZipArchive::new(Cursor::new(bytes)).expect("test zip should be readable")
    }

    #[test]
    fn check_archive_accepts_archive_within_budget() {
        let mut archive = open_zip(build_zip(&[("a.txt", b"hello"), ("b.txt", b"world")]));
        assert!(TEST_BUDGET.check_archive(&mut archive, "test").is_ok());
    }

    #[test]
    fn check_archive_rejects_too_many_entries() {
        let mut archive = open_zip(build_zip(&[
            ("a.txt", b"a"),
            ("b.txt", b"b"),
            ("c.txt", b"c"),
        ]));
        let error = TEST_BUDGET
            .check_archive(&mut archive, "test")
            .expect_err("entry count over budget should be rejected");
        assert!(error.contains("entries exceed"), "unexpected error: {error}");
    }

    #[test]
    fn check_archive_rejects_declared_size_over_budget() {
        let oversized = vec![b'x'; 128];
        let mut archive = open_zip(build_zip(&[("big.bin", oversized.as_slice())]));
        let error = TEST_BUDGET
            .check_archive(&mut archive, "test")
            .expect_err("declared size over budget should be rejected");
        assert!(
            error.contains("declared uncompressed size"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn copy_entry_extracts_entries_within_budget() {
        let mut archive = open_zip(build_zip(&[("a.txt", b"hello"), ("b.txt", b"world")]));
        let mut tracker = TEST_BUDGET.tracker();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).expect("entry should be readable");
            let mut output = Vec::new();
            let copied = tracker
                .copy_entry(&mut entry, &mut output, "test entry")
                .expect("entry within budget should extract");
            assert_eq!(copied, 5);
            assert_eq!(output.len(), 5);
        }
    }

    #[test]
    fn copy_entry_rejects_stream_larger_than_budget() {
        // Streaming enforcement is independent of ZIP headers, so a plain
        // oversized reader stands in for an entry whose header understates
        // its real size.
        let mut tracker = TEST_BUDGET.tracker();
        let mut reader = Cursor::new(vec![b'x'; 65]);
        let mut output = Vec::new();
        let error = tracker
            .copy_entry(&mut reader, &mut output, "test entry")
            .expect_err("stream over budget should be rejected");
        assert!(
            error.contains("exceeds the uncompressed budget"),
            "unexpected error: {error}"
        );
        assert_eq!(output.len() as u64, TEST_BUDGET.max_total_uncompressed_bytes);
    }

    #[test]
    fn copy_entry_accepts_stream_exactly_at_budget() {
        let mut tracker = TEST_BUDGET.tracker();
        let mut reader = Cursor::new(vec![b'x'; 64]);
        let mut output = Vec::new();
        let copied = tracker
            .copy_entry(&mut reader, &mut output, "test entry")
            .expect("stream exactly at budget should extract");
        assert_eq!(copied, 64);

        // The budget is now exhausted; any further non-empty entry must fail.
        let mut next_reader = Cursor::new(vec![b'y'; 1]);
        assert!(tracker
            .copy_entry(&mut next_reader, &mut output, "test entry")
            .is_err());
    }

    #[test]
    fn read_text_entry_bounded_reads_small_entry() {
        let mut reader = Cursor::new(b"hello world".to_vec());
        let text = read_text_entry_bounded(&mut reader, 64, "test text")
            .expect("small text should be read");
        assert_eq!(text, "hello world");
    }

    #[test]
    fn read_text_entry_bounded_rejects_oversized_entry() {
        let mut reader = Cursor::new(vec![b'x'; 65]);
        let error = read_text_entry_bounded(&mut reader, 64, "test text")
            .expect_err("oversized text should be rejected");
        assert!(error.contains("exceeds the limit"), "unexpected error: {error}");
    }

    #[test]
    fn budgeted_reader_fails_once_budget_is_exhausted() {
        let source = Cursor::new(vec![b'x'; 100]);
        let mut reader = BudgetedReader::new(source, 64, "test stream");
        let mut sink = Vec::new();
        let error = std::io::copy(&mut reader, &mut sink)
            .expect_err("stream over budget should error");
        assert!(
            error.to_string().contains("exceeds the uncompressed budget"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn budgeted_reader_passes_stream_within_budget() {
        let source = Cursor::new(vec![b'x'; 64]);
        let mut reader = BudgetedReader::new(source, 64, "test stream");
        let mut sink = Vec::new();
        let copied =
            std::io::copy(&mut reader, &mut sink).expect("stream within budget should copy");
        assert_eq!(copied, 64);
    }
}
