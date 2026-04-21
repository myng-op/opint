// Shared visual tokens. One source of truth for color + shape + spacing so
// Interview, Review and ReviewDetail can't drift out of sync.
//
// Primary = #EE5A00 (a warm Nordic orange). Everything else is derived: a
// soft peach for highlights, a deeper burnt-orange for shadows, a cream bg
// for the landing / review surfaces, and a deep warm "ink" for the immersive
// interview stage.

export const theme = {
  primary: '#EE5A00',
  primaryLight: '#FFB088',
  primaryPeach: '#FFD4B0',
  primaryDeep: '#B23E00',

  // Light surfaces (landing, review)
  bg: '#FFF8F3',
  surface: '#FFFFFF',
  surfaceMuted: '#FDF3EC',

  // Deep warm surface for the immersive interview stage
  ink: '#2A1407',
  inkSoft: '#3D2012',

  text: '#2A1F1A',
  textMuted: '#7A6B63',
  textOnInk: '#FFF0E4',
  textOnInkMuted: 'rgba(255, 240, 228, 0.65)',

  border: '#F2E4D9',
  borderOnInk: 'rgba(255, 176, 136, 0.2)',

  radius: 16,
  radiusSm: 10,
  radiusLg: 24,
  radiusXl: 32,

  shadowSoft: '0 6px 20px rgba(238, 90, 0, 0.08)',
  shadowWarm: '0 12px 32px rgba(238, 90, 0, 0.28)',
  shadowDeep: '0 20px 60px rgba(64, 20, 0, 0.45)',

  // Glass tokens used on the immersive stage
  glass: 'rgba(255, 248, 243, 0.08)',
  glassStrong: 'rgba(255, 248, 243, 0.14)',
  glassBorder: 'rgba(255, 240, 228, 0.18)',
};

export function primaryButton({ disabled = false } = {}) {
  return {
    padding: '14px 28px',
    fontSize: 16,
    fontWeight: 700,
    border: 'none',
    borderRadius: 999,
    color: 'white',
    background: disabled ? '#D8CFC9' : theme.primary,
    cursor: disabled ? 'not-allowed' : 'pointer',
    boxShadow: disabled ? 'none' : theme.shadowSoft,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    transition: 'transform 120ms ease, box-shadow 120ms ease',
  };
}

export function secondaryButton() {
  return {
    padding: '10px 18px',
    fontSize: 14,
    fontWeight: 500,
    border: `1px solid ${theme.border}`,
    borderRadius: 999,
    color: theme.text,
    background: theme.surface,
    cursor: 'pointer',
  };
}

// Hero background used on landing. Near-white with a faint warm settle at
// the bottom — op.fi-style restraint, but keeping a hint of cream so the
// surface doesn't read as clinical.
export const landingAtmosphere = `linear-gradient(180deg, #FFFFFF 0%, ${theme.bg} 100%)`;

// Immersive warm-dark atmosphere used on the interview stage.
export const stageAtmosphere = `
  radial-gradient(ellipse 140% 80% at 50% 15%, rgba(238, 90, 0, 0.45) 0%, transparent 55%),
  radial-gradient(ellipse 80% 70% at 15% 90%, rgba(255, 138, 61, 0.35) 0%, transparent 60%),
  radial-gradient(ellipse 80% 70% at 85% 95%, rgba(178, 62, 0, 0.50) 0%, transparent 55%),
  linear-gradient(180deg, ${theme.inkSoft} 0%, ${theme.ink} 100%)
`;
