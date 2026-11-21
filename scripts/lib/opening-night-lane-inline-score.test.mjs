// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-4835: keep the card's acceptance path runnable; the registered suite owns the tests.
import '../../tests/unit/opening-night-lane-inline-score.test.mjs';
