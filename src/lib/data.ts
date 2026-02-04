// Barrel re-export for backward compatibility
// Import from specific modules for better tree-shaking:
//   import { getShowAwards } from '@/lib/data-awards';
//   import { getShowGrosses } from '@/lib/data-grosses';
// Or continue importing from here — webpack will tree-shake unused modules.

// Types (zero bundle cost — erased at compile time)
export type {
  ComputedShow,
  ComputedReview,
  CriticScoreResult,
  AudienceScoreResult,
  BuzzScoreResult,
  ConfidenceResult,
  RawShow,
  RawReview,
  RawAudience,
  RawBuzzThread,
  ShowImages,
  TicketLink,
  CreativeMember,
  ComputedAudience,
  BrowsePageConfig,
  CommercialDesignation,
  RecoupmentTrend,
  Director,
  Theater,
  BestOfCategory,
  BestOfList,
  BrowseList,
  ShowGrosses,
  TonyAwards,
  DramaDeskAwards,
  OuterCriticsCircleAwards,
  DramaLeagueAwards,
  PulitzerPrize,
  ShowAwards,
  AwardsDesignation,
  AudienceBuzzDesignation,
  AudienceBuzzSource,
  AudienceBuzzData,
  CostMethodologyType,
  DeepResearchMetadata,
  ShowCommercial,
  SeasonStats,
  ApproachingRecoupmentShow,
  AtRiskShow,
  RecentRecoupmentShow,
  RecentClosing,
  UpcomingClosing,
  CriticConsensus,
  LotteryInfo,
  RushInfo,
  StandingRoomInfo,
  SpecialLotteryInfo,
  ShowLotteryRush,
} from './data-types';

// Core — show scoring, queries, directors, theaters, best-of, browse
export {
  getAllShows,
  getShowBySlug,
  getShowById,
  getShowsByStatus,
  getCurrentShows,
  getAllShowSlugs,
  getShowsSortedByCompositeScore,
  getUpcomingShows,
  getDataFreshness,
  getDataStats,
  getShowLastUpdated,
  getAllDirectors,
  getDirectorBySlug,
  getAllDirectorSlugs,
  getAllTheaters,
  getTheaterBySlug,
  getAllTheaterSlugs,
  getBestOfList,
  getAllBestOfCategories,
  getBrowseList,
  getAllBrowseSlugs,
} from './data-core';

// Grosses — box office data
export {
  getShowGrosses,
  getGrossesWeekEnding,
  getGrossesLastUpdated,
} from './data-grosses';

// Awards
export {
  getShowAwards,
  getTonyWinCount,
  getTonyNominationCount,
  getAwardsDesignation,
  getShowsByTonyWins,
  isTopTonyWinner,
  getAwardsLastUpdated,
} from './data-awards';

// Audience Buzz
export {
  getAudienceBuzz,
  getAudienceBuzzBySlug,
  getShowsByAudienceBuzz,
  getAudienceGrade,
  getAudienceGradeClasses,
  getAudienceBuzzColor,
  getAudienceBuzzLastUpdated,
} from './data-audience';

// Commercial / Biz
export {
  calculateWeeksToRecoup,
  getShowCommercial,
  getCommercialDesignation,
  hasRecouped,
  getCapitalization,
  getShowsByDesignation,
  getRecoupedShows,
  getAllCommercialSlugs,
  getCommercialLastUpdated,
  getDesignationDescription,
  getSeason,
  getSeasonsWithCommercialData,
  getSeasonStats,
  getRecoupmentTrend,
  getShowsApproachingRecoupment,
  getShowsAtRisk,
  getRecentRecoupments,
  getRecentClosings,
  getUpcomingClosings,
  getAllOpenShowsWithCommercial,
  getShowsBySeasonWithCommercial,
} from './data-commercial';

// Critic Consensus
export {
  getCriticConsensus,
  getCriticConsensusLastUpdated,
} from './data-consensus';

// Lottery & Rush
export {
  getLotteryRush,
  getLotteryRushBySlug,
  hasLotteryOrRush,
  getLotteryRushLastUpdated,
} from './data-lottery';
