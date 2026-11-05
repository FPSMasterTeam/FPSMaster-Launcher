import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("build_catalog.py")


class BuildCatalogTests(unittest.TestCase):
    def run_builder(self, *versions):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "artifact.jar"
            artifact.write_bytes(b"local catalog generator test, not a game artifact")
            output = root / "catalog.json"
            result = subprocess.run([
                sys.executable, str(SCRIPT), "--revision", "2", *versions,
                "--client", f"edge={artifact}@https://example.invalid/edge.jar",
                "--client", f"nova:1.21.1={artifact}@https://example.invalid/nova.jar",
                "--out", str(output),
            ], capture_output=True, text=True)
            return result, json.loads(output.read_text()) if output.exists() else None

    def test_distinct_final_versions(self):
        result, document = self.run_builder("--edge-version", "2.0.0-final", "--nova-version", "1.0.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([entry["versionName"] for entry in document["clients"]], ["2.0.0-final", "1.0.0"])
        self.assertTrue(all(len(entry["checksum"]) == 64 for entry in document["clients"]))

    def test_missing_version_fails_without_writing_catalog(self):
        result, document = self.run_builder("--edge-version", "2.0.0-final")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("NOVA needs --nova-version", result.stderr)
        self.assertIsNone(document)


if __name__ == "__main__":
    unittest.main()
