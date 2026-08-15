export interface FeedbackFieldSpec {
  name: string;
  message: string;
  isValid: (value: string) => boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// DOM order: email (optional, format-checked), category (required), message (required).
export const FEEDBACK_FIELDS: FeedbackFieldSpec[] = [
  {
    name: 'email',
    message: 'Please enter a valid email address, or leave it blank.',
    isValid: (value) => !value.trim() || EMAIL_PATTERN.test(value.trim()),
  },
  {
    name: 'category',
    message: 'Please select a category.',
    isValid: (value) => value.trim().length > 0,
  },
  {
    name: 'message',
    message: 'Please enter a message.',
    isValid: (value) => value.trim().length > 0,
  },
];

export function getFirstInvalidField(
  values: Record<string, string | undefined>,
  fields: FeedbackFieldSpec[] = FEEDBACK_FIELDS
): FeedbackFieldSpec | null {
  for (const field of fields) {
    if (!field.isValid(values[field.name] || '')) {
      return field;
    }
  }
  return null;
}
