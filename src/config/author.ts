export interface AuthorInfo {
  name: string;
  bio: string;
  photo?: string;
  /** Job title used in Person schema (jobTitle field) */
  jobTitle: string;
  /** Site-relative path to the author's bio page — links bylines to the Person entity */
  url: string;
}

export const AUTHOR: AuthorInfo = {
  name: 'Tom Pryor',
  bio: 'Founder of Broadway Scorecard. Seeing shows and writing about them.',
  jobTitle: 'Founder, Broadway Scorecard',
  url: '/about',
};
