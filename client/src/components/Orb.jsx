// Audio-reactive orb. Drives itself from two `AnalyserNode` refs:
//   - annaAnalyser.current — tap on the playback AudioContext (Anna's voice)
//   - userAnalyser.current — tap on the mic MediaStreamSource (participant)
//
// On every animation frame we:
//   1. Compute the time-domain RMS of each analyser.
//   2. Smooth it (exponential avg) so the orb bounces with voice rhythm, not per-sample jitter.
//   3. Write a scale transform directly to the orb + halo DOM nodes via refs —
//      avoiding React re-renders at 60 fps.
//   4. After 350 ms of consistent "who is louder", swap the center icon
//      (face for Anna, headset for the participant). The debounce stops the
//      icon from flickering every time one voice briefly overlaps the other.
//
// The outer wrapper carries the CSS `orbDrift` keyframe animation; the
// scale transform lives on the inner wrapper so the two transforms compose
// cleanly without fighting each other.

import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme.js';
import femaleFaceUrl from '../../../icons/female_face.svg';
import micUrl from '../../../icons/customer_service.svg';

const SILENCE_THRESHOLD = 0.018;
const SWITCH_DEBOUNCE_MS = 350;

function readRMS(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

export default function Orb({ annaAnalyser, userAnalyser, size = 280 }) {
  const orbRef = useRef(null);
  const haloRef = useRef(null);
  const [iconMode, setIconMode] = useState('anna'); // 'anna' | 'user'

  useEffect(() => {
    let raf = 0;
    let smoothed = 0;
    let pending = null;
    let pendingSince = 0;
    let lastLog = 0;

    function tick() {
      const a = readRMS(annaAnalyser?.current);
      const u = readRMS(userAnalyser?.current);
      const loudest = Math.max(a, u);

      // Exponential smoothing keeps the bounce musical instead of twitchy.
      smoothed = smoothed * 0.78 + loudest * 0.22;

      if (orbRef.current) {
        const s = 1 + Math.min(smoothed * 2.2, 0.35);
        orbRef.current.style.transform = `scale(${s})`;
      }
      if (haloRef.current) {
        const hs = 1 + Math.min(smoothed * 4.0, 0.65);
        const ho = Math.min(smoothed * 3.2, 0.85);
        haloRef.current.style.transform = `scale(${hs})`;
        haloRef.current.style.opacity = String(ho);
      }

      // Icon mode: who is currently speaking?
      let desired = null;
      if (u > SILENCE_THRESHOLD && u >= a) desired = 'user';
      else if (a > SILENCE_THRESHOLD) desired = 'anna';

      const now = performance.now();
      if (desired && desired !== iconMode) {
        if (pending !== desired) { pending = desired; pendingSince = now; }
        else if (now - pendingSince > SWITCH_DEBOUNCE_MS) {
          setIconMode(desired);
          pending = null;
        }
      } else {
        pending = null;
      }

      // Occasional console breadcrumb so you can see audio is flowing during debugging.
      if (now - lastLog > 3000 && smoothed > 0.01) {
        console.log(`[orb] anna=${a.toFixed(3)} user=${u.toFixed(3)} smoothed=${smoothed.toFixed(3)} icon=${iconMode}`);
        lastLog = now;
      }

      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [annaAnalyser, userAnalyser, iconMode]);

  const badgeSize = Math.round(size * 0.42);
  const iconSize = Math.round(badgeSize * 0.72);

  return (
    <div style={{ ...driftFrame, width: size, height: size }}>
      <div ref={haloRef} style={{ ...halo, width: size * 0.95, height: size * 0.95 }} />
      <div ref={orbRef} style={{ ...orb, width: size * 0.76, height: size * 0.76 }}>
        <div style={{ ...badge, width: badgeSize, height: badgeSize }}>
          <img
            src={femaleFaceUrl}
            alt="Anna"
            style={{ ...iconImg, width: iconSize, height: iconSize, opacity: iconMode === 'anna' ? 1 : 0 }}
          />
          <img
            src={micUrl}
            alt="Participant speaking"
            style={{ ...iconImg, width: iconSize, height: iconSize, opacity: iconMode === 'user' ? 1 : 0 }}
          />
        </div>
      </div>
    </div>
  );
}

// ---- styles ----

const driftFrame = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'orbDrift 5s ease-in-out infinite',
};

const halo = {
  position: 'absolute',
  borderRadius: '50%',
  background: `radial-gradient(circle, ${theme.primary}AA 0%, ${theme.primary}00 65%)`,
  opacity: 0,
  filter: 'blur(18px)',
  transition: 'opacity 120ms linear, transform 60ms linear',
  pointerEvents: 'none',
};

const orb = {
  position: 'relative',
  borderRadius: '50%',
  background: `radial-gradient(circle at 32% 28%, ${theme.primaryPeach} 0%, #FF8A3D 35%, ${theme.primary} 68%, ${theme.primaryDeep} 100%)`,
  boxShadow: `
    inset -14px -18px 40px rgba(178, 62, 0, 0.45),
    inset 14px 18px 40px rgba(255, 212, 176, 0.35),
    0 30px 70px rgba(238, 90, 0, 0.45)
  `,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 60ms linear',
};

const badge = {
  position: 'relative',
  borderRadius: '50%',
  background: '#FFF8F3',
  boxShadow: 'inset 0 0 0 1px rgba(178, 62, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.15)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
};

const iconImg = {
  position: 'absolute',
  transition: 'opacity 260ms ease',
  userSelect: 'none',
  pointerEvents: 'none',
};
