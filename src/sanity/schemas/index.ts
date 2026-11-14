import type { SchemaTypeDefinition } from 'sanity';
import { postType } from './post';
import { showReviewType } from './showReview';

export const schemaTypes: SchemaTypeDefinition[] = [postType, showReviewType];
