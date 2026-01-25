import { ImageResponse } from '@vercel/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

// Score tier colors (matching the CSS classes)
const SCORE_COLORS = {
  mustSee: { bg: 'linear-gradient(135deg, #D4AF37 0%, #C5A028 50%, #D4AF37 100%)', text: '#1a1a1a' },
  great: { bg: '#22c55e', text: '#ffffff' },
  good: { bg: '#14b8a6', text: '#ffffff' },
  tepid: { bg: '#eab308', text: '#1a1a1a' },
  skip: { bg: '#f97316', text: '#ffffff' },
  tbd: { bg: '#2a2a2a', text: '#9ca3af' },
};

function getScoreColor(score: number | null, reviewCount: number) {
  if (reviewCount < 5 || score === null) return SCORE_COLORS.tbd;
  if (score >= 85) return SCORE_COLORS.mustSee;
  if (score >= 75) return SCORE_COLORS.great;
  if (score >= 65) return SCORE_COLORS.good;
  if (score >= 55) return SCORE_COLORS.tepid;
  return SCORE_COLORS.skip;
}

function getScoreLabel(score: number): string {
  if (score >= 85) return 'Must-See';
  if (score >= 75) return 'Great';
  if (score >= 65) return 'Good';
  if (score >= 55) return 'Tepid';
  return 'Skip';
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Determine image type
  const type = searchParams.get('type') || 'show';
  const title = searchParams.get('title') || 'Broadway Scorecard';
  const score = searchParams.get('score') ? parseInt(searchParams.get('score')!) : null;
  const reviewCount = searchParams.get('reviews') ? parseInt(searchParams.get('reviews')!) : 0;
  const theater = searchParams.get('theater') || '';
  const posterUrl = searchParams.get('poster') || '';
  const subtitle = searchParams.get('subtitle') || '';

  // For browse pages
  const posters = searchParams.get('posters')?.split(',').filter(Boolean) || [];

  if (type === 'show') {
    return generateShowOG(title, score, reviewCount, theater, posterUrl);
  } else if (type === 'browse') {
    return generateBrowseOG(title, subtitle, posters);
  } else if (type === 'home') {
    return generateHomeOG(posters);
  }

  // Default fallback
  return generateDefaultOG();
}

