// src/components/Joystick.tsx
// Uses raw touch events (onTouchStart/Move/End) instead of PanResponder.
// Each joystick tracks its own finger by touch identifier — enables true
// simultaneous dual-joystick input without one stealing from the other.

import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface JoystickProps {
  label: string;
  onMove: (dir: { x: number; y: number }) => void;
  onEnd: () => void;
}

const STICK_SIZE = 100;
const KNOB_SIZE  = 42;
const MAX_DIST   = (STICK_SIZE - KNOB_SIZE) / 2;

export default function Joystick({ label, onMove, onEnd }: JoystickProps) {
  const [knob, setKnob]  = useState({ x: 0, y: 0 });
  const touchId  = useRef<number | null>(null);
  const startPos = useRef({ x: 0, y: 0 });

  const handleTouchStart = (evt: any) => {
    // Only track the first touch that lands on this joystick
    if (touchId.current !== null) return;
    const touch = evt.nativeEvent.changedTouches[0];
    touchId.current = touch.identifier;
    startPos.current = { x: touch.pageX, y: touch.pageY };
  };

  const handleTouchMove = (evt: any) => {
    if (touchId.current === null) return;
    // Find our specific finger among all active touches
    const touches = evt.nativeEvent.changedTouches;
    let touch: any = null;
    for (let i = 0; i < touches.length; i++) {
      if (touches[i].identifier === touchId.current) { touch = touches[i]; break; }
    }
    if (!touch) return;

    const dx = touch.pageX - startPos.current.x;
    const dy = touch.pageY - startPos.current.y;
    const dist    = Math.sqrt(dx * dx + dy * dy);
    const clamped = Math.min(dist, MAX_DIST);
    const angle   = Math.atan2(dy, dx);
    const cx = Math.cos(angle) * clamped;
    const cy = Math.sin(angle) * clamped;
    setKnob({ x: cx, y: cy });
    onMove({ x: cx / MAX_DIST, y: cy / MAX_DIST });
  };

  const handleTouchEnd = (evt: any) => {
    if (touchId.current === null) return;
    const touches = evt.nativeEvent.changedTouches;
    for (let i = 0; i < touches.length; i++) {
      if (touches[i].identifier === touchId.current) {
        touchId.current = null;
        setKnob({ x: 0, y: 0 });
        onEnd();
        return;
      }
    }
  };

  return (
    <View
      style={S.container}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <View style={S.base}>
        <View style={[S.knob, { transform: [{ translateX: knob.x }, { translateY: knob.y }] }]} />
      </View>
      <Text style={S.label}>{label}</Text>
    </View>
  );
}

const S = StyleSheet.create({
  container: { alignItems: 'center', gap: 4 },
  base: {
    width: STICK_SIZE, height: STICK_SIZE, borderRadius: STICK_SIZE / 2,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  knob: {
    width: KNOB_SIZE, height: KNOB_SIZE, borderRadius: KNOB_SIZE / 2,
    backgroundColor: 'rgba(234,179,8,0.55)',
    borderWidth: 1.5, borderColor: 'rgba(234,179,8,0.9)',
  },
  label: { fontSize: 7, color: 'rgba(255,255,255,0.25)', letterSpacing: 2, textTransform: 'uppercase' },
});
