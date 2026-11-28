# Call the Score: signed-in prediction design

[Open the published design artifact (v7)](https://claude.ai/artifact/WEBqQaqvfJRqBvpEHKsnag). The artifact contains the visual mockups on screenshots of the real show page. This document records the design and the decision associated with it; it does not replace the visual artifact.

## Owner decision

On November 11, 2026, the owner chose option A: build the call on the real show page with a guess-to-reveal forecast, while prioritizing a more reliable predictor. The recorded response followed the v7 link and confirms the design direction. Feature implementation was filed separately as BRO-7350, and predictor work as BRO-7347.

## Show page mockups

The v7 artifact places the call inside the existing empty **Critic Scorecard** card on an upcoming show page. A **Call the score** link in the hero's **Awaiting Reviews** box points to it. The three states are:

1. **Signed out:** the prediction is locked; the reader is prompted to sign in before making a call.
2. **Signed in, before opening:** the reader chooses a score from 0 to 100 and selects **Lock in and see our forecast**. Once locked, the card shows **Your call** beside **Our forecast** and its range. The call is final so the revealed forecast cannot be copied into a revised call.
3. **After reviews are published:** a **Your call** strip appears beneath the tally bar in the Critic Scorecard, comparing **You**, **Our forecast**, and **Critics**.

One call per show is available to signed-in readers. Other readers' calls remain hidden until opening. The original mock also compared the reader's miss with the reader average and did not include a leaderboard in v1. These are design notes, not a claim about the current implementation.

## Account statistics

The artifact includes a **My Shows** statistics screen showing the reader's personal prediction record. Results belong in the user's Stats alongside their show activity, so a reader can revisit their performance across shows.

## Visual conventions

The recorded artifact uses the site's surface colors, brand gold, Inter, and the score badge fills from `src/app/globals.css`. For any implementation, use the existing `.card` surfaces and shared `ScoreBadge` with the established score tier logic; preserve badge dimensions. Market branding comes from `src/config/branding.ts`. The original mock's reader calls and reader average were placeholders, not measured results.

## Evidence and scope

The published artifact and the owner's choice are recorded in the BRO-7328 comments dated November 10 and 11, 2026. This document restores the missing repository reference; it does not publish a new artifact or change site code.