async function generateShowOG(
  title: string,
  score: number | null,
  reviewCount: number,
  theater: string,
  posterUrl: string
) {
  const scoreColor = getScoreColor(score, reviewCount);
  const displayScore = reviewCount >= 5 && score !== null ? Math.round(score) : null;
  const scoreLabel = displayScore ? getScoreLabel(displayScore) : 'Awaiting Reviews';

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          backgroundColor: '#0a0a0a',
          position: 'relative',
        }}
      >
        {/* Subtle gradient overlay */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'radial-gradient(ellipse at top right, rgba(139, 92, 246, 0.1), transparent 50%)',
          }}
        />

        {/* Main content container */}
        <div
          style={{
            display: 'flex',
            width: '100%',
            height: '100%',
            padding: '48px',
            gap: '48px',
          }}
        >
          {/* Poster section */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              width: '380px',
              flexShrink: 0,
            }}
          >
            {posterUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */
              <img
                src={posterUrl}
                width={340}
                height={510}
                style={{
                  borderRadius: '16px',
                  objectFit: 'cover',
                  boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              />
            ) : (
              <div
                style={{
                  width: '340px',
                  height: '510px',
                  backgroundColor: '#1a1a1a',
                  borderRadius: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '120px',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                🎭
              </div>
            )}
          </div>

          {/* Info section */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              flex: 1,
              gap: '24px',
            }}
          >
            {/* Title */}
            <div
              style={{
                fontSize: title.length > 20 ? '64px' : '72px',
                fontWeight: 800,
                color: 'white',
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
              }}
            >
              {title}
            </div>

            {/* Theater */}
            {theater && (
              <div
                style={{
                  fontSize: '28px',
                  color: '#9ca3af',
                }}
              >
                {theater}
              </div>
            )}

            {/* Score badge */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '24px',
                marginTop: '16px',
              }}
            >
              <div
                style={{
                  width: '120px',
                  height: '120px',
                  borderRadius: '24px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: displayScore ? '56px' : '32px',
                  fontWeight: 800,
                  background: scoreColor.bg,
                  color: scoreColor.text,
                  boxShadow: displayScore && displayScore >= 85
                    ? '0 0 40px rgba(212, 175, 55, 0.4)'
                    : '0 4px 24px rgba(0, 0, 0, 0.3)',
                }}
              >
                {displayScore ?? 'TBD'}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div
                  style={{
                    fontSize: '32px',
                    fontWeight: 700,
                    color: displayScore ? scoreColor.bg === SCORE_COLORS.mustSee.bg ? '#D4AF37' : scoreColor.bg : '#6b7280',
                  }}
                >
                  {scoreLabel}
                </div>
                <div
                  style={{
                    fontSize: '20px',
                    color: '#6b7280',
                  }}
                >
                  {reviewCount} Critic {reviewCount === 1 ? 'Review' : 'Reviews'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Branding */}
        <div
          style={{
            position: 'absolute',
            bottom: '40px',
            right: '48px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '28px', fontWeight: 800, color: 'white' }}>Broadway</span>
          <span
            style={{
              fontSize: '28px',
              fontWeight: 800,
              background: 'linear-gradient(to right, #8b5cf6, #ec4899)',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            Scorecard
          </span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}

async function generateBrowseOG(
  title: string,
  subtitle: string,
  posters: string[]
) {
  const displayPosters = posters.slice(0, 4);

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          backgroundColor: '#0a0a0a',
          position: 'relative',
        }}
      >
        {/* Background gradient */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'radial-gradient(ellipse at bottom left, rgba(139, 92, 246, 0.15), transparent 50%)',
          }}
        />

        {/* Poster grid on left */}
        {displayPosters.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '12px',
              padding: '48px',
              width: '440px',
              alignContent: 'center',
            }}
          >
            {displayPosters.map((poster, i) => (
              /* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */
              <img
                key={i}
                src={poster}
                width={200}
                height={280}
                style={{
                  borderRadius: '12px',
                  objectFit: 'cover',
                  boxShadow: '0 15px 30px -10px rgba(0, 0, 0, 0.5)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              />
            ))}
          </div>
        )}

        {/* Text content */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            flex: 1,
            padding: '48px',
            paddingLeft: displayPosters.length > 0 ? '24px' : '64px',
            gap: '20px',
          }}
        >
          <div
            style={{
              fontSize: title.length > 25 ? '52px' : '64px',
              fontWeight: 800,
              color: 'white',
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
            }}
          >
            {title}
          </div>

          {subtitle && (
            <div
              style={{
                fontSize: '26px',
                color: '#9ca3af',
                lineHeight: 1.4,
                maxWidth: '500px',
              }}
            >
              {subtitle}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              marginTop: '24px',
              gap: '8px',
            }}
          >
            <div
              style={{
                padding: '12px 24px',
                borderRadius: '999px',
                background: 'linear-gradient(to right, #8b5cf6, #ec4899)',
                color: 'white',
                fontSize: '20px',
                fontWeight: 600,
              }}
            >
              Explore Rankings
            </div>
          </div>
        </div>

        {/* Branding */}
        <div
          style={{
            position: 'absolute',
            bottom: '40px',
            right: '48px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '28px', fontWeight: 800, color: 'white' }}>Broadway</span>
          <span
            style={{
              fontSize: '28px',
              fontWeight: 800,
              background: 'linear-gradient(to right, #8b5cf6, #ec4899)',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            Scorecard
          </span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}

async function generateHomeOG(posters: string[]) {
  const displayPosters = posters.slice(0, 3);

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          backgroundColor: '#0a0a0a',
          position: 'relative',
        }}
      >
        {/* Multi-color gradient background */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'radial-gradient(ellipse at top right, rgba(139, 92, 246, 0.2), transparent 50%), radial-gradient(ellipse at bottom left, rgba(236, 72, 153, 0.15), transparent 50%)',
          }}
        />

        {/* Content */}
        <div
          style={{
            display: 'flex',
            width: '100%',
            height: '100%',
            padding: '64px',
            alignItems: 'center',
            gap: '64px',
          }}
        >
          {/* Logo and tagline */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              gap: '24px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: '72px', fontWeight: 800, color: 'white' }}>Broadway</span>
              <span
                style={{
                  fontSize: '72px',
                  fontWeight: 800,
                  background: 'linear-gradient(to right, #8b5cf6, #ec4899)',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                Scorecard
              </span>
            </div>

            <div
              style={{
                fontSize: '32px',
                color: '#9ca3af',
                maxWidth: '500px',
                lineHeight: 1.4,
              }}
            >
              Aggregated critic scores for every Broadway show
            </div>

            <div
              style={{
                display: 'flex',
                gap: '16px',
                marginTop: '16px',
              }}
            >
              <div
                style={{
                  padding: '16px 32px',
                  borderRadius: '999px',
                  background: 'linear-gradient(to right, #8b5cf6, #ec4899)',
                  color: 'white',
                  fontSize: '22px',
                  fontWeight: 600,
                }}
              >
                Find Your Next Show
              </div>
            </div>
          </div>

          {/* Featured posters */}
          {displayPosters.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: '16px',
                alignItems: 'center',
              }}
            >
              {displayPosters.map((poster, i) => (
                /* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */
                <img
                  key={i}
                  src={poster}
                  width={180}
                  height={270}
                  style={{
                    borderRadius: '12px',
                    objectFit: 'cover',
                    boxShadow: '0 20px 40px -15px rgba(0, 0, 0, 0.6)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    transform: i === 1 ? 'scale(1.1)' : 'scale(1)',
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}

async function generateDefaultOG() {
  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0a0a0a',
          gap: '24px',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'radial-gradient(ellipse at center, rgba(139, 92, 246, 0.2), transparent 60%)',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: '80px', fontWeight: 800, color: 'white' }}>Broadway</span>
          <span
            style={{
              fontSize: '80px',
              fontWeight: 800,
              background: 'linear-gradient(to right, #8b5cf6, #ec4899)',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            Scorecard
          </span>
        </div>

        <div
          style={{
            fontSize: '32px',
            color: '#9ca3af',
          }}
        >
          Aggregated Broadway Show Ratings
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
