"""
Watch for new RTCI '*Final.csv' files and auto-update crime_data.db.
Runs continuously, checking every 60 seconds.

Start: pythonw scripts/watch-rtci.py  (background, no console window)
  or:  python scripts/watch-rtci.py   (foreground with output)

Logs to: scripts/watch-rtci.log
"""
import logging
import os
import sys
import time
from pathlib import Path

# Add parent dir so we can import update-rtci as module
sys.path.insert(0, str(Path(__file__).resolve().parent))

MONTHS_DIR = Path(r"C:/OneDrive/OneDrive - ahdatalytics.com/Clients/Real Time Crime Index/Open Source Data/_Ben and Jeff work/Months")
PROCESSED_FILE = Path(__file__).resolve().parent / "rtci-processed.txt"
LOG_FILE = Path(__file__).resolve().parent / "watch-rtci.log"
CHECK_INTERVAL = 60  # seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("watch-rtci")


def get_processed():
    """Load set of already-processed CSV filenames."""
    if PROCESSED_FILE.exists():
        return set(PROCESSED_FILE.read_text().strip().splitlines())
    return set()


def mark_processed(csv_path):
    """Add a CSV filename to the processed list."""
    processed = get_processed()
    processed.add(csv_path.name)
    PROCESSED_FILE.write_text("\n".join(sorted(processed)) + "\n")


def find_new_csvs():
    """Find '*Final.csv' files not yet processed."""
    processed = get_processed()
    new_files = []
    for yeardir in MONTHS_DIR.iterdir():
        if not yeardir.is_dir():
            continue
        for f in yeardir.glob("*Final.csv"):
            if f.name not in processed:
                new_files.append(f)
    # Sort by modified time so we process oldest first
    new_files.sort(key=lambda f: f.stat().st_mtime)
    return new_files


def run_update(csv_path):
    """Run the RTCI update and deploy."""
    # Import the update functions
    import importlib
    spec = importlib.util.spec_from_file_location(
        "update_rtci",
        str(Path(__file__).resolve().parent / "update-rtci.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    log.info(f"Loading CSV: {csv_path.name}")
    rows = mod.load_csv(csv_path)
    log.info(f"Parsed {len(rows):,} records")

    if not rows:
        log.warning("No data parsed — skipping")
        return False

    mod.update_db(rows)
    log.info("Database updated locally")

    log.info("Deploying to VPS...")
    success = mod.deploy_to_vps()
    if success:
        log.info("VPS deploy complete")
    else:
        log.warning("VPS deploy failed — will retry next cycle")
        return False

    return True


def main():
    log.info("RTCI file watcher started")
    log.info(f"Watching: {MONTHS_DIR}")
    log.info(f"Processed list: {PROCESSED_FILE}")

    # On first run, mark all existing CSVs as processed so we don't re-import everything
    if not PROCESSED_FILE.exists():
        log.info("First run — marking existing CSVs as already processed")
        existing = []
        for yeardir in MONTHS_DIR.iterdir():
            if not yeardir.is_dir():
                continue
            for f in yeardir.glob("*Final.csv"):
                existing.append(f)
                mark_processed(f)
        log.info(f"Marked {len(existing)} existing CSVs")

    while True:
        try:
            new_files = find_new_csvs()
            if new_files:
                for csv_path in new_files:
                    log.info(f"New CSV detected: {csv_path.name}")
                    try:
                        success = run_update(csv_path)
                        if success:
                            mark_processed(csv_path)
                            log.info(f"Successfully processed: {csv_path.name}")
                        else:
                            log.warning(f"Failed to process: {csv_path.name} — will retry")
                    except Exception as e:
                        log.error(f"Error processing {csv_path.name}: {e}")
        except Exception as e:
            log.error(f"Watch cycle error: {e}")

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
