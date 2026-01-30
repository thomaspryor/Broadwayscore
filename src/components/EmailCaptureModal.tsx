'use client';

/**
 * EmailCaptureModal - Modal for capturing user emails before premium actions
 * Phase 0: Monetization optionality
 */

import { useState, useEffect, useCallback } from 'react';
import { track } from '@vercel/analytics';

export type GateTrigger =
  | 'csv_download'
  | 'json_download'
  | 'page_view_limit'
  | 'exit_intent'
  | 'return_visitor';

interface EmailCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CapturedUserData) => void;
  trigger: GateTrigger;
  /** If true, modal cannot be dismissed — user must enter email */
  blocking?: boolean;
}

export interface CapturedUserData {
  email: string;
  name?: string;
  company?: string;
  role?: string;
  capturedAt: string;
  trigger: GateTrigger;
}

const ROLE_OPTIONS = [
  { value: '', label: 'Select your role (optional)' },
  { value: 'investor', label: 'Investor / Producer' },
  { value: 'industry', label: 'Industry Professional' },
  { value: 'press', label: 'Press / Journalist' },
  { value: 'academic', label: 'Academic / Researcher' },
  { value: 'fan', label: 'Theater Fan' },
  { value: 'other', label: 'Other' },
];

const TRIGGER_COPY: Record<GateTrigger, { heading: string; subheading: string }> = {
  csv_download: {
    heading: 'CSV Export Coming Soon',
    subheading: 'Be first to access Pro features including data exports, alerts, and historical data.',
  },
  json_download: {
    heading: 'API Access Coming Soon',
    subheading: 'Get early access to our data API for integrations and analysis.',
  },
  page_view_limit: {
    heading: 'Want to see more?',
    subheading: 'Enter your email for full access to Broadway investment data.',
  },
  exit_intent: {
    heading: 'Before you go...',
    subheading: 'Get weekly updates on Broadway recoupments and box office trends.',
  },
  return_visitor: {
    heading: 'Welcome back!',
    subheading: 'Join our mailing list for exclusive Broadway investment insights.',
  },
};

export default function EmailCaptureModal({
  isOpen,
  onClose,
  onSubmit,
  trigger,
  blocking = false,
}: EmailCaptureModalProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const copy = TRIGGER_COPY[trigger];

  // Only show extra fields (name, company, role) for biz-specific triggers
  const showExtraFields = trigger === 'csv_download' || trigger === 'json_download' || trigger === 'page_view_limit';

  // Track modal shown
  useEffect(() => {
    if (isOpen) {
      track('gate_modal_shown', { trigger });
    }
  }, [isOpen, trigger]);

  // Handle escape key (only for non-blocking modals)
  useEffect(() => {
    if (blocking) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, blocking]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Basic email validation
    if (!email || !email.includes('@') || !email.includes('.')) {
      setError('Please enter a valid email address');
      return;
    }

    setIsSubmitting(true);

    try {
      const userData: CapturedUserData = {
        email: email.toLowerCase().trim(),
        name: name.trim() || undefined,
        company: company.trim() || undefined,
        role: role || undefined,
        capturedAt: new Date().toISOString(),
        trigger,
      };

      // Track email capture
      track('email_captured', {
        has_name: !!userData.name,
        has_company: !!userData.company,
        role: userData.role || 'none',
        trigger,
      });

      onSubmit(userData);

      // Reset form
      setEmail('');
      setName('');
      setCompany('');
      setRole('');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [email, name, company, role, trigger, onSubmit]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={blocking ? undefined : onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-surface-raised rounded-2xl shadow-2xl border border-white/10 overflow-hidden">
        {/* Close button - hidden when blocking */}
        {!blocking && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors z-10"
            aria-label="Close modal"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}

        {/* Header */}
        <div className="px-6 pt-8 pb-4 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-brand/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h2 id="modal-title" className="text-2xl font-bold text-white mb-2">
            {copy.heading}
          </h2>
          <p className="text-gray-400">
            {copy.subheading}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 pb-6">
          <div className="space-y-4">
            {/* Email - Required */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1">
                Email <span className="text-red-400">*</span>
              </label>
              <input
                type="email"
                id="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
                autoFocus
              />
            </div>

            {/* Name, Company, Role - Only for biz-specific triggers */}
            {showExtraFields && (
              <>
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-300 mb-1">
                    Name <span className="text-gray-500">(optional)</span>
                  </label>
                  <input
                    type="text"
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Smith"
                    className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
                  />
                </div>

                <div>
                  <label htmlFor="company" className="block text-sm font-medium text-gray-300 mb-1">
                    Company <span className="text-gray-500">(optional)</span>
                  </label>
                  <input
                    type="text"
                    id="company"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Broadway Productions LLC"
                    className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all"
                  />
                </div>

                <div>
                  <label htmlFor="role" className="block text-sm font-medium text-gray-300 mb-1">
                    Role <span className="text-gray-500">(optional)</span>
                  </label>
                  <select
                    id="role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="w-full px-4 py-3 bg-surface border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent transition-all appearance-none cursor-pointer"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239ca3af'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '20px' }}
                  >
                    {ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-surface-raised">
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </div>

          {/* Error message */}
          {error && (
            <p className="mt-3 text-sm text-red-400">{error}</p>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full mt-6 px-6 py-3 bg-brand hover:bg-brand-hover disabled:bg-brand/50 text-white font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 focus:ring-offset-surface-raised"
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Submitting...
              </span>
            ) : (
              showExtraFields ? 'Get Early Access' : 'Subscribe'
            )}
          </button>

          {/* Privacy note */}
          <p className="mt-4 text-xs text-gray-500 text-center">
            We respect your privacy. No spam, unsubscribe anytime.
          </p>
        </form>
      </div>
    </div>
  );
}
