// LIVE-DATA-LANE: reads data/audit/press-night/the-imaginary-invalid-2026-2026-10-22.json (read by the test); data/shows.json (read by the test); data/audit/press-night/a-few-good-men-2026-2026-10-29.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-6701: entry point for the issue's acceptance command; the tests live beside the code.
import './lib/press-night-record.test.mjs';
