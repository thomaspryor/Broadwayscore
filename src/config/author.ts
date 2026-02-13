export interface AuthorInfo {
  name: string;
  bio: string;
  photo?: string;
}

export const AUTHOR: AuthorInfo = {
  name: 'Tom Pryor',
  bio: 'Founder of Broadway Scorecard. Seeing shows and writing about them.',
};
