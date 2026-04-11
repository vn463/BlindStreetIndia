// src/components/Joystick.tsx
// True multi-touch dual joystick using raw touch events + identifier tracking.
// Each joystick claims its first touch and tracks it by identifier.
// A second finger on the other joystick gets its own independent tracking.

import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface Props {
  label: string;
  onMove: (dir: { x: number; y: number }) => void;
  onEnd: () => void;
}

const STICK_SIZE = 100;
const KNOB_SIZE  = 42;
const MAX_DIST   = (STICK_SIZE - KNOB_SIZE) / 2;

export default function Joystick({ label, onMove, onEnd }: Props) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const activeId  = useRef<number | null>(null);
  const origin    = useRef({ x: 0, y: 0 });

  return (
    <View
      style={S.wrap}
      // Claim responder on touch down
      onStartShouldSetResponder={() => activeId.current === null}
      onMoveShouldSetResponder={() => activeId.current !== null}
      onResponderGrant={(e) => {
        const t = e.nativeEvent;
        activeId.current = t.identifier;
        origin.current   = { x: t.pageX, y: t.pageY };
      }}
      onResponderMove={(e) => {
        if (activeId.current === null) return;
        // Find our specific touch among all active touches
        const touches = e.nativeEvent.touches;
        let tx = 0, ty = 0, found = false;
        for (let i = 0; i < touches.length; i++) {
          if (touches[i].identifier === activeId.current) {
            tx = touches[i].pageX; ty = touches[i].pageY; found = true; break;
          }
        }
        if (!found) return;
        const dx = tx - origin.current.x;
        const dy = ty - origin.current.y;
        const dist    = Math.sqrt(dx * dx + dy * dy);
        const clamped = Math.min(dist, MAX_DIST);
        const angle   = Math.atan2(dy, dx);
        const cx      = Math.cos(angle) * clamped;
        const cy      = Math.sin(angle) * clamped;
        setKnob({ x: cx, y: cy });
        onMove({ x: cx / MAX_DIST, y: cy / MAX_DIST });
      }}
      onResponderRelease={() => {
        activeId.current = null;
        setKnob({ x: 0, y: 0 });
        onEnd();
      }}
      onResponderTerminate={() => {
        activeId.current = null;
        setKnob({ x: 0, y: 0 });
        onEnd();
      }}
      // Allow sibling responders — critical for dual joystick
      onStartShouldSetResponderCapture={() => false}
      onMoveShouldSetResponderCapture={() => false}
    >
      <View style={S.base}>
        <View style={[S.knob, { transform: [{ translateX: knob.x }, { translateY: knob.y }] }]} />
      </View>
      <Text style={S.label}>{label}</Text>
    </View>
  );
}

const S = StyleSheet.create({
  wrap:  { alignItems: 'center', gap: 4 },
  base:  {
    width: STICK_SIZE, height: STICK_SIZE, borderRadius: STICK_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  knob:  {
    width: KNOB_SIZE, height: KNOB_SIZE, borderRadius: KNOB_SIZE / 2,
    backgroundColor: 'rgba(234,179,8,0.6)',
    borderWidth: 1.5, borderColor: 'rgba(234,179,8,0.95)',
  },
  label: { fontSize: 7, color: 'rgba(255,255,255,0.3)', letterSpacing: 2, textTransform: 'uppercase' },
});
