export type Category = 'foldable' | 'phone';

export interface Spec {
  label: string;
  value: string;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  brand: string;
  category: Category;
  releaseDate: string; // YYYY-MM-DD
  launchPrice: number | null; // USD, base config
  officialUrl: string | null;
  criticsTake: string;
  loved: string[];
  gripes: string[];
  specs: Spec[];
  art: { kind: 'phone' | 'foldable'; body: string; accent: string; backdrop: [string, string] };
}

export interface Review {
  productId: string;
  outletId: string;
  critic: string | null;
  url: string;
  date: string; // YYYY-MM-DD
  rating: string | null; // the outlet's own score as published, e.g. "4.5/5"
  score: number; // 0-100
  scoreSource: 'rating' | 'text';
  excerpt: string;
  editorsChoice?: boolean;
  /** Context a reader needs, e.g. a joint review whose score is for a sibling model. */
  note?: string;
}

export interface Outlet {
  id: string;
  name: string;
  tier: 1 | 2 | 3 | 4;
  domain: string;
}
