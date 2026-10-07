"""Run the sync + sort cycle every few minutes in a background thread."""

import os
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler

from app.runner import run_cycle

SYNC_INTERVAL_MINUTES = float(os.getenv("SYNC_INTERVAL_MINUTES", "5"))
JOB_ID = "sync_cycle"


def start_scheduler(job=run_cycle, minutes: float | None = None) -> BackgroundScheduler:
    """Call job() now and then every `minutes` (default SYNC_INTERVAL_MINUTES)."""
    scheduler = BackgroundScheduler(daemon=True)
    scheduler.add_job(
        job, "interval", minutes=minutes or SYNC_INTERVAL_MINUTES, id=JOB_ID,
        max_instances=1, coalesce=True,
        misfire_grace_time=None,  # after the computer wakes up, run once instead of skipping
        next_run_time=datetime.now(timezone.utc),
    )
    scheduler.start()
    return scheduler
