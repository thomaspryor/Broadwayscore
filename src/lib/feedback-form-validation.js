const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// DOM order: email (optional, format-checked), category (required), message (required).
const FEEDBACK_FIELDS = [
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

function getFirstInvalidField(values, fields = FEEDBACK_FIELDS) {
  for (const field of fields) {
    if (!field.isValid(values[field.name] || '')) {
      return field;
    }
  }
  return null;
}

/** True when `body` isn't a plausible feedback payload at all (wrong shape, not a malformed field). */
function isMalformedFeedbackPayload(body) {
  return body === null || body === undefined || typeof body !== 'object' || Array.isArray(body);
}

module.exports = { FEEDBACK_FIELDS, getFirstInvalidField, isMalformedFeedbackPayload };
