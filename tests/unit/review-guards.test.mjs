/**
 * Unit tests for review-guards.js — isLikelyWrongProduction
 *
 * Tests the date-mismatch guard that flags reviews likely from a prior production.
 * Pattern: require() the real function, never copy logic into tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isLikelyWrongProduction,
  checkLlmVerificationAgainstKeywords,
  pickRerouteTarget,
  shouldSkipWrongProductionAudit,
  applyTemporalOverrides,
  hasStrongDifferentShowSignal,
  hasNamedDifferentDirectorSignal,
  hasHighConfidenceLlmScore,
} = require('../../scripts/lib/review-guards.js');

describe('isLikelyWrongProduction', () => {
  test('review 91 days before show -> true', () => {
    // 91 days before 2026-06-01 = 2026-03-02
    assert.strictEqual(isLikelyWrongProduction('2026-03-02', '2026-06-01'), true);
  });

  test('review 89 days before show -> false', () => {
    // 89 days before 2026-06-01 = 2026-03-04
    assert.strictEqual(isLikelyWrongProduction('2026-03-04', '2026-06-01'), false);
  });

  test('review on show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-06-01', '2026-06-01'), false);
  });

  test('review after show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-07-15', '2026-06-01'), false);
  });

  test('no review date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction(null, '2026-06-01'), false);
    assert.strictEqual(isLikelyWrongProduction('', '2026-06-01'), false);
  });

  test('no show date -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2026-03-01', null), false);
    assert.strictEqual(isLikelyWrongProduction('2026-03-01', ''), false);
  });

  test('date with ordinal suffix ("May 10th, 2019") -> correctly parsed', () => {
    assert.strictEqual(isLikelyWrongProduction('May 10th, 2019', '2026-06-01'), true);
  });

  test('2016 review for 2026 show -> true', () => {
    assert.strictEqual(isLikelyWrongProduction('2016-04-15', '2026-06-01'), true);
  });

  test('2018 review for 2018 show -> false', () => {
    assert.strictEqual(isLikelyWrongProduction('2018-09-15', '2018-10-01'), false);
  });
});

describe('checkLlmVerificationAgainstKeywords', () => {
  const hamiltonShow = {
    id: 'hamilton-2015',
    title: 'Hamilton',
    cast: [{ name: 'Lin-Manuel Miranda' }, { name: 'Leslie Odom Jr' }],
    creativeTeam: [{ name: 'Thomas Kail' }],
    venue: 'Richard Rodgers Theatre',
  };
  const llmValidCv = { verifiedBy: 'llm:gemini', isValid: true };
  const llmInvalidCv = { verifiedBy: 'llm:gemini', isValid: false };
  const llmWrongArticleCv = { verifiedBy: 'llm:gemini', isValid: true, wrongArticle: true };
  const heuristicCv = { verifiedBy: 'heuristic', isValid: true };

  test('real Hamilton review text -> passed:true', () => {
    const text = 'Lin-Manuel Miranda\'s Hamilton opened last night at the Richard Rodgers Theatre. The cast is stellar.';
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmValidCv);
    assert.ok(result, 'should return a result object');
    assert.strictEqual(result.passed, true);
    assert.ok(result.matchedKeyword, 'should name which keyword matched');
  });

  test('AlliedSignal hallucination text (no show keyword) -> passed:false', () => {
    // Mimics the actual hallucination found in ship-check: AMP shareholder news
    // that Gemini marked isValid:true for Hamilton.
    const text = 'AlliedSignal reported its quarterly earnings today. The conglomerate beat analyst expectations, with CEO Larry Bossidy highlighting strong demand in aerospace. Shares rose 4% in after-hours trading following the announcement.';
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmValidCv);
    assert.ok(result);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.matchedKeyword, null);
    assert.ok(result.keywordsChecked.includes('hamilton'));
  });

  test('browser-update hallucination text -> passed:false', () => {
    const text = 'Your browser is out of date. Please update to the latest version of Chrome, Firefox, or Safari to continue using our site. We recommend enabling JavaScript for the best experience.';
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmValidCv);
    assert.strictEqual(result.passed, false);
  });

  test('LLM said isValid:false -> returns null (not applicable)', () => {
    const text = 'Any text, we do not care.';
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmInvalidCv), null);
  });

  test('LLM flagged wrongArticle -> returns null (already handled upstream)', () => {
    const text = 'AlliedSignal reported earnings.';
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, text, llmWrongArticleCv), null);
  });

  test('non-LLM verification -> returns null', () => {
    const text = 'AlliedSignal reported earnings.';
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, text, heuristicCv), null);
  });

  test('no contentVerification -> returns null', () => {
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, 'any text over 100 chars '.repeat(10), null), null);
    assert.strictEqual(checkLlmVerificationAgainstKeywords(hamiltonShow, 'any text', undefined), null);
  });

  test('text under 100 chars -> returns null (too short to judge)', () => {
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, 'short text', llmValidCv);
    assert.strictEqual(result, null);
  });

  test('empty/missing keyword set -> returns null (no signal)', () => {
    const showWithNoKeywords = { id: 'x', title: '', cast: [], creativeTeam: [] };
    const longText = 'a'.repeat(200);
    assert.strictEqual(checkLlmVerificationAgainstKeywords(showWithNoKeywords, longText, llmValidCv), null);
  });

  test('short-title show (Wit) with legitimate review -> passed:true', () => {
    const witShow = {
      id: 'wit-2012',
      title: 'Wit',
      cast: [{ name: 'Cynthia Nixon' }],
      creativeTeam: [{ name: 'Lynne Meadow' }],
      venue: 'Samuel J Friedman Theatre',
    };
    const text = 'Cynthia Nixon delivers a shattering performance in this revival of Margaret Edson\'s Pulitzer-winning play. Lynne Meadow directs at the Samuel J Friedman Theatre.';
    const result = checkLlmVerificationAgainstKeywords(witShow, text, llmValidCv);
    assert.strictEqual(result.passed, true);
  });

  test('llm:grok prefix also triggers check', () => {
    const text = 'AlliedSignal reported quarterly earnings today. The conglomerate beat analyst expectations, with strong demand across aerospace. Shares rose four percent in after-hours trading.';
    const grokCv = { verifiedBy: 'llm:grok', isValid: true };
    const result = checkLlmVerificationAgainstKeywords(hamiltonShow, text, grokCv);
    assert.ok(result, 'should return a result object');
    assert.strictEqual(result.passed, false);
  });
});

describe('pickRerouteTarget — run-window guard', () => {
  // Real-world failure mode this fix addresses:
  // mamma-mia-2001 ran on Broadway 2001–2015. A 2014 NYT Anita Gates review
  // was being routed to mamma-mia-2025 (revival) because |2014-2025|=11
  // is numerically closer than |2014-2001|=13. But 2014 is mid-run for
  // the 2001 production — the review belongs there, not at the revival.
  // Discovered via gh run view on 4 consecutive rebuilds, all dropping
  // the same file via [REROUTE COLLISION]. See card 33f637c5-416f-8120.
  const revivalSibling = [{ id: 'mamma-mia-2025', year: 2025 }];

  test('mid-run review stays put when run window is passed', () => {
    // current=mamma-mia-2001 (2001–2015), sibling=mamma-mia-2025, detected=2014
    const result = pickRerouteTarget(2001, revivalSibling, 2014, [2001, 2015]);
    assert.strictEqual(result.action, 'keep');
  });

  test('detected year exactly at run-window start → keep (inclusive)', () => {
    const result = pickRerouteTarget(2001, revivalSibling, 2001, [2001, 2015]);
    assert.strictEqual(result.action, 'keep');
  });

  test('detected year exactly at run-window end → keep (inclusive)', () => {
    const result = pickRerouteTarget(2001, revivalSibling, 2015, [2001, 2015]);
    assert.strictEqual(result.action, 'keep');
  });

  test('detected year AFTER run-window end → existing reroute logic applies', () => {
    // 2020 is outside [2001, 2015], dist-to-current 19, dist-to-2025 sibling 5 → reroute
    const result = pickRerouteTarget(2001, revivalSibling, 2020, [2001, 2015]);
    assert.strictEqual(result.action, 'reroute');
    assert.strictEqual(result.targetShowId, 'mamma-mia-2025');
  });

  test('detected year BEFORE run-window start → existing reroute logic applies', () => {
    // Inverse case: chess-2025 holds a 1988 review, sibling chess-1988
    const chessOriginal = [{ id: 'chess-1988', year: 1988 }];
    const result = pickRerouteTarget(2025, chessOriginal, 1988, [2025, 2026]);
    assert.strictEqual(result.action, 'reroute');
    assert.strictEqual(result.targetShowId, 'chess-1988');
  });

  test('no run window passed → backward compatible (reroute still fires)', () => {
    // Mamma Mia case WITHOUT run window — reproduces the legacy bug.
    // Locks in that omitting the 4th arg preserves the pre-fix behavior
    // for any caller that hasn't been updated yet.
    const result = pickRerouteTarget(2001, revivalSibling, 2014);
    assert.strictEqual(result.action, 'reroute');
    assert.strictEqual(result.targetShowId, 'mamma-mia-2025');
  });

  test('null run window → backward compatible', () => {
    const result = pickRerouteTarget(2001, revivalSibling, 2014, null);
    assert.strictEqual(result.action, 'reroute');
  });

  test('malformed run window (not array) → ignored, old logic runs', () => {
    const result = pickRerouteTarget(2001, revivalSibling, 2014, 'nope');
    assert.strictEqual(result.action, 'reroute');
  });

  test('malformed run window (wrong length) → ignored, old logic runs', () => {
    const result = pickRerouteTarget(2001, revivalSibling, 2014, [2001]);
    assert.strictEqual(result.action, 'reroute');
  });

  test('non-finite years in window → ignored, old logic runs', () => {
    const result = pickRerouteTarget(2001, revivalSibling, 2014, [NaN, 2015]);
    assert.strictEqual(result.action, 'reroute');
  });

  test('currently-running show: endYear = current year protects recent reviews', () => {
    // A show opened 2020, still running → window [2020, <current>]
    // Detected 2023 should stay regardless of a 2026 sibling
    const currentYear = new Date().getFullYear();
    const sibling = [{ id: 'revival-2026', year: 2026 }];
    const result = pickRerouteTarget(2020, sibling, 2023, [2020, currentYear]);
    assert.strictEqual(result.action, 'keep');
  });

  test('run window does NOT override within-1-year keep logic', () => {
    // Existing rule: |detected - current| <= 1 keeps. Ensure adding the window
    // guard didn't break the early-return short-circuit.
    const result = pickRerouteTarget(2025, [{ id: 'chess-1988', year: 1988 }], 2024, [2025, 2026]);
    assert.strictEqual(result.action, 'keep');
  });

  test('null detectedYear still short-circuits even with window', () => {
    const result = pickRerouteTarget(2001, revivalSibling, null, [2001, 2015]);
    assert.strictEqual(result.action, 'keep');
  });

  test('empty siblings still short-circuits even with window', () => {
    const result = pickRerouteTarget(2001, [], 2014, [2001, 2015]);
    assert.strictEqual(result.action, 'keep');
  });

  test('single-year run: startYear === endYear keeps detectedYear match', () => {
    // Show opens and closes in 2025 — a 2025 review should stay
    const sibling = [{ id: 'show-2020', year: 2020 }];
    const result = pickRerouteTarget(2025, sibling, 2025, [2025, 2025]);
    assert.strictEqual(result.action, 'keep');
  });

  test('single-year run: detectedYear outside reroutes normally', () => {
    const sibling = [{ id: 'show-2020', year: 2020 }];
    const result = pickRerouteTarget(2025, sibling, 2020, [2025, 2025]);
    assert.strictEqual(result.action, 'reroute');
    assert.strictEqual(result.targetShowId, 'show-2020');
  });

  test('malformed window (endYear < startYear) falls through to legacy logic', () => {
    // Bad data: closingDate year before openingDate year. Window is empty,
    // guard correctly falls through to year-distance logic.
    const result = pickRerouteTarget(2001, revivalSibling, 2014, [2015, 2001]);
    assert.strictEqual(result.action, 'reroute');
  });
});

describe('shouldSkipWrongProductionAudit', () => {
  test('returns false for null/undefined input', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit(null), false);
    assert.strictEqual(shouldSkipWrongProductionAudit(undefined), false);
  });

  test('returns false for empty object', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit({}), false);
  });

  test('returns true for humanReviewedWrongProduction === false', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit({ humanReviewedWrongProduction: false }), true);
  });

  test('returns true for wrongProductionManualClear', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit({ wrongProductionManualClear: true }), true);
  });

  test('returns true for wrongProductionOverride', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit({ wrongProductionOverride: true }), true);
  });

  test('returns true for allowCrossMarket', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit({ allowCrossMarket: true }), true);
  });

  test('allowCrossMarket=false does not skip', () => {
    assert.strictEqual(shouldSkipWrongProductionAudit({ allowCrossMarket: false }), false);
  });
});

describe('hasStrongDifferentShowSignal', () => {
  test('empty/null inputs return false', () => {
    assert.strictEqual(hasStrongDifferentShowSignal(null, null), false);
    assert.strictEqual(hasStrongDifferentShowSignal([], ''), false);
    assert.strictEqual(hasStrongDifferentShowSignal(undefined, undefined), false);
  });

  test('generic issues without strong markers return false', () => {
    const issues = ['Text is truncated mid-sentence at 3678 characters', 'Review is short'];
    assert.strictEqual(hasStrongDifferentShowSignal(issues, 'Generic LLM reasoning'), false);
  });

  test('"does not appear in" in issues → true', () => {
    const issues = ["Expected show 'Schmigadoon!' does not appear in scraped content at all"];
    assert.strictEqual(hasStrongDifferentShowSignal(issues, ''), true);
  });

  test('"completely different show" in issues → true', () => {
    const issues = ['The production described is completely different show'];
    assert.strictEqual(hasStrongDifferentShowSignal(issues, ''), true);
  });

  test('"reviews the wrong production" in reasoning → true', () => {
    assert.strictEqual(
      hasStrongDifferentShowSignal([], 'The critic reviews the wrong production entirely'),
      true
    );
  });

  test('"unrelated to the expected" in reasoning → true', () => {
    assert.strictEqual(
      hasStrongDifferentShowSignal([], 'The scraped content is unrelated to the expected Schmigadoon review'),
      true
    );
  });

  test('EBT-as-Schmigadoon fixture (real-world case)', () => {
    // Exact issues/reasoning from 2026-04-21 Schmigadoon opening-night failure.
    const issues = [
      "Review is about 'Every Brilliant Thing' (Daniel Radcliffe one-person show), not 'Schmigadoon!'",
      "Text is truncated mid-sentence at 3678 characters",
      "Expected show 'Schmigadoon!' does not appear in scraped content at all",
      "The production described features Daniel Radcliffe in a play by Duncan Macmillan and Jonny Donahoe — completely different show",
    ];
    assert.strictEqual(hasStrongDifferentShowSignal(issues, ''), true);
  });

  test('film-review leak: "This is a film review of …" in reasoning → true (Hamlet 2026-05-08)', () => {
    // Exact phrasing from hamlet-off-broadway-2026/vulture--bilge-eberi.json CV.
    const reasoning = "[OVERRIDE: review within 0d of opening, likely correct production] This is a film review of Aneil Karia's Hamlet adaptation starring Riz Ahmed, not a review of an Off-Broadway theater production.";
    assert.strictEqual(hasStrongDifferentShowSignal([], reasoning), true);
  });

  test('film-review leak: "scraped content is a film review of …" → true (Dracula West End)', () => {
    const reasoning = "The scraped content is a film review of Luc Besson's cinematic 'Dracula' adaptation, not a review of the West End stage production.";
    assert.strictEqual(hasStrongDifferentShowSignal([], reasoning), true);
  });

  test('film-review leak: "is a review of a film adaptation" → true (Wicked, Kiss of the Spider Woman)', () => {
    const reasoning = "This is a review of a film adaptation of Wicked starring Cynthia Erivo, not the West End stage production.";
    assert.strictEqual(hasStrongDifferentShowSignal([], reasoning), true);
  });

  test('film-review FP guard: "compares to the film adaptation" stays as override (Good Night & Good Luck)', () => {
    // Real-world CV reasoning that should NOT bypass — the review IS a Broadway review,
    // just heavily compares to the 2005 film. Pattern requires "is a film review", not just
    // "film adaptation" mentions.
    const reasoning = "This review is fundamentally about comparing a Broadway adaptation of the 2005 George Clooney film to the original film itself. The critic's primary critical lens is how the film translated to stage, not an independent assessment of the Broadway production.";
    assert.strictEqual(hasStrongDifferentShowSignal([], reasoning), false);
  });

  test('film-review FP guard: "live-action version" alone does NOT trigger (Aladdin)', () => {
    // Aladdin 2014 / theatermania--charles-isherwood: legit Broadway review using "live-action version"
    // unusually. CV got confused. Bypass should NOT fire.
    const reasoning = "Review describes the live-action film version of Aladdin, not the Broadway musical stage production. Text explicitly states 'This live-action version of the Disney animated classic'.";
    assert.strictEqual(hasStrongDifferentShowSignal([], reasoning), false);
  });
});

describe('applyTemporalOverrides — strong-signal bypass (Schmigadoon 2026-04-21 EBT class)', () => {
  test('within-30d opening-week review without strong signal: downgrades as before', () => {
    const r = applyTemporalOverrides(true, false, 'high', '2026-04-20', '2026-04-21');
    assert.strictEqual(r.wpConfidence, 'low', 'opening-week FP is downgraded (preserves Giant safety net)');
    assert.strictEqual(r.bypassedForStrongSignal, false);
  });

  test('within-30d opening-week review WITH strong "does not appear in" signal: bypass', () => {
    const ebtIssues = [
      "Expected show 'Schmigadoon!' does not appear in scraped content at all",
      "completely different show",
    ];
    const r = applyTemporalOverrides(true, false, 'high', '2026-04-20', '2026-04-21', {
      issues: ebtIssues,
      reasoning: "reviews the wrong production entirely",
    });
    assert.strictEqual(r.wpConfidence, 'high', 'strong signal should NOT be downgraded');
    assert.strictEqual(r.bypassedForStrongSignal, true);
  });

  test('within-30d + strong signal + medium confidence: retains medium', () => {
    const r = applyTemporalOverrides(true, false, 'medium', '2026-04-20', '2026-04-21', {
      issues: ['reviews the wrong production'],
    });
    assert.strictEqual(r.wpConfidence, 'medium');
    assert.strictEqual(r.bypassedForStrongSignal, true);
  });

  test('strong signal but NOT wrongProduction flag: no-op', () => {
    // If wpFlag=false, there's nothing to downgrade anyway. Just verify it doesn't throw.
    const r = applyTemporalOverrides(false, false, 'high', '2026-04-20', '2026-04-21', {
      issues: ['does not appear in content'],
    });
    assert.strictEqual(r.wpConfidence, 'high');
    assert.strictEqual(r.bypassedForStrongSignal, true);
  });

  test('no cvContext: backward compat, old callers still work', () => {
    const r = applyTemporalOverrides(true, false, 'high', '2026-04-20', '2026-04-21');
    assert.strictEqual(r.wpConfidence, 'low');
    assert.strictEqual(r.bypassedForStrongSignal, false);
  });

  test('outside-30d window: no downgrade regardless of signal', () => {
    const r = applyTemporalOverrides(true, false, 'high', '2026-04-20', '2026-02-01');
    assert.strictEqual(r.wpConfidence, 'high');
  });
});

describe('hasNamedDifferentDirectorSignal — Hamlet 2026-05-08 FRC class', () => {
  // Hamlet OB 2026 (BAM Harvey) was opening 2026-05-04 with director Robert Hastie.
  // FRC review (Vahni Kurra) was actually for Teatro La Plaza's Hamlet at TFANA,
  // directed by Chela De Ferrari. CV correctly flagged wrongProduction:true with
  // reasoning explicitly naming Chela De Ferrari, but temporal override fired and
  // downgraded confidence — so the review scored 91 and was the only "review"
  // before manual flag.
  const hamletShow = {
    creativeTeam: [{ name: 'Robert Hastie', role: 'Director' }],
  };
  const frcReasoningCv = "The scraped review explicitly states 'the current production at Theatre For A New Audience' and describes Teatro La Plaza's specific Hamlet production directed by Chela De Ferrari.";
  const frcFullText = "Teatro La Plaza's Hamlet at Theatre For A New Audience is a striking re-imagining of the Danish prince's tale...";

  test('CV-named director not in show + show director not in fullText → bypass', () => {
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], frcReasoningCv, hamletShow, frcFullText),
      true,
      'FRC Hamlet TFANA case must bypass'
    );
  });

  test('CV-named director not in show BUT show director mentioned in fullText ≥2x → no bypass (FP guard)', () => {
    // dog-day-afternoon-2026: NYT Paulson review names "Sidney Lumet" (the FILM director),
    // but the actual stage review mentions Rupert Goold (the legit stage director) 3 times.
    const dogDayShow = { creativeTeam: [{ name: 'Rupert Goold', role: 'Director' }] };
    const dogDayCv = "[OVERRIDE: review within 5d] Review heavily emphasizes comparing the stage adaptation to the 1975 film directed by Sidney Lumet.";
    const dogDayFullText = "Rupert Goold's stage adaptation of Dog Day Afternoon at the Booth Theatre brings new urgency... Goold uses sparse staging... In Goold's hands, the bank robbery becomes...";
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], dogDayCv, dogDayShow, dogDayFullText),
      false,
      'legit stage review that compares to film must NOT bypass'
    );
  });

  test('CV names show director (matches expected) → no bypass (legit review)', () => {
    const cv = "directed by Robert Hastie";
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], cv, hamletShow, "..."),
      false
    );
  });

  test('CV names BOTH expected and other directors → no bypass (mixed reference)', () => {
    const cv = "directed by Robert Hastie at BAM, in contrast to the earlier Michael Grandage 2009 production";
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], cv, hamletShow, "..."),
      false
    );
  });

  test('show has no director → false (cannot make claim)', () => {
    const show = { creativeTeam: [] };
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], frcReasoningCv, show, frcFullText),
      false
    );
  });

  test('no fullText → false (cannot run guardrail check)', () => {
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], frcReasoningCv, hamletShow, ''),
      false
    );
  });

  test('CV has no "directed by" pattern → false', () => {
    const cv = "The scraped content seems unusual but I cannot identify a specific director.";
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], cv, hamletShow, frcFullText),
      false
    );
  });

  test('3-letter expected last name "ash" is skipped to avoid noise', () => {
    // Hypothetical director with last name shorter than 4 chars — guardrail skips them
    // because too many false positives (e.g. "ash" is a common word in theater reviews).
    const show = { creativeTeam: [{ name: 'Tim Ash', role: 'Director' }] };
    const cv = "directed by Kenny Leon — completely wrong production";
    const text = "Ash and ash everywhere on the stage. The ash falls.";
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], cv, show, text),
      true,
      '3-char last names skip guardrail, bypass fires on the named-different-director signal'
    );
  });

  test('4-letter expected name "gold" still uses guardrail (correct for Sam Gold Macbeth)', () => {
    // macbeth-2022: actual director Sam Gold, fullText mentions "gold" repeatedly.
    // Even though "gold" is also a common word, treating any 4+ char name uniformly
    // is safer than per-name carve-outs. For the macbeth case this means the bypass
    // does NOT fire on Sam Gold reviews — keeping the override on (correct outcome,
    // since the dtli-ran-xia review IS the legit Sam Gold production review).
    const show = { creativeTeam: [{ name: 'Sam Gold', role: 'Director' }] };
    const cv = "directed by Kenny Leon (a different production)";
    const text = "Sam Gold's stark Macbeth uses a single gold spotlight. Gold's vision is austere.";
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], cv, show, text),
      false,
      'guardrail correctly keeps override on legit Sam Gold review'
    );
  });

  test('integration: applyTemporalOverrides with show + fullText cvContext → bypass for FRC class', () => {
    const r = applyTemporalOverrides(true, false, 'high', '2026-05-04', '2026-05-04', {
      issues: [],
      reasoning: frcReasoningCv,
      show: hamletShow,
      fullText: frcFullText,
    });
    assert.strictEqual(r.wpConfidence, 'high', 'FRC Hamlet TFANA must keep high confidence (bypass override)');
    assert.strictEqual(r.bypassedForStrongSignal, true);
  });

  test('integration: applyTemporalOverrides with show + fullText, dog-day FP → keep override', () => {
    const dogDayShow = { creativeTeam: [{ name: 'Rupert Goold', role: 'Director' }] };
    const dogDayCv = "[OVERRIDE: review within 5d] Review heavily emphasizes comparing the stage adaptation to the 1975 film directed by Sidney Lumet.";
    const dogDayFullText = "Rupert Goold's stage adaptation of Dog Day Afternoon at the Booth Theatre brings new urgency. Goold uses sparse staging and Goold's hands shape the bank robbery into a meditation on identity.";
    const r = applyTemporalOverrides(true, false, 'high', '2026-03-30', '2026-04-01', {
      issues: [],
      reasoning: dogDayCv,
      show: dogDayShow,
      fullText: dogDayFullText,
    });
    assert.strictEqual(r.wpConfidence, 'low', 'legit Goold review with Lumet film comparison must downgrade as before');
    assert.strictEqual(r.bypassedForStrongSignal, false);
  });

  test('role filter — only stage Director counts; Music/Casting/Associate Director do NOT', () => {
    // Ship-check 2026-05-09 P0-2: a CV-named director sharing last name with the show's
    // Music or Casting Director must NOT silently kill the bypass. Only stage director
    // roles count (Director, Director & Choreographer, Co-Director, Book Director).
    const show = {
      creativeTeam: [
        { name: 'Robert Hastie', role: 'Director' },
        { name: 'Chela De Ferrari', role: 'Music Director' }, // shares last name w/ "wrong" CV-named
      ],
    };
    const cv = "directed by Chela De Ferrari (Teatro La Plaza's production at TFANA)";
    const fullText = "Teatro La Plaza's Hamlet at TFANA...";
    // Despite show.creativeTeam having a "Chela De Ferrari" entry, that's a Music Director role
    // and shouldn't count as expected. Bypass should still fire because no STAGE director is matched.
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], cv, show, fullText),
      true,
      'Music/Casting Director shares-last-name must NOT block the bypass'
    );
  });

  test('role filter — Director & Choreographer counts as stage director', () => {
    // Common in musicals: Susan Stroman, Christopher Wheeldon, Matthew Bourne all hold this role.
    const show = {
      creativeTeam: [{ name: 'Matthew Bourne', role: 'Director & Choreographer' }],
    };
    const cv = "directed by Matthew Bourne — the legit production";
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], cv, show, "..."),
      false,
      'Director & Choreographer should match expected when CV names same person'
    );
  });

  test('role filter — Casting Director only → no expected directors → false', () => {
    // shows.json had "Tara Rubin" with role "Casting Director" for hunger-games-on-stage
    // before Phase 0 audit fixed it. Even if a future show only has a Casting Director,
    // the bypass must early-exit (no expected directors) rather than treating Casting as stage.
    const show = { creativeTeam: [{ name: 'Tara Rubin', role: 'Casting Director' }] };
    const cv = "directed by Matthew Dunster";
    assert.strictEqual(
      hasNamedDifferentDirectorSignal([], cv, show, "..."),
      false,
      'No stage director in creativeTeam → bypass cannot fire safely'
    );
  });
});

describe('hasHighConfidenceLlmScore — Balusters CLASS 1 contradiction guard', () => {
  test('no llmScore → false', () => {
    assert.strictEqual(hasHighConfidenceLlmScore({}), false);
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: null }), false);
  });

  test('llmScore with non-finite score → false', () => {
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: null, confidence: 'high' } }), false);
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: 'low', confidence: 'high' } }), false);
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: NaN, confidence: 'high' } }), false);
  });

  test('llmScore with low confidence → false', () => {
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: 80, confidence: 'low' } }), false);
  });

  test('llmScore with high confidence + finite score → true (Helen Shaw case)', () => {
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: 80, confidence: 'high' } }), true);
  });

  test('llmScore with medium confidence + finite score → true (boundary)', () => {
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: 65, confidence: 'medium' } }), true);
  });

  test('llmScore with score=0 (explicit pan) + high conf → true', () => {
    // Score bounds intentionally don't filter — pans are valid scores too.
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: 0, confidence: 'high' } }), true);
  });

  test('llmScore confidence case-insensitive', () => {
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: 80, confidence: 'HIGH' } }), true);
    assert.strictEqual(hasHighConfidenceLlmScore({ llmScore: { score: 80, confidence: 'Medium' } }), true);
  });
});
